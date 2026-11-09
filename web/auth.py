"""The PIN for phones and tablets on the home Wi-Fi (server.py --lan).

Made once (6 digits) and kept in web/server-config.json (take it out of that file for a new one). After
the PIN, the browser keeps the same login cookie as accounts on a website (accounts.py), for the
owner of this computer. On this computer itself no PIN is asked.
"""
import json
import os
import secrets

CONFIG = os.environ.get('AEF_CONFIG_FILE') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'server-config.json')  # (tests: their own)


def config():
    """The server's own settings (web/server-config.json: never served): the PIN, the AI image service's key …"""
    try:
        with open(CONFIG, encoding='utf-8') as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (FileNotFoundError, ValueError):
        return {}


def set_config(**changes):
    """Change some of the server's settings, keeping the others (None: taken out)."""
    d = config()
    d.update(changes)
    d = {k: v for k, v in d.items() if v is not None}
    tmp = CONFIG + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(d, f)
    os.replace(tmp, CONFIG)


def lan_pin():
    pin = config().get('password')
    if pin:
        return str(pin)
    pin = f'{secrets.randbelow(10 ** 6):06d}'
    set_config(password=pin)
    return pin
