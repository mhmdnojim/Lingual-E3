"""The PIN for phones and tablets on the home Wi-Fi (server.py --lan).

Made once (6 digits) and kept in web/server-config.json (delete that file for a new one). After
the PIN, the browser keeps the same login cookie as accounts on a website (accounts.py), for the
owner of this computer. On this computer itself no PIN is asked.
"""
import json
import os
import secrets

CONFIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'server-config.json')


def lan_pin():
    try:
        with open(CONFIG, encoding='utf-8') as f:
            pin = json.load(f).get('password')
        if pin:
            return str(pin)
    except (FileNotFoundError, ValueError):
        pass
    pin = f'{secrets.randbelow(10 ** 6):06d}'
    with open(CONFIG, 'w', encoding='utf-8') as f:
        json.dump({'password': pin}, f)
    return pin
