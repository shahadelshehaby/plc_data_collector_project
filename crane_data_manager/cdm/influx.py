"""
influx.py
=========
InfluxDB access.

Writer (used by the collector service)
    * Points are built exactly like the old scripts: measurement crane_telemetry,
      tag crane_id, the same fields, timestamp = time the packet arrived (ms, UTC).
    * Points are sent in small batches about once per second.
    * Outage buffer: if InfluxDB / the NAS cannot be reached, points go to
      data/buffer.db (compressed) and are re-sent in time order as soon as
      InfluxDB answers again. Nothing is lost, also across a PC restart.
    * A point InfluxDB rejects as invalid (e.g. a field type conflict) is
      logged and skipped so it cannot block the rest.

Reader (used by the platform): Flux queries, read-only.
"""
import logging
import shutil
import sqlite3
import threading
import time
import zlib
from collections import deque
from datetime import datetime, timezone

from . import config as C

log = logging.getLogger("cdm.influx")


def build_line(measurement, crane_id, fields, ts=None):
    from influxdb_client import Point, WritePrecision
    p = Point(measurement).tag("crane_id", crane_id).time(
        ts or datetime.now(timezone.utc), WritePrecision.MS)
    for k, v in fields.items():
        p = p.field(k, v)
    return p.to_line_protocol()


def client(settings, timeout_ms=None):
    from influxdb_client import InfluxDBClient
    return InfluxDBClient(url=settings["influx_url"], token=C.read_token(),
                          org=settings["influx_org"],
                          timeout=timeout_ms or settings.get("influx_timeout_ms", 5000))


class DiskBuffer:
    def __init__(self, path=C.BUFFER_FILE):
        self.path = str(path)
        self.lock = threading.Lock()
        con = self._con()
        con.execute("CREATE TABLE IF NOT EXISTS buf (id INTEGER PRIMARY KEY AUTOINCREMENT, "
                    "crane TEXT, n INTEGER, blob BLOB)")
        self.count = con.execute("SELECT COALESCE(SUM(n),0) FROM buf").fetchone()[0]

    def _con(self):
        if not hasattr(self, "_c"):
            self._c = sqlite3.connect(self.path, timeout=30, check_same_thread=False,
                                      isolation_level=None)
            self._c.execute("PRAGMA journal_mode=WAL")
        return self._c

    def push(self, items):
        """items = [(crane, line)] -> stored grouped per crane, compressed."""
        by = {}
        for crane, line in items:
            by.setdefault(crane, []).append(line)
        with self.lock:
            con = self._con()
            con.execute("BEGIN")
            for crane, lines in by.items():
                con.execute("INSERT INTO buf(crane,n,blob) VALUES(?,?,?)",
                            (crane, len(lines), zlib.compress("\n".join(lines).encode(), 6)))
            con.execute("COMMIT")
            self.count += len(items)

    def peek(self, max_rows=20):
        with self.lock:
            rs = self._con().execute("SELECT id, crane, n, blob FROM buf ORDER BY id LIMIT ?",
                                     (max_rows,)).fetchall()
        return [(i, crane, n, zlib.decompress(b).decode().split("\n")) for i, crane, n, b in rs]

    def delete(self, ids, n):
        with self.lock:
            self._con().execute(f"DELETE FROM buf WHERE id IN ({','.join('?' * len(ids))})", ids)
            self.count = max(0, self.count - n)

    def size_bytes(self):
        try:
            import os
            return sum(os.path.getsize(self.path + s) for s in ("", "-wal") if
                       os.path.exists(self.path + s))
        except OSError:
            return 0


