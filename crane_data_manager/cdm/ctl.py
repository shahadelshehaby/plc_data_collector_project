"""
ctl.py - the platform's client for the collector service control API
(127.0.0.1 only, shared key in data/control.key).
"""
import json
import urllib.error
import urllib.request

from . import config as C


class CollectorDown(Exception):
    pass


def _url(path):
    return f"http://127.0.0.1:{C.load_settings()['control_port']}{path}"


def call(path, body=None, timeout=3):
    req = urllib.request.Request(_url(path), method="POST" if body is not None else "GET",
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"X-Key": C.control_key(),
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or b"{}")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise CollectorDown(str(exc)) from exc


def status():
    return call("/status")


def ping():
    return call("/ping", timeout=2)


def reload(reason):
    return call("/reload", {"reason": reason}, timeout=10)


def history(crane):
    return call(f"/history?crane={crane}")


def raw(crane, which="registered"):
    return call(f"/raw?crane={crane}&which={which}")
