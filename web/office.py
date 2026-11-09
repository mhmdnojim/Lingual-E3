"""Word files (.docx, .doc, .rtf, .odt) made into a PDF, so that a book can be added from one
("Add a book → Word"): its pictures, tables and the look of its pages are kept, and then it is read
as any PDF is (library.py).

Two ways, the first that is there:
- Microsoft Word, on Windows (this computer), through PowerShell; the file's macros never run;
- LibreOffice, without its windows (on a Linux web host: apt install libreoffice-writer-nogui
  fonts-noto-cjk — deploy/setup-server.sh does it), also on Windows when Word is not there.
One file at a time (both are big programs), at most 5 minutes each.
"""
import base64
import io
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import zipfile

EXTS = ('.docx', '.doc', '.rtf', '.odt')
IS_WINDOWS = os.name == 'nt'
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
TIMEOUT = 300
_lock = threading.Lock()

# The words of Word's errors that say the file has a password.
PASSWORD_WORDS = ('password', 'Password', 'encrypted')

WORD_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$word = $null; $doc = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0          # no questions on the screen
  $word.AutomationSecurity = 3     # the file's macros never run
  # (read only; a password that is never right: a file with a password stops at once, without asking)
  $doc = $word.Documents.Open($env:LB_OFFICE_IN, $false, $true, $false, 'x-no-password', 'x-no-password')
  $doc.ExportAsFixedFormat($env:LB_OFFICE_OUT, 17)   # 17: PDF
  'ok'
} catch {
  'error: ' + $_.Exception.Message
} finally {
  if ($doc) { try { $doc.Close(0) } catch {} }
  # (Quit() without "do not save": Quit(0) is refused from PowerShell, and Word would stay open)
  if ($word) { try { $word.Quit() } catch {}; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word) }
}
"""

# A Word that did not finish in time (it may wait for something nobody sees) is stopped: only a
# Word started for the app (by PowerShell: "/Automation") since then, never one the person uses.
STOP_WORD_SCRIPT = r"""
$since = [datetime]::Parse($env:LB_OFFICE_SINCE)
Get-CimInstance Win32_Process -Filter "Name='WINWORD.EXE'" |
  Where-Object { $_.CommandLine -match '/Automation|-Embedding' -and $_.CreationDate -ge $since } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