class Writer:
    MIN_FREE_BYTES = 2 * 1024 ** 3          # stop buffering below 2 GB free disk

    def __init__(self, settings, on_written=None, on_rejected=None):
        self.s = settings
        self.queue = deque()
        self.qlock = threading.Lock()
        self.buffer = DiskBuffer()
        self.on_written = on_written or (lambda crane, n: None)
        self.on_rejected = on_rejected or (lambda crane, line, err: None)
        self.healthy = None                  # None = unknown yet
        self.last_ok = None
        self.last_error = None
        self.last_error_ts = None
        self.written_total = 0
        self.rejected_total = 0
        self.dropped_disk_full = 0
        self.stop = threading.Event()
        self._api = None
        self._client = None
        self.thread = threading.Thread(target=self._run, name="influx-writer", daemon=True)

    def start(self):
        self.thread.start()

    # called by listener threads
    def put(self, crane, line):
        with self.qlock:
            self.queue.append((crane, line))

    def pending(self):
        return len(self.queue)

    def _api_get(self):
        if self._api is None:
            from influxdb_client.client.write_api import SYNCHRONOUS
            self._client = client(self.s)
            self._api = self._client.write_api(write_options=SYNCHRONOUS)
        return self._api

    def _reset_api(self):
        try:
            if self._client:
                self._client.close()
        except Exception:
            pass
        self._api = self._client = None

    def _send(self, lines):
        from influxdb_client import WritePrecision
        self._api_get().write(bucket=self.s["influx_bucket"], org=self.s["influx_org"],
                              record=lines, write_precision=WritePrecision.MS)

    @staticmethod
    def _is_rejection(exc):
        st = getattr(exc, "status", None)
        return st in (400, 422)

    def _write_items(self, items):
        """Write [(crane, line)]. Returns True if InfluxDB answered (written or
        rejected as invalid), False if it could not be reached."""
        try:
            self._send([l for _, l in items])
        except Exception as exc:                       # noqa: BLE001
            if self._is_rejection(exc):
                # find and skip the bad points, keep the good ones
                for crane, line in items:
                    try:
                        self._send([line])
                        self._ok(crane, 1)
                    except Exception as e2:            # noqa: BLE001
                        if self._is_rejection(e2):
                            self.rejected_total += 1
                            self.on_rejected(crane, line, _err_text(e2))
                        else:
                            # lost the connection half way: the caller buffers the whole
                            # batch; points already written are simply written again
                            # (same time + tag + fields = same point, no duplicate)
                            self._fail(e2)
                            return False
                return True
            self._fail(exc)
            return False
        counts = {}
        for crane, _ in items:
            counts[crane] = counts.get(crane, 0) + 1
        for crane, n in counts.items():
            self._ok(crane, n)
        return True

    def _ok(self, crane, n):
        self.written_total += n
        self.last_ok = time.time()
        if self.healthy is not True:
            log.info("InfluxDB writes OK")
        self.healthy = True
        self.on_written(crane, n)

    def _fail(self, exc):
        if self.healthy is not False:
            log.error("InfluxDB write failed - buffering to disk: %s", _err_text(exc))
        self.healthy = False
        self.last_error = _err_text(exc)
        self.last_error_ts = time.time()
        self._reset_api()

    def _disk_ok(self):
        try:
            return shutil.disk_usage(C.DATA_DIR).free > self.MIN_FREE_BYTES
        except OSError:
            return True

    def _to_buffer(self, items):
        if not items:
            return
        if self._disk_ok():
            self.buffer.push(items)
        else:
            self.dropped_disk_full += len(items)

    def _run(self):
        interval = float(self.s.get("write_interval_sec", 1.0))
        batch_max = int(self.s.get("write_batch_max", 500))
        next_probe = 0
        while not self.stop.is_set():
            time.sleep(interval)
            with self.qlock:
                items = [self.queue.popleft() for _ in range(min(len(self.queue), 20000))]
            try:
                # 1) old buffered data first, so InfluxDB receives everything in order
                if self.buffer.count:
                    if self.healthy is False and time.time() < next_probe:
                        self._to_buffer(items)
                        continue
                    self._drain(items)
                    if self.healthy is False:
                        next_probe = time.time() + 5
                    continue
                # 2) normal path
                for i in range(0, len(items), batch_max):
                    chunk = items[i:i + batch_max]
                    if not self._write_items(chunk):
                        self._to_buffer(items[i:])
                        next_probe = time.time() + 5
                        break
            except Exception as exc:                    # noqa: BLE001 - never die
                log.exception("writer loop error: %s", exc)
                self._to_buffer(items)

    def _drain(self, new_items):
        """Send buffered rows (oldest first), then the new ones."""
        self._to_buffer(new_items)
        deadline = time.time() + 5
        while self.buffer.count and time.time() < deadline and not self.stop.is_set():
            chunk = self.buffer.peek(10)
            if not chunk:
                break
            ids, n = [], 0
            for rid, crane, cnt, lines in chunk:
                ok = True
                for i in range(0, len(lines), 2000):
                    if not self._write_items([(crane, l) for l in lines[i:i + 2000]]):
                        ok = False
                        break
                if not ok:
                    if ids:
                        self.buffer.delete(ids, n)
                    return
                ids.append(rid)
                n += cnt
            self.buffer.delete(ids, n)

    def status(self):
        return {"healthy": self.healthy, "last_ok": self.last_ok, "last_error": self.last_error,
                "last_error_ts": self.last_error_ts, "written_total": self.written_total,
                "rejected_total": self.rejected_total, "queue": len(self.queue),
                "buffered": self.buffer.count, "buffer_bytes": self.buffer.size_bytes(),
                "dropped_disk_full": self.dropped_disk_full}

    def close(self, timeout=10):
        """Flush what is queued (or buffer it) before the service stops."""
        self.stop.set()
        with self.qlock:
            items = list(self.queue)
            self.queue.clear()
        if items and self.healthy is not False:
            try:
                if self._write_items(items):
                    items = []
            except Exception:                           # noqa: BLE001
                pass
        self._to_buffer(items)
        self._reset_api()


def _err_text(exc):
    st = getattr(exc, "status", None)
    body = getattr(exc, "body", None)
    msg = str(body or getattr(exc, "reason", None) or exc).strip().replace("\n", " ")
    try:
        import json as _j
        msg = _j.loads(body).get("message", msg) if body else msg
    except (ValueError, TypeError, AttributeError):
        pass
    if st == 401:
        msg = "unauthorized - check influx_token.txt (" + msg[:120] + ")"
    return (f"HTTP {st}: " if st else "") + msg[:300]


# ── Reading ──────────────────────────────────────────────────────────────────
def health(settings):
    try:
        with client(settings, 4000) as c:
            h = c.health()
            return {"ok": h.status == "pass", "message": h.message, "version": h.version}
    except Exception as exc:                            # noqa: BLE001
        return {"ok": False, "message": _err_text(exc)}
