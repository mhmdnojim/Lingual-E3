"""Migration integration tests, isolated from the reader's books and settings.

Run: python -m unittest discover -s web/tests -p test_migration.py -v
OCR is replaced with predictable page text; ZIP parsing, page rendering, stitching,
segmentation, SQLite library creation, checkpoints and exports use the real code.
"""
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
import zipfile

from PIL import Image

WEB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEB))
import db
import library
import migration


def png(color="white", size=(124, 156)):
    output = io.BytesIO()
    Image.new("RGB", size, color).save(output, "PNG")
    return output.getvalue()


def archive(entries):
    """Build a ZIP without ever placing its untrusted names on the filesystem."""
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as zipped:
        for name, content in entries:
            zipped.writestr(name, content)
    return output.getvalue()


def simple_pdf():
    """A valid one-page PDF with embedded English text; needs no PDF authoring tool."""
    contents = b"BT /F1 18 Tf 40 130 Td (This is a migration sample page.) Tj ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 280 190] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(contents)).encode() + b" >>\nstream\n" + contents + b"\nendstream",
    ]
    output = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for number, item in enumerate(objects, 1):
        offsets.append(len(output))
        output.extend(f"{number} 0 obj\n".encode() + item + b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode())
    output.extend(f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return bytes(output)


def itools_entries(pages=2):
    """TMS row zero is at the bottom: each page has four differently colored tiles."""
    book = {"slug": "BO-test", "title": "Fixture English", "type": "Student Book",
            "pages": {str(n): {"id": n, "page_path": f"page-{n}"} for n in range(1, pages + 1)}}
    entries = [("Original/.shared/content/index.json", json.dumps({"books": {"123": book}}))]
    for page in range(1, pages + 1):
        base = f"Original/.shared/books/BO-test/pages/page-{page}"
        for col, row, color in ((0, 1, "red"), (1, 1, "green"), (0, 0, "blue"), (1, 0, "yellow")):
            entries.append((f"{base}/1/{col}/{row}.png", png(color)))
        entries.append((f"{base}/index.json", '{"page_assets": []}'))
    entries.extend([
        ("Original/launch.py", "raise RuntimeError('Uploaded scripts must never run')"),
        ("Original/launcher.exe", b"MZ not an executable"),
        ("Original/index.html", "<script>throw new Error('Uploaded HTML must never run')</script>"),
    ])
    return entries


def fake_ocr(images, build, options, progress):
    docs = []
    for image in images:
        docs.append({"w": image.width, "h": image.height, "lines": [{"words": [
            {"t": word, "x": 5 + i * 32, "y": 30, "w": 28, "h": 15}
            for i, word in enumerate(("This", "is", "page", "text."))]}]})
    return docs


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="lingua-migration-test-")
        self.old_conn = db._conn
        db._conn = None
        self.patches = [mock.patch.object(db, "DATA", self.tmp.name),
                        mock.patch.object(library, "BOOKS", str(Path(self.tmp.name) / "books")),
                        mock.patch.object(library, "_ocr", side_effect=fake_ocr)]
        for patch in self.patches:
            patch.start()
        self.owner = {"id": 11, "name": "Migration owner", "admin": False}
        self.other = {"id": 12, "name": "Other reader", "admin": False}
        for user in (self.owner, self.other):
            db.run("INSERT INTO users (id,email,name,created) VALUES (?,?,?,?)",
                   (user["id"], f'{user["id"]}@test.invalid', user["name"], 1))

    def tearDown(self):
        # A failed assertion must not leave a worker using the next test's database.
        for worker in list(getattr(migration, "_tasks", {}).values()):
            if hasattr(worker, "join"):
                worker.join(timeout=15)
        if db._conn is not None:
            db._conn.close()
        db._conn = self.old_conn
        for patch in reversed(self.patches):
            patch.stop()
        self.tmp.cleanup()

    def wait_for(self, mid, *states):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            job = migration.snapshot(mid, self.owner)
            if job["state"] in states:
                return job
            if job["state"] == "error":
                self.fail(f"Migration failed: {job.get('error')} ({job})")
            time.sleep(0.02)
        self.fail(f"Migration did not reach {states}: {job}")

    def upload_zip(self, entries, title="Migration fixture"):
        data = archive(entries)
        job = migration.create(self.owner, {"title": title, "input": "zip",
                                             "expectedFiles": 1, "expectedBytes": len(data)})
        migration.save_upload(job["id"], self.owner, "old-app.zip", data)
        return job["id"]

    def planned(self, entries):
        mid = self.upload_zip(entries)
        migration.analyze(mid, self.owner)
        return mid, self.wait_for(mid, "planned")

    def reviewed(self, entries):
        mid, job = self.planned(entries)
        self.assertTrue(job["candidates"], "Supported input should produce a conversion plan")
        selected = [candidate["id"] for candidate in job["candidates"]]
        migration.make_sample(mid, self.owner, {"selected": selected, "options": {"language": "en"}})
        return mid, self.wait_for(mid, "review")

    def approved(self, mid, job):
        return {"approved": True, "sampleToken": job["sample"]["token"]}

    def test_itools_review_conversion_preserves_page_geometry_and_exports_only_content(self):
        mid, job = self.reviewed(itools_entries())
        self.assertGreaterEqual(len(job["sample"]["pages"]), 1)
        self.assertLessEqual(len(job["sample"]["pages"]), 5)
        self.assertFalse(library.list_books(self.owner, "mine"), "Sample review must precede library creation")
        self.assertTrue(all(page["words"] > 0 for page in job["sample"]["pages"]))
        migration.convert(mid, self.owner, self.approved(mid, job))
        job = self.wait_for(mid, "ready")
        self.assertEqual(1, len(job["results"]))
        book = library.get(job["results"][0]["id"])
        self.assertEqual("ready", book["status"])
        self.assertEqual("private", book["visibility"])
        pages = library.full(book, self.owner)["pages"]
        self.assertEqual(2, len(pages))
        self.assertTrue(all(page["txt"] for page in pages))
        with Image.open(library.file_path(book["id"], "pages", "1.webp")) as image:
            width, height = image.size
            samples = [image.convert("RGB").getpixel(point) for point in
                       ((width // 4, height // 4), (3 * width // 4, height // 4),
                        (width // 4, 3 * height // 4), (3 * width // 4, 3 * height // 4))]
        red, green, blue, yellow = samples
        self.assertGreater(red[0], max(red[1:]) + 100)
        self.assertGreater(green[1], max(green[0], green[2]) + 70)
        self.assertGreater(blue[2], max(blue[:2]) + 100)
        self.assertGreater(min(yellow[:2]), yellow[2] + 100)
        self.assertIn("This is page text.", library.search_index(book)[0]["t"])
        export_path = migration.artifact(mid, self.owner, "export")
        with zipfile.ZipFile(export_path) as exported:
            names = exported.namelist()
            self.assertTrue(any(name.endswith(".webp") for name in names))
            self.assertTrue(any(name.endswith(".json") for name in names))
            self.assertFalse(any(name.endswith((".exe", ".py", ".html")) for name in names), names)
            self.assertFalse(any(".shared" in name for name in names), names)
        self.assertTrue(Path(migration.artifact(mid, self.owner, "report")).is_file())

    def test_generic_pdf_and_images_become_readable_library_books(self):
        mid, job = self.reviewed([("lesson.pdf", simple_pdf()), ("photos/page1.png", png(size=(300, 400)))])
        migration.convert(mid, self.owner, self.approved(mid, job))
        job = self.wait_for(mid, "ready")
        self.assertEqual(2, len(job["results"]))
        text = " ".join(page["t"] for result in job["results"]
                        for page in library.search_index(library.get(result["id"])))
        self.assertIn("This is a migration sample page.", text)
        self.assertIn("This is page text.", text)

    def test_itools_preserves_audio_transcript_and_remaps_page_links(self):
        entries = dict(itools_entries())
        entries['Original/.shared/books/BO-test/pages/page-1/index.json'] = json.dumps({'page_assets': [
            {'type': 'audio', 'lon': 992, 'lat': 1248, 'title': 'Listen',
             'link': 'resource://audio/lesson.mp3', 'script': 'resource://audio/script.xml'},
            {'type': 'page-link', 'lon': 0, 'lat': 2496, 'link': [2, 123]},
            {'type': 'swf', 'lon': 10, 'lat': 10, 'link': 'resource://answer.swf'},
        ]})
        entries['Original/.shared/assets/audio/lesson.mp3'] = b'ID3 fixture media'
        entries['Original/.shared/assets/audio/script.xml'] = '<Cues><Cue value="0"><![CDATA[Hello there.]]></Cue></Cues>'
        mid, job = self.reviewed(list(entries.items()))
        migration.convert(mid, self.owner, self.approved(mid, job))
        result = self.wait_for(mid, 'ready')
        bid = result['results'][0]['id']
        book = library.full(library.get(bid), self.owner)
        audio, link = book['pages'][0]['a']
        self.assertEqual([124, 156], [audio['x'], audio['y']])
        self.assertTrue(audio['src'].startswith(f'/lib/{bid}/migration-media/'))
        self.assertEqual([{'t': 0, 'x': 'Hello there.'}], migration._json(library.folder(bid, 'migration-media', audio['script'].split('/')[-1])))
        self.assertEqual([bid, '2'], [link['book'], link['page']])
        self.assertTrue(any('unsupported or missing hotspots' in warning for warning in result['warnings']))
        with zipfile.ZipFile(migration.artifact(mid, self.owner, 'export')) as exported:
            self.assertEqual('ready', json.loads(exported.read('migration-report.json'))['state'])

    def test_report_available_for_unsupported_source_and_private_to_owner(self):
        mid, job = self.planned([('app.exe', b'MZ inert')])
        report = migration._json(migration.artifact(mid, self.owner, 'report'))
        self.assertEqual(1, report['inventory']['files'])
        self.assertEqual([], report['results'])
        with self.assertRaises(migration.MigrationError):
            migration.artifact(mid, None, 'report')

    def test_discard_releases_source_storage_but_keeps_completed_books(self):
        mid, job = self.reviewed([('lesson.pdf', simple_pdf())])
        migration.convert(mid, self.owner, self.approved(mid, job))
        result = self.wait_for(mid, 'ready')
        bid = result['results'][0]['id']
        for worker in list(migration._tasks.values()):
            worker.join(10)
        with self.assertRaises(migration.MigrationError):
            migration.discard(mid, self.other)
        migration.discard(mid, self.owner)
        self.assertFalse(Path(migration._root(mid)).exists())
        self.assertEqual('ready', library.get(bid)['status'])
        self.assertTrue(Path(library.folder(bid, 'pages', '1.webp')).is_file())

    def test_empty_folder_files_are_allowed_but_empty_zip_is_not(self):
        job = migration.create(self.owner, {'input': 'folder'})
        uploaded = migration.save_upload(job['id'], self.owner, 'app/empty.marker', b'')
        self.assertEqual(1, uploaded['upload']['files'])
        self.assertEqual(0, uploaded['upload']['bytes'])
        zipped = migration.create(self.owner, {'input': 'zip'})
        with self.assertRaises(migration.MigrationError):
            migration.save_upload(zipped['id'], self.owner, 'app.zip', b'')

    def test_retry_repairs_corrupt_checkpoint_and_does_not_double_charge_storage(self):
        mid, job = self.reviewed(itools_entries(pages=1))
        with mock.patch.object(migration, '_export', side_effect=RuntimeError('Package interrupted')):
            migration.convert(mid, self.owner, self.approved(mid, job))
            self.wait_for(mid, 'error')
        bid = migration._load(mid)['_books'][job['selected'][0]]
        Path(library.folder(bid, 'pages', '1.webp')).write_bytes(b'damaged')
        with mock.patch.object(migration, '_render_page', wraps=migration._render_page) as render:
            migration.convert(mid, self.owner, self.approved(mid, job))
            finished = self.wait_for(mid, 'ready')
            self.assertEqual(1, render.call_count)
        self.assertEqual(bid, finished['results'][0]['id'])

    def test_another_user_cannot_read_change_or_export_a_job(self):
        mid = self.upload_zip([("page.png", png())])
        self.assertIn(mid, [job["id"] for job in migration.list_jobs(self.owner)])
        self.assertNotIn(mid, [job["id"] for job in migration.list_jobs(self.other)])
        for action in (
            lambda: migration.snapshot(mid, self.other),
            lambda: migration.save_upload(mid, self.other, "other.zip", b"wrong"),
            lambda: migration.analyze(mid, self.other),
            lambda: migration.make_sample(mid, self.other, {}),
            lambda: migration.convert(mid, self.other, {"approved": True}),
            lambda: migration.cancel(mid, self.other),
            lambda: migration.artifact(mid, self.other, "report"),
        ):
            with self.subTest(action=action), self.assertRaises(migration.MigrationError):
                action()

    def test_zip_rejects_traversal_absolute_paths_and_case_collisions(self):
        invalid_archives = [
            [("../escape.png", png())], [("/escape.png", png())], [("C:/escape.png", png())],
            [("folder/../../escape.png", png())], [("folder\\..\\escape.png", png())],
            [("Page.png", png()), ("page.PNG", png())], [("NUL.png", png())],
        ]
        for entries in invalid_archives:
            with self.subTest(names=[name for name, _ in entries]):
                mid = self.upload_zip(entries)
                migration.analyze(mid, self.owner)
                job = self.wait_for(mid, "error")
                self.assertTrue(job.get("error"))
        self.assertFalse((Path(self.tmp.name) / "escape.png").exists())
        self.assertFalse(library.list_books(self.owner, "mine"))

    def test_zip_rejects_symlink(self):
        entry = zipfile.ZipInfo("linked.png")
        entry.create_system = 3
        entry.external_attr = (stat.S_IFLNK | 0o777) << 16
        mid = self.upload_zip([(entry, "../private.png")])
        migration.analyze(mid, self.owner)
        self.assertTrue(self.wait_for(mid, "error").get("error"))

    def test_folder_upload_rejects_unsafe_names(self):
        job = migration.create(self.owner, {"title": "Folder", "input": "folder"})
        for name in ("../escape", "/absolute", "C:\\Windows\\file", "folder/../escape", "CON", "name:stream"):
            with self.subTest(name=name), self.assertRaises(migration.MigrationError):
                migration.save_upload(job["id"], self.owner, name, b"not written")

    def test_archive_file_count_and_expanded_size_limits(self):
        cases = [("files", 1, [("one.txt", "one"), ("two.txt", "two")]),
                 ("bytes", 100, [("large.txt", "0123456789" * 100)]),
                 ("ratio", 2, [("compressed.txt", "a" * 50000)])]
        for limit, ceiling, entries in cases:
            with self.subTest(limit=limit):
                mid = self.upload_zip(entries)
                with mock.patch.dict(migration.LIMITS, {limit: ceiling}):
                    migration.analyze(mid, self.owner)
                    self.assertTrue(self.wait_for(mid, "error").get("error"))

    def test_review_is_required_and_old_sample_cannot_approve_new_options(self):
        mid, job = self.planned([("page.png", png())])
        with self.assertRaises(migration.MigrationError):
            migration.convert(mid, self.owner, {"approved": True})
        request = {"selected": [candidate["id"] for candidate in job["candidates"]],
                   "options": {"language": "en"}}
        migration.make_sample(mid, self.owner, request)
        first = self.wait_for(mid, "review")
        request["options"]["margins"] = True
        migration.make_sample(mid, self.owner, request)
        second = self.wait_for(mid, "review")
        self.assertNotEqual(first["sample"]["token"], second["sample"]["token"])
        with self.assertRaises(migration.MigrationError):
            migration.convert(mid, self.owner, self.approved(mid, first))
        with self.assertRaises(migration.MigrationError):
            migration.convert(mid, self.owner, {"approved": False, "sampleToken": second["sample"]["token"]})

    def test_source_only_app_has_findings_and_cannot_report_conversion_success(self):
        marker = Path(self.tmp.name) / "uploaded-script-executed.txt"
        script = f"from pathlib import Path\nPath({str(marker)!r}).write_text('executed')"
        mid, job = self.planned([("main.py", script),
                                 ("app.exe", b"MZ unsupported application"),
                                 ("index.html", "<script>alert('never execute')</script>")])
        self.assertFalse(job["candidates"])
        self.assertTrue(job.get("warnings"))
        self.assertNotEqual("ready", job["state"])
        with self.assertRaises(migration.MigrationError):
            migration.make_sample(mid, self.owner, {"selected": []})
        self.assertFalse(marker.exists(), "Uploaded program text must remain inert")
        self.assertFalse(library.list_books(self.owner, "mine"))

    def test_interrupted_conversion_resumes_completed_pages_without_duplicate_books(self):
        mid, job = self.reviewed(itools_entries(pages=2))
        real_render = migration._render_page
        attempts = []

        def fail_second_page(job_id, candidate, page, options):
            attempts.append(json.dumps(page, sort_keys=True))
            if len(attempts) == 2:
                raise RuntimeError("A simulated restart interrupted the second page")
            return real_render(job_id, candidate, page, options)

        with mock.patch.object(migration, "_render_page", side_effect=fail_second_page):
            migration.convert(mid, self.owner, self.approved(mid, job))
            failed = self.wait_for(mid, "error")
            self.assertIn("simulated restart", failed.get("error", ""))
            before = db.rows("SELECT id FROM books WHERE owner = ?", (self.owner["id"],))
            self.assertEqual(1, len(before))
            migration.convert(mid, self.owner, self.approved(mid, job))
            finished = self.wait_for(mid, "ready")
        self.assertEqual(3, len(attempts), "Resume should reuse page one's checkpoint")
        self.assertNotEqual(attempts[0], attempts[1])
        self.assertEqual(attempts[1], attempts[2])
        self.assertEqual(before[0]["id"], finished["results"][0]["id"])
        self.assertEqual(1, len(library.list_books(self.owner, "mine")))
        book = library.get(finished["results"][0]["id"])
        self.assertEqual(2, len(library.full(book, self.owner)["pages"]))

    def test_folder_upload_retry_does_not_duplicate_files(self):
        data = png()
        job = migration.create(self.owner, {"title": "Folder retry", "input": "folder",
                                             "expectedFiles": 1, "expectedBytes": len(data)})
        mid = job["id"]
        migration.save_upload(mid, self.owner, "pages/one.png", data)
        migration.save_upload(mid, self.owner, "pages/one.png", data)
        migration.analyze(mid, self.owner)
        planned = self.wait_for(mid, "planned")
        self.assertEqual(1, len(planned["candidates"]))

    def test_a_busy_job_file_does_not_stop_the_upload(self):
        """Windows' virus scanner opens a file just written, for a moment, and an open file cannot be
        replaced: the upload waits and goes on (it used to stop, with a broken connection). The
        counts come from the ledger; job.json is brought up to date before the app is inspected."""
        data = png()
        job = migration.create(self.owner, {"title": "Busy", "input": "folder",
                                             "expectedFiles": 3, "expectedBytes": 3 * len(data)})
        mid = job["id"]
        migration.save_upload(mid, self.owner, "pages/a.png", data)
        held = threading.Event()

        def hold():
            with open(migration._root(mid, "job.json"), encoding="utf-8"):
                held.set()
                time.sleep(0.4)

        holder = threading.Thread(target=hold)
        holder.start()
        held.wait()
        migration._saved_at.pop(mid, None)  # (saved now, not at most once a second)
        out = migration.save_upload(mid, self.owner, "pages/b.png", data)
        holder.join()
        self.assertEqual(2, out["upload"]["files"])
        migration.save_upload(mid, self.owner, "pages/c.png", data)
        self.assertEqual({"pages/a.png": len(data), "pages/b.png": len(data), "pages/c.png": len(data)},
                         migration.uploaded(mid, self.owner)["files"])
        migration.analyze(mid, self.owner)
        planned = self.wait_for(mid, "planned")
        self.assertEqual(3, planned["upload"]["files"])


if __name__ == "__main__":
    unittest.main()
