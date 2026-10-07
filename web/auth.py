"""Password login, needed whenever the app can be reached from other devices (phones on the
home Wi-Fi, or a web host). On this computer alone (127.0.0.1, the default) there is none.

The password comes from the environment variable AEF_PASSWORD, or --password, or (for
--lan, the home Wi-Fi mode) a PIN made on first use and kept in web/server-config.json.

After logging in the browser keeps a cookie "aef_session" for 30 days: the time it ends,
signed with a key made from the password (HMAC-SHA256). Nothing is stored on the server, so
the login survives restarts, and changing the password logs everybody out.
"""
import hashlib
import hmac
import json
import os
import secrets
import threading
import time

COOKIE = 'aef_session'
DAYS = 30
CONFIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'server-config.json')

_lock = threading.Lock()
_failures = {}  # address -> times of wrong passwords in the last 15 minutes


def lan_pin():
    """The PIN for the home Wi-Fi mode: made once (6 digits), then kept in server-config.json."""
    try:
        with open(CONFIG, encoding='utf-8') as f:
            pin = json.load(f).get('password')
        if pin:
            return pin
    except (FileNotFoundError, ValueError):
        pass
    pin = f'{secrets.randbelow(10 ** 6):06d}'
    with open(CONFIG, 'w', encoding='utf-8') as f:
        json.dump({'password': pin}, f)
    return pin


class Auth:
    def __init__(self, password=None):
        self.password = password or None
        self.key = hashlib.sha256(f'aef3-session:{password}'.encode('utf-8')).digest() if password else b''

    @property
    def on(self):
        return self.password is not None

    def _sign(self, text):
        return hmac.new(self.key, text.encode('ascii'), hashlib.sha256).hexdigest()

    def new_session(self):
        until = str(int(time.time()) + DAYS * 86400)
        return f'{until}.{self._sign(until)}'

    def valid(self, token):
        if not token or '.' not in token:
            return False
        until, sig = token.split('.', 1)
        return until.isdigit() and int(until) > time.time() and hmac.compare_digest(sig, self._sign(until))

    def check_password(self, address, given):
        """True if right. Too many wrong tries from one address: refused for a while (None)."""
        now = time.time()
        with _lock:
            tries = [t for t in _failures.get(address, []) if now - t < 900]
            _failures[address] = tries
            if len(tries) >= 8:
                return None
        if hmac.compare_digest(str(given).encode('utf-8'), self.password.encode('utf-8')):
            with _lock:
                _failures.pop(address, None)
            return True
        time.sleep(1)  # slows down guessing
        with _lock:
            _failures.setdefault(address, []).append(now)
        return False

    def cookie(self, token, secure, max_age=DAYS * 86400):
        return (f'{COOKIE}={token}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Lax'
                + ('; Secure' if secure else ''))
