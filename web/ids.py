"""The ids of books and pages, shared by the server modules.

Books on this computer (the original disc, made by web/tools) have ids like BO-ff57d1a56e6bf
with pages PA-74f1d4f6f1dd3; books in the library (added in the app) have ids like
La3f9c2b1d0 with pages p1, p2, ...
"""
import re

BOOK = r'(?:BO-[0-9a-f]+|L[0-9a-f]{10})'
PAGE = r'(?:PA-[0-9a-f]+|p[0-9]{1,4})'
BOOK_RE = re.compile(f'^{BOOK}$')
PAGE_RE = re.compile(f'^{PAGE}$')
LIBRARY_BOOK_RE = re.compile(r'^L[0-9a-f]{10}$')
# The timed script of a recording or video on the disc (web/data/scripts/<id>.json): translated like a page.
SCRIPT_RE = re.compile(r'^(?:AU|VI)-[0-9a-f]+$')