"""


class OfficeError(Exception):
    pass


def kind_of(data):
    """The kind of Word file these bytes are ('.docx', '.doc', '.rtf', '.odt'), or None."""
    if data[:4] == b'PK\x03\x04':  # (a .docx and an .odt are zip files)
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                names = set(z.namelist())
                if 'word/document.xml' in names:
                    return '.docx'
                if 'mimetype' in names and z.read('mimetype').strip() == b'application/vnd.oasis.opendocument.text':
                    return '.odt'
        except (zipfile.BadZipFile, KeyError, ValueError, OSError):
            return None
        return None
    if data[:8] == b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1':  # (an old .doc)
        return '.doc'
    if data[:5] == b'{\\rtf':
        return '.rtf'
    return None


def _powershell():
    return os.path.join(os.environ.get('SystemRoot', r'C:\Windows'), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')


def _has_word():
    if not IS_WINDOWS:
        return False
    import winreg
    try:
        winreg.CloseKey(winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, r'Word.Application\CLSID'))
        return True
    except OSError:
        return False


def _soffice():
    found = shutil.which('soffice') or shutil.which('libreoffice')
    if found:
        return found
    if IS_WINDOWS:
        for base in (os.environ.get('ProgramFiles'), os.environ.get('ProgramFiles(x86)')):
            path = os.path.join(base or '', 'LibreOffice', 'program', 'soffice.exe')
            if base and os.path.isfile(path):
                return path
    return None


def engine():
    """'word', 'libreoffice', or None (Word files cannot be added here)."""
    return 'word' if _has_word() else 'libreoffice' if _soffice() else None


def available():
    return engine() is not None


def missing_message():
    if IS_WINDOWS:
        return ('Word files can be added when Microsoft Word or LibreOffice is installed on this computer. '
                'Or save the file as a PDF in Word (File → Save As → PDF) and add the PDF.')
    return ('This website cannot open Word files yet. Save the file as a PDF in Word '
            '(File → Save As → PDF) and add the PDF.')


def to_pdf(src, out):
    """Make the Word file src into the PDF out (replaced). OfficeError: what went wrong, to show."""
    how = engine()
    if not how:
        raise OfficeError(missing_message())
    with _lock:
        if os.path.exists(out):
            os.remove(out)
        work = tempfile.mkdtemp(prefix='lingua-office-')
        try:
            # (plain names in a folder of its own: no spaces, quotes or other letters for the programs)
            name = 'book' + os.path.splitext(src)[1].lower()
            shutil.copyfile(src, os.path.join(work, name))
            made = (_by_word if how == 'word' else _by_libreoffice)(os.path.join(work, name), work)
            with open(made, 'rb') as f:
                if f.read(4) != b'%PDF':
                    raise OfficeError('The Word file could not be made into a PDF.')
            shutil.move(made, out)
        finally:
            shutil.rmtree(work, ignore_errors=True)


def _by_word(src, work):
    out = os.path.join(work, 'made.pdf')
    env = {**os.environ, 'LB_OFFICE_IN': src, 'LB_OFFICE_OUT': out}
    script = base64.b64encode(WORD_SCRIPT.encode('utf-16-le')).decode('ascii')
    since = time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(time.time() - 2))
    try:
        r = subprocess.run([_powershell(), '-NoProfile', '-NonInteractive', '-EncodedCommand', script],
                           capture_output=True, timeout=TIMEOUT, env=env, creationflags=NO_WINDOW)
    except subprocess.TimeoutExpired:
        subprocess.run([_powershell(), '-NoProfile', '-NonInteractive', '-EncodedCommand',
                        base64.b64encode(STOP_WORD_SCRIPT.encode('utf-16-le')).decode('ascii')],
                       capture_output=True, timeout=60, env={**os.environ, 'LB_OFFICE_SINCE': since}, creationflags=NO_WINDOW)
        raise OfficeError(f'Word took more than {TIMEOUT // 60} minutes to open this file. Save it as a PDF in Word and add the PDF.')
    except OSError:
        raise OfficeError(missing_message())
    said = r.stdout.decode('utf-8', 'replace').strip().splitlines()
    said = said[-1] if said else ''
    if said == 'ok' and os.path.isfile(out):
        return out
    if any(w in said for w in PASSWORD_WORDS):
        raise OfficeError('The Word file is protected with a password. Open it in Word, take the password away '
                          '(File → Info → Protect Document), save it, and add it again.')
    raise OfficeError('Word could not open this file (it may be damaged, or not a Word document).'
                      + (f' Word said: {said[7:].strip()[:300]}' if said.startswith('error:') else ''))


def _by_libreoffice(src, work):
    # (its own settings folder: a LibreOffice the person has open does not take the work instead)
    profile = Path(tempfile.gettempdir(), 'lingua-books-office-profile').as_uri()
    cmd = [_soffice(), f'-env:UserInstallation={profile}', '--headless', '--norestore', '--nolockcheck',
           '--convert-to', 'pdf', '--outdir', work, src]
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=NO_WINDOW,
                                start_new_session=not IS_WINDOWS)
    except OSError:
        raise OfficeError(missing_message())
    try:
        _, err = proc.communicate(timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        if IS_WINDOWS:
            proc.kill()
        else:  # (soffice is a script that starts soffice.bin: all of them)
            os.killpg(proc.pid, signal.SIGKILL)
        proc.communicate()
        raise OfficeError(f'LibreOffice took more than {TIMEOUT // 60} minutes to open this file. '
                          'Save it as a PDF in Word and add the PDF.')
    made = os.path.join(work, os.path.splitext(os.path.basename(src))[0] + '.pdf')
    if not os.path.isfile(made):
        said = err.decode('utf-8', 'replace').strip()
        if any(w in said for w in PASSWORD_WORDS):
            raise OfficeError('The Word file is protected with a password. Open it in Word, take the password away '
                              '(File → Info → Protect Document), save it, and add it again.')
        raise OfficeError('LibreOffice could not open this file (it may be damaged, or not a Word document).')
    return made
