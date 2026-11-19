"""
config.py
=========
Paths and general settings. Settings live in settings.json next to app.py
(created with the defaults below on first start). Edit them from the
platform (Configuration > InfluxDB / System) or in the file.
"""
import json
import os
import secrets
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
LOG_DIR = BASE_DIR / "logs"
EXPORT_DIR = DATA_DIR / "exports"
BACKUP_DIR = DATA_DIR / "config_backups"
SETTINGS_FILE = BASE_DIR / "settings.json"
TOKEN_FILE = BASE_DIR / "influx_token.txt"
CONTROL_KEY_FILE = DATA_DIR / "control.key"
DB_FILE = DATA_DIR / "manager.db"
BUFFER_FILE = DATA_DIR / "buffer.db"

# Dubai has no daylight saving: a fixed +4 h offset is exact and needs no tzdata.
LOCAL_TZ = timezone(timedelta(hours=4), "GST")

DEFAULTS = {
    "influx_url": "http://192.168.100.218:8089/",
    "influx_org": "dpw",
    "influx_bucket": "Crane_Telemetry",
    "influx_measurement": "crane_telemetry",
    "influx_timeout_ms": 5000,
    "platform_host": "127.0.0.1",        # collector PC only
    "platform_port": 5300,
    "control_port": 5301,                # collector service <-> platform (localhost only)
    "listen_address": "0.0.0.0",
    "westermo_ip": "192.168.100.1",      # shown on the Live Map (Westermo panel)
    "collector_ip": "192.168.100.237",   # the collector PC the Westermo forwards to
    "udp_buffer_size": 2048,
    "no_data_after_sec": 10,             # no packet for this long -> Idle / no data
    "alarm_clear_after_sec": 120,        # condition gone this long -> alarm cleared
    "write_batch_max": 500,
    "write_interval_sec": 1.0,
    "history_days": 90,                  # alarms / events kept locally
    "service_name_collector": "CraneDataCollector",
    "service_name_platform": "CraneDataPlatform",
    "sound": True,
    "desktop_popups": True,
    "popup_types": ["IP_CONFLICT", "WRONG_SIZE", "INFLUX_WRITE", "SERVICE_DOWN",
                    "PORT_BUSY", "PARSE_ERROR"],
    "terminals": {
        "T2": {"name": "Terminal 2", "port_base": 12200, "lanes": "ABCDEF",
               "lane_counts": {"A": 14, "B": 14, "C": 12, "D": 11, "E": 11, "F": 10}},
        "T3": {"name": "Terminal 3", "port_base": 12300, "lanes": "ABCDE",
               "lane_counts": {"A": 10, "B": 10, "C": 10, "D": 10, "E": 10}},
        "T4": {"name": "Terminal 4", "port_base": 12400, "lanes": "ABCDE",
               "lane_counts": {"A": 7, "B": 7, "C": 7, "D": 7, "E": 7}},
    },
    # PLC program family each crane is expected to run (used for suggestions and warnings)
    "programs": ["Retrofit", "New", "ZPMC"],
    "program_rules": {
        "T2": {"default": "Retrofit", "lanes": {"F": "New"}, "cranes": {"A213": "New", "A214": "New"}},
        "T3": {"default": "ZPMC"},
        "T4": {"default": "New"},
    },
    # Live map scaling (metres). Auto-widens if live values go past these.
    "yard": {"gantry_min": 0, "gantry_max": 2600, "trolley_max": 30, "hoist_max": 20},
}

_lock = threading.Lock()


def ensure_dirs():
    for d in (DATA_DIR, LOG_DIR, EXPORT_DIR, BACKUP_DIR):
        d.mkdir(parents=True, exist_ok=True)


def load_settings() -> dict:
    ensure_dirs()
    s = json.loads(json.dumps(DEFAULTS))
    if SETTINGS_FILE.exists():
        try:
            user = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
            for k, v in user.items():
                if isinstance(v, dict) and isinstance(s.get(k), dict) and \
                        k not in ("terminals", "program_rules"):
                    s[k].update(v)
                else:
                    s[k] = v
        except (OSError, ValueError):
            pass
    else:
        save_settings(s)
    return s


def save_settings(s: dict):
    ensure_dirs()
    with _lock:
        tmp = SETTINGS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(s, indent=2), encoding="utf-8")
        os.replace(tmp, SETTINGS_FILE)


def read_token() -> str:
    token = os.environ.get("INFLUX_TOKEN", "").strip()
    if not token and TOKEN_FILE.exists():
        token = TOKEN_FILE.read_text(encoding="utf-8").strip()
    return token


def control_key() -> str:
    """Shared secret between the collector service and the platform."""
    ensure_dirs()
    if not CONTROL_KEY_FILE.exists():
        CONTROL_KEY_FILE.write_text(secrets.token_hex(16), encoding="utf-8")
    return CONTROL_KEY_FILE.read_text(encoding="utf-8").strip()


def local_now() -> datetime:
    return datetime.now(LOCAL_TZ)


def fmt_local(ts: float | None, with_date=True) -> str:
    if not ts:
        return ""
    d = datetime.fromtimestamp(ts, LOCAL_TZ)
    return d.strftime("%Y-%m-%d %H:%M:%S" if with_date else "%H:%M:%S")
