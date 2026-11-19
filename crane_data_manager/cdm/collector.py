"""
collector.py
============
The collector service (runs as the Windows service "CraneDataCollector").

    python collector_service.py

* One listener per crane port, all inside this one service.
* IP lock: on each port only the crane's registered IP is accepted. Packets
  from any other IP are NOT written, are counted, and raise an IP_CONFLICT
  alarm - the correct crane keeps being collected.
* Each crane is decoded with its assigned packet version and written to
  InfluxDB with the same fields as the old scripts.
* A crane switched OFF keeps listening (so you still see whether it talks)
  but nothing is written.
* Refresh: only cranes whose settings changed are reloaded; a port change
  re-opens that one socket, any other change is applied without a gap.
* Never stops by itself: every thread is watched and restarted; the service
  manager restarts the process if it ever exits; InfluxDB outages go to the
  disk buffer.
"""
import hashlib
import json
import logging
import os
import signal
import socket
import threading
import time
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from logging.handlers import RotatingFileHandler
from urllib.parse import parse_qs, urlparse

from . import config as C
from . import db, layouts
from .influx import Writer, build_line
from .insights import CraneInsights

log = logging.getLogger("cdm.collector")

KEY_FIELDS = ["WorkorderIdent", "MoveType", "Step", "StepInfo", "ControlState", "AutoActive",
              "ContainerID", "PLCTime", "In_GANTRY1", "In_GANTRY2", "GANTRYSPEED1",
              "In_TROLLEYPOMUX", "TROLLEYSPEED1", "In_HOIST", "HOISTSPEED1", "GantryRef",
              "TrolleyRef", "HoistRef", "Spreader20ft", "Spreader40ft", "Spreader45ft",
              "TwinMode", "TwistlockLocked", "TwistlockUnlocked", "LandedAllPins",
              "In_GANTRYCurrent1", "In_HOISTCurrent1", "In_TROLLEYCurrent1", "StatusWord",
              "ManualIntervention", "AbortRequest", "FwdCraneGantry", "BwdCraneGantry",
              "FwdCraneDistance", "BwdCraneDistance"]
SPARK_FIELDS = ["In_GANTRY1", "In_TROLLEYPOMUX", "In_HOIST", "GANTRYSPEED1", "HOISTSPEED1",
                "In_GANTRYCurrent1", "In_HOISTCurrent1", "In_TROLLEYCurrent1", "Step"]
LOAD_FIELDS = [("In_RIGHTLC", "In_LEFTLC", "In_NEARSLC", "In_FARSLC"),
               ("LoadCellLWS", "LoadCellLLS", "LoadCellRWS", "LoadCellRLS")]


def _crane_logger(crane):
    lg = logging.getLogger(f"crane.{crane}")
    if not lg.handlers:
        lg.setLevel(logging.INFO)
        lg.propagate = False
        fh = RotatingFileHandler(C.LOG_DIR / f"{crane}.log", maxBytes=5 * 1024 * 1024,
                                 backupCount=5, encoding="utf-8")
        fh.setFormatter(logging.Formatter(f"%(asctime)s  [{crane}]  %(levelname)s  %(message)s",
                                          "%Y-%m-%d %H:%M:%S"))
        lg.addHandler(fh)
    return lg


def _plc_drift(plc_text, now):
    """Seconds between the PLC clock and this PC (PLC local or UTC, whichever is closer)."""
    try:
        t = datetime.strptime(plc_text[:19], "%Y-%m-%d-%H:%M:%S")
    except (ValueError, TypeError):
        return None, None
    as_local = t.replace(tzinfo=C.LOCAL_TZ).timestamp() - now
    as_utc = t.replace(tzinfo=timezone.utc).timestamp() - now
    return (as_local, "local") if abs(as_local) <= abs(as_utc) else (as_utc, "UTC")


class CraneConfig:
    def __init__(self, row, version):
        self.crane = row["crane"]
        self.terminal = row["terminal"]
        self.port = int(row["port"]) if row["port"] else None
        self.ip = row["ip"] or ""
        self.enabled = bool(row["enabled"])
        self.version = version
        self.decoder = layouts.Decoder(version) if version else None
        h = hashlib.sha1(json.dumps([self.port, self.ip, self.enabled,
                                     version and version["id"],
                                     version and version["fields"],
                                     version and version["packet_size"]],
                                    sort_keys=True).encode()).hexdigest()[:12]
        self.hash = h


class CraneRuntime:
    """Live state + counters of one crane (survives hot reloads)."""

    def __init__(self, cfg: CraneConfig):
        self.cfg = cfg
        self.log = _crane_logger(cfg.crane)
        self.lock = threading.Lock()
        self.started = time.time()
        self.received = self.written = self.dropped_ip = 0
        self.wrong_size = self.parse_err = self.nan_fields = self.not_written_off = 0
        self.last_packet = self.last_write = None
        self.last_size = self.last_src = None
        self.last_wrong = self.last_parse = None
        self.last_wrong_size = None
        self.last_error = None
        self.recent = deque()                      # times of accepted packets (60 s)
        self.intruders = {}                        # ip -> {count, last, size, first}
        self.seen_ips = {}                         # when no IP registered: hint only
        self.last_values = {}
        self.history = deque(maxlen=900)           # ~15 min sparkline
        self.last_raw = None                       # (ts, ip, bytes)
        self.last_raw_intruder = None
        self.bind_error = None
        self.prev_plctime = None
        self.prev_wo = None
        self.drift = None
        self.drift_mode = None
        self.insights = CraneInsights(cfg.crane)
        self.day = {}                              # date -> counters (flushed to SQLite)
        self.min_win = {"rx": 0, "wr": 0}

    def daykey(self, now):
        return datetime.fromtimestamp(now, C.LOCAL_TZ).strftime("%Y-%m-%d")

    def bump(self, now, **inc):
        d = self.day.setdefault(self.daykey(now), {})
        for k, v in inc.items():
            d[k] = d.get(k, 0) + v
        if "received" in inc:
            d.setdefault("first_ts", now)
            d["last_ts"] = now


class Listener(threading.Thread):
    def __init__(self, svc, port):
        super().__init__(name=f"udp-{port}", daemon=True)
        self.svc, self.port = svc, port
        self.stop_ev = threading.Event()
        self.sock = None

    def _open(self):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):            # Windows: no port sharing
            s.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1 << 20)
        s.bind((self.svc.settings["listen_address"], self.port))
        if hasattr(socket, "SIO_UDP_CONNRESET"):              # Windows ICMP quirk
            try:
                s.ioctl(socket.SIO_UDP_CONNRESET, False)
            except (OSError, ValueError):
                pass
        s.settimeout(1.0)
        return s

    def run(self):
        bufsize = int(self.svc.settings.get("udp_buffer_size", 2048))
        while not self.stop_ev.is_set():
            rt = self.svc.by_port.get(self.port)
            if rt is None:
                return
            if self.sock is None:
                try:
                    self.sock = self._open()
                    if rt.bind_error:
                        rt.log.info("UDP port %d is free again - listening", self.port)
                    rt.bind_error = None
                    rt.log.info("Listening on UDP port %d", self.port)
                except OSError as exc:
                    if rt.bind_error is None:
                        rt.log.error("Cannot open UDP port %d: %s", self.port, exc)
                    rt.bind_error = f"{exc}"
                    self.stop_ev.wait(10)
                    continue
            try:
                data, (ip, _sport) = self.sock.recvfrom(bufsize)
            except socket.timeout:
                continue
            except ConnectionResetError:
                continue
            except OSError as exc:
                if self.stop_ev.is_set():
                    break
                rt.log.warning("socket error on %d: %s - reopening", self.port, exc)
                self._close()
                self.stop_ev.wait(2)
                continue
            try:
                self.svc.handle(self.svc.by_port.get(self.port), data, ip)
            except Exception as exc:                          # noqa: BLE001 never die
                log.exception("packet handling error on %d: %s", self.port, exc)
        self._close()

    def _close(self):
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass
        self.sock = None

    def stop(self):
        self.stop_ev.set()


class CollectorService:
    def __init__(self):
        C.ensure_dirs()
        self.settings = C.load_settings()
        db.init()
        self.started = time.time()
        self.cranes = {}             # crane -> CraneRuntime
        self.by_port = {}            # port -> CraneRuntime
        self.listeners = {}          # port -> Listener
        self.reload_lock = threading.Lock()
        self.config_hash = ""
        self.last_reload = None
        self.stop_ev = threading.Event()
        self.writer = Writer(self.settings, on_written=self._on_written,
                             on_rejected=self._on_rejected)
        self.alarm_state = {}        # key -> last time condition seen
        self._rejected_log = {}

    # ── writer callbacks ──
    def _on_written(self, crane, n):
        rt = self.cranes.get(crane)
        now = time.time()
        if rt:
            with rt.lock:
                rt.written += n
                rt.last_write = now
                rt.min_win["wr"] += n
                rt.bump(now, written=n)

    def _on_rejected(self, crane, line, err):
        last = self._rejected_log.get(crane, 0)
        if time.time() - last > 60:
            self._rejected_log[crane] = time.time()
            db.add_event("INFLUX_WRITE", f"{crane}: InfluxDB rejected a point as invalid "
                                         f"and it was skipped: {err}", "warning", crane=crane)

    # ── configuration ──
    def load_configs(self):
        versions = {v["id"]: v for v in layouts.all_versions()}
        out = {}
        for r in db.rows("SELECT * FROM cranes"):
            out[r["crane"]] = CraneConfig(r, versions.get(r["version_id"]))
        return out

    def reload(self, reason="refresh"):
        with self.reload_lock:
            new = self.load_configs()
            changes = []
            # removed or port changed
            for crane, rt in list(self.cranes.items()):
                n = new.get(crane)
                if n is None or n.port != rt.cfg.port:
                    self._stop_port(rt.cfg.port)
                    if n is None:
                        del self.cranes[crane]
                        changes.append(f"{crane}: removed")
            for crane, cfg in new.items():
                rt = self.cranes.get(crane)
                if rt is None:
                    rt = CraneRuntime(cfg)
                    self.cranes[crane] = rt
                    changes.append(f"{crane}: started on port {cfg.port}")
                elif rt.cfg.hash != cfg.hash:
                    what = []
                    if rt.cfg.port != cfg.port:
                        what.append(f"port {rt.cfg.port}→{cfg.port}")
                    if rt.cfg.ip != cfg.ip:
                        what.append(f"IP {rt.cfg.ip or '-'}→{cfg.ip or '-'}")
                    if rt.cfg.enabled != cfg.enabled:
                        what.append("writing ON" if cfg.enabled else "writing OFF")
                    if (rt.cfg.version or {}).get("id") != (cfg.version or {}).get("id"):
                        what.append(f"version {(rt.cfg.version or {}).get('name')}→"
                                    f"{(cfg.version or {}).get('name')}")
                    elif rt.cfg.version and cfg.version and \
                            rt.cfg.version["fields"] != cfg.version["fields"]:
                        what.append(f"version {cfg.version['name']} fields updated")
                    with rt.lock:
                        rt.cfg = cfg
                        rt.intruders.clear()
                    changes.append(f"{crane}: " + ", ".join(what or ["reloaded"]))
                    rt.log.info("Reloaded: %s", ", ".join(what or ["reloaded"]))
            # ports
            self.by_port = {}
            for rt in self.cranes.values():
                if rt.cfg.port:
                    if rt.cfg.port in self.by_port:   # duplicate port: validation prevents it
                        rt.bind_error = f"port {rt.cfg.port} also assigned to " \
                                        f"{self.by_port[rt.cfg.port].cfg.crane}"
                        continue
                    self.by_port[rt.cfg.port] = rt
            for port in list(self.listeners):
                if port not in self.by_port:
                    self._stop_port(port)
            for port in self.by_port:
                if port not in self.listeners or not self.listeners[port].is_alive():
                    lst = Listener(self, port)
                    self.listeners[port] = lst
                    lst.start()
            self.config_hash = hashlib.sha1("".join(sorted(
                c.cfg.crane + c.cfg.hash for c in self.cranes.values())).encode()).hexdigest()[:12]
            self.last_reload = time.time()
            if changes:
                log.info("Reload (%s): %s", reason, "; ".join(changes))
            return changes

    def _stop_port(self, port):
        lst = self.listeners.pop(port, None)
        if lst:
            lst.stop()
            lst.join(timeout=3)

    # ── packets ──
    def handle(self, rt, data, ip):
        if rt is None:
            return
        now = time.time()
        cfg = rt.cfg
        size = len(data)
        if not cfg.ip or ip != cfg.ip:
            with rt.lock:
                if not cfg.ip:
                    rt.seen_ips[ip] = now
                    return
                d = rt.intruders.setdefault(ip, {"count": 0, "first": now})
                d["count"] += 1
                d["last"], d["size"] = now, size
                rt.dropped_ip += 1
                rt.last_raw_intruder = (now, ip, data)
                rt.bump(now, dropped_ip=1)
            return
        with rt.lock:
            prev = rt.last_packet
            rt.received += 1
            rt.last_packet, rt.last_size, rt.last_src = now, size, ip
            rt.last_raw = (now, ip, data)
            rt.recent.append(now)
            rt.min_win["rx"] += 1
            rt.bump(now, received=1)
            if prev and 3 < now - prev < 60:
                rt.bump(now, gaps=1)
            if prev and now - prev < 5:
                rt.bump(now, active_sec=now - prev)
        dec = cfg.decoder
        if dec is None:
            return
        if size != dec.packet_size:
            with rt.lock:
                rt.wrong_size += 1
                rt.last_wrong, rt.last_wrong_size = now, size
                rt.bump(now, wrong_size=1)
            if size < dec.min_size:
                return                                    # too short to decode
        try:
            fields, dropped = dec.decode(data)
        except Exception as exc:                          # noqa: BLE001
            with rt.lock:
                rt.parse_err += 1
                rt.last_parse = now
                rt.last_error = f"Parse error: {exc}"
                rt.bump(now, parse_err=1)
            return
        if dropped:
            rt.nan_fields += len(dropped)
        self._observe(rt, fields, now)
        if cfg.enabled:
            line = build_line(self.settings["influx_measurement"], cfg.crane, fields,
                              datetime.fromtimestamp(now, timezone.utc))
            self.writer.put(cfg.crane, line)
        else:
            rt.not_written_off += 1

    def _observe(self, rt, f, now):
        vals = {k: f[k] for k in KEY_FIELDS if k in f}
        for group in LOAD_FIELDS:
            if all(k in f for k in group):
                vals["LoadTotal"] = round(sum(f[k] for k in group), 2)
        spark = tuple(f.get(k) for k in SPARK_FIELDS)
        with rt.lock:
            rt.last_values = vals
            rt.history.append((now, spark))
            plc = f.get("PLCTime")
            if plc and plc == rt.prev_plctime:
                rt.bump(now, dup_sec=1)
            rt.prev_plctime = plc
            if plc:
                d, mode = _plc_drift(plc, now)
                if d is not None:
                    rt.drift, rt.drift_mode = d, mode
                    day = rt.day.setdefault(rt.daykey(now), {})
                    day["max_drift"] = max(day.get("max_drift", 0), abs(d))
            wo = f.get("WorkorderIdent")
            if wo and wo != rt.prev_wo:
                rt.bump(now, moves=1)
            rt.prev_wo = wo if wo else rt.prev_wo
        for typ, msg, value in rt.insights.update(f, now, rt.drift):
            self._insight(rt, typ, msg, value, now)

    def _insight(self, rt, typ, msg, value, now):
        date = rt.daykey(now)
        try:
            db.execute("INSERT INTO insights(ts,date,crane,type,message,value) VALUES(?,?,?,?,?,?) "
                       "ON CONFLICT(date,crane,type) DO UPDATE SET count=count+1, ts=excluded.ts, "
                       "message=excluded.message, value=excluded.value",
                       (now, date, rt.cfg.crane, typ, msg, value))
        except Exception as exc:                           # noqa: BLE001
            log.warning("insight store failed: %s", exc)

    # ── state / alarms ──
    def crane_state(self, rt, now):
        cfg = rt.cfg
        nd = self.settings["no_data_after_sec"]
        flags = []
        recent_intr = {ip: d for ip, d in rt.intruders.items() if now - d["last"] < 60}
        if recent_intr:
            flags.append("IP_CONFLICT")
        if rt.last_wrong and now - rt.last_wrong < 60:
            flags.append("WRONG_SIZE")
        if rt.last_parse and now - rt.last_parse < 60:
            flags.append("PARSE_ERROR")
        live = rt.last_packet and now - rt.last_packet < nd
        if rt.bind_error:
            state = "PORT_BUSY"
        elif not cfg.ip:
            state = "MISSING_IP"
        elif not cfg.decoder:
            state = "NO_VERSION"
        elif not cfg.enabled:
            state = "OFF"
        elif "IP_CONFLICT" in flags:
            state = "IP_CONFLICT"
        elif "WRONG_SIZE" in flags:
            state = "WRONG_SIZE"
        elif "PARSE_ERROR" in flags:
            state = "PARSE_ERROR"
        elif live and self.writer.healthy is False:
            state = "BUFFERING"
        elif live:
            state = "OK"
        else:
            state = "IDLE"
        return state, flags, recent_intr, bool(live)

    def suggest_versions(self, rt, size):
        out = []
        prog = (rt.cfg.version or {}).get("program")
        for v in layouts.all_versions():
            if int(v["packet_size"]) == size:
                out.append({"id": v["id"], "name": v["name"], "program": v["program"]})
        out.sort(key=lambda v: (v["program"] != prog, v["name"]))
        return out

    def evaluate_alarms(self):
        now = time.time()
        clear_after = self.settings["alarm_clear_after_sec"]
        seen = set()
        reg_by_ip = {rt.cfg.ip: rt for rt in self.cranes.values() if rt.cfg.ip}
        for rt in list(self.cranes.values()):
            cfg = rt.cfg
            with rt.lock:
                state, flags, intr, _ = self.crane_state(rt, now)
                intr = {ip: dict(d) for ip, d in intr.items()}
            base = dict(crane=cfg.crane, terminal=cfg.terminal)
            if intr:
                key = f"{cfg.crane}:IP_CONFLICT"
                seen.add(key)
                parts = []
                for ip, d in intr.items():
                    owner = reg_by_ip.get(ip)
                    hint = (f"{ip} is registered for {owner.cfg.crane} (port {owner.cfg.port}) - "
                            f"check {owner.cfg.crane}'s PLC send port" if owner else
                            f"{ip} is not in the crane register")
                    parts.append(f"{ip} ({d['count']} packets, {d['size']} B): {hint}")
                msg = (f"{cfg.crane} port {cfg.port}: packets from an unregistered IP are "
                       f"blocked (not written). {cfg.crane} itself ({cfg.ip}) is still "
                       f"collected. " + " | ".join(parts))
                if db.raise_alarm(key, "IP_CONFLICT", msg, details={"ips": list(intr)}, **base):
                    rt.log.warning(msg)
            if "WRONG_SIZE" in flags and cfg.decoder:
                key = f"{cfg.crane}:WRONG_SIZE"
                seen.add(key)
                sug = self.suggest_versions(rt, rt.last_wrong_size)
                written = rt.last_wrong_size >= cfg.decoder.min_size
                msg = (f"{cfg.crane}: packet is {rt.last_wrong_size} bytes, version "
                       f"{cfg.version['name']} expects {cfg.decoder.packet_size}. " +
                       ("Written with the current version (extra bytes ignored). " if written
                        else "Too short to decode - NOT written. ") +
                       (f"Matching version: {', '.join(v['name'] for v in sug)}." if sug else
                        "No version has this size."))
                if db.raise_alarm(key, "WRONG_SIZE", msg,
                                  details={"size": rt.last_wrong_size, "suggest": sug}, **base):
                    rt.log.warning(msg)
            if "PARSE_ERROR" in flags:
                key = f"{cfg.crane}:PARSE_ERROR"
                seen.add(key)
                db.raise_alarm(key, "PARSE_ERROR", f"{cfg.crane}: {rt.last_error}", **base)
            if rt.bind_error:
                key = f"{cfg.crane}:PORT_BUSY"
                seen.add(key)
                msg = (f"{cfg.crane}: cannot open UDP port {cfg.port} ({rt.bind_error}). Another "
                       f"program (an old collector?) is using it. Retrying every 10 s.")
                if db.raise_alarm(key, "PORT_BUSY", msg, **base):
                    rt.log.error(msg)
        if self.writer.healthy is False:
            key = "GLOBAL:INFLUX_WRITE"
            seen.add(key)
            st = self.writer.status()
            db.raise_alarm(key, "INFLUX_WRITE", f"InfluxDB write failing: {st['last_error']}. "
                           f"Data is kept in the outage buffer ({st['buffered']} points) and "
                           f"will be sent when InfluxDB is back.")
        if self.writer.dropped_disk_full:
            key = "GLOBAL:DISK"
            seen.add(key)
            db.raise_alarm(key, "DISK", f"Disk almost full: {self.writer.dropped_disk_full} "
                           f"points could not be buffered.")
        for k in seen:
            self.alarm_state[k] = now
        for key in db.active_alarm_keys():
            if key.startswith("PLATFORM:"):
                continue
            if key not in seen:
                last = self.alarm_state.get(key, 0)
                fast = key.endswith(":PORT_BUSY") or key == "GLOBAL:INFLUX_WRITE"
                if fast or now - last > clear_after or key.split(":")[0] not in \
                        list(self.cranes) + ["GLOBAL"]:
                    db.clear_alarm(key)

    # ── persistence of counters ──
    def flush_daily(self):
        for rt in list(self.cranes.values()):
            with rt.lock:
                days, rt.day = rt.day, {}
            for date, d in days.items():
                if not d:
                    continue
                db.execute(
                    "INSERT INTO daily_stats(date,crane,received,written,dropped_ip,wrong_size,"
                    "parse_err,active_sec,moves,dup_sec,gaps,max_drift,first_ts,last_ts) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(date,crane) DO UPDATE SET "
                    "received=received+excluded.received, written=written+excluded.written, "
                    "dropped_ip=dropped_ip+excluded.dropped_ip, "
                    "wrong_size=wrong_size+excluded.wrong_size, "
                    "parse_err=parse_err+excluded.parse_err, "
                    "active_sec=active_sec+excluded.active_sec, moves=moves+excluded.moves, "
                    "dup_sec=dup_sec+excluded.dup_sec, gaps=gaps+excluded.gaps, "
                    "max_drift=MAX(max_drift, excluded.max_drift), "
                    "first_ts=COALESCE(first_ts, excluded.first_ts), "
                    "last_ts=COALESCE(excluded.last_ts, last_ts)",
                    (date, rt.cfg.crane, d.get("received", 0), d.get("written", 0),
                     d.get("dropped_ip", 0), d.get("wrong_size", 0), d.get("parse_err", 0),
                     d.get("active_sec", 0), d.get("moves", 0), d.get("dup_sec", 0),
                     d.get("gaps", 0), d.get("max_drift", 0), d.get("first_ts"),
                     d.get("last_ts")))

    def minute_summaries(self):
        for rt in list(self.cranes.values()):
            with rt.lock:
                w, rt.min_win = rt.min_win, {"rx": 0, "wr": 0}
            intr = ", ".join(rt.intruders) or "-"
            rt.log.info("Last 60s: received %d, written %d | last size %s from %s | blocked IPs "
                        "%s | total written %d", w["rx"], w["wr"], rt.last_size,
                        rt.last_src or "-", intr, rt.written)

    # ── snapshot for the platform ──
    def snapshot(self):
        now = time.time()
        cranes = {}
        for crane, rt in list(self.cranes.items()):
            with rt.lock:
                while rt.recent and rt.recent[0] < now - 60:
                    rt.recent.popleft()
                state, flags, intr, live = self.crane_state(rt, now)
                cfg = rt.cfg
                cranes[crane] = {
                    "crane": crane, "terminal": cfg.terminal, "port": cfg.port, "ip": cfg.ip,
                    "enabled": cfg.enabled,
                    "version_id": cfg.version and cfg.version["id"],
                    "version": cfg.version and cfg.version["name"],
                    "program": cfg.version and cfg.version["program"],
                    "expected_size": cfg.decoder and cfg.decoder.packet_size,
                    "state": state, "flags": flags, "live": live,
                    "pkt_min": len(rt.recent), "received": rt.received, "written": rt.written,
                    "dropped_ip": rt.dropped_ip, "wrong_size": rt.wrong_size,
                    "parse_err": rt.parse_err, "not_written_off": rt.not_written_off,
                    "last_packet": rt.last_packet, "last_write": rt.last_write,
                    "last_size": rt.last_size, "last_src": rt.last_src,
                    "last_wrong_size": rt.last_wrong_size,
                    "intruders": {ip: dict(d) for ip, d in rt.intruders.items()},
                    "recent_intruders": list(intr),
                    "seen_ips": [ip for ip, t in rt.seen_ips.items() if now - t < 300],
                    "bind_error": rt.bind_error, "last_error": rt.last_error,
                    "drift": rt.drift, "drift_mode": rt.drift_mode,
                    "values": dict(rt.last_values), "config_hash": cfg.hash,
                    "running_since": rt.started,
                }
        return {"service": {"pid": os.getpid(), "started": self.started, "now": now,
                            "config_hash": self.config_hash, "last_reload": self.last_reload,
                            "listeners": len(self.listeners),
                            "threads_ok": all(l.is_alive() for l in self.listeners.values())},
                "writer": self.writer.status(), "cranes": cranes}

    def history(self, crane):
        rt = self.cranes.get(crane)
        if not rt:
            return {"fields": SPARK_FIELDS, "points": []}
        with rt.lock:
            pts = [[t] + list(v) for t, v in rt.history]
        return {"fields": SPARK_FIELDS, "points": pts}

    def raw(self, crane, which="registered"):
        rt = self.cranes.get(crane)
        if not rt:
            return None
        r = rt.last_raw if which == "registered" else rt.last_raw_intruder
        if not r:
            return None
        return {"ts": r[0], "ip": r[1], "size": len(r[2]), "hex": r[2].hex()}

    # ── main loop ──
    def run(self):
        log.info("Collector service starting (pid %d)", os.getpid())
        db.add_event("SERVICE", "Collector service started", "info")
        self.writer.start()
        self.reload("startup")
        for key in db.active_alarm_keys():        # grace period after a restart
            self.alarm_state[key] = time.time()
        ctl = ControlServer(self)
        ctl.start()
        next_alarm = next_flush = next_min = next_clean = time.time()
        while not self.stop_ev.is_set():
            self.stop_ev.wait(1)
            now = time.time()
            try:
                # internal watchdog: restart anything that died
                if not self.writer.thread.is_alive():
                    log.error("writer thread died - restarting it")
                    self.writer.thread = threading.Thread(target=self.writer._run,
                                                          name="influx-writer", daemon=True)
                    self.writer.thread.start()
                for port, lst in list(self.listeners.items()):
                    if not lst.is_alive() and port in self.by_port:
                        log.error("listener %d died - restarting it", port)
                        nl = Listener(self, port)
                        self.listeners[port] = nl
                        nl.start()
                if not ctl.thread.is_alive():
                    ctl = ControlServer(self)
                    ctl.start()
                if now >= next_alarm:
                    self.evaluate_alarms()
                    next_alarm = now + 2
                if now >= next_flush:
                    self.flush_daily()
                    next_flush = now + 30
                if now >= next_min:
                    self.minute_summaries()
                    next_min = now + 60
                if now >= next_clean:
                    db.cleanup(self.settings.get("history_days", 90))
                    next_clean = now + 6 * 3600
            except Exception as exc:                          # noqa: BLE001
                log.exception("main loop error: %s", exc)
        self.shutdown()

    def shutdown(self):
        log.info("Collector service stopping")
        for port in list(self.listeners):
            self._stop_port(port)
        self.writer.close()
        try:
            self.flush_daily()
            db.add_event("SERVICE", "Collector service stopped", "info")
        except Exception:                                     # noqa: BLE001
            pass


class ControlServer:
    """Tiny HTTP API on 127.0.0.1 for the platform (shared key required)."""

    def __init__(self, svc):
        self.svc = svc
        key = C.control_key()
        service = svc

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, obj):
                body = json.dumps(obj, default=str).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _auth(self):
                if self.headers.get("X-Key") != key:
                    self._send(403, {"error": "forbidden"})
                    return False
                return True

            def do_GET(self):
                if not self._auth():
                    return
                u = urlparse(self.path)
                q = {k: v[0] for k, v in parse_qs(u.query).items()}
                if u.path == "/ping":
                    self._send(200, {"ok": True, "pid": os.getpid(), "started": service.started,
                                     "config_hash": service.config_hash})
                elif u.path == "/status":
                    self._send(200, service.snapshot())
                elif u.path == "/history":
                    self._send(200, service.history(q.get("crane", "")))
                elif u.path == "/raw":
                    self._send(200, service.raw(q.get("crane", ""), q.get("which", "registered"))
                               or {})
                else:
                    self._send(404, {"error": "not found"})

            def do_POST(self):
                if not self._auth():
                    return
                if urlparse(self.path).path == "/reload":
                    n = int(self.headers.get("Content-Length") or 0)
                    body = json.loads(self.rfile.read(n) or b"{}") if n else {}
                    changes = service.reload(body.get("reason", "refresh"))
                    self._send(200, {"ok": True, "changes": changes,
                                     "config_hash": service.config_hash})
                else:
                    self._send(404, {"error": "not found"})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", int(svc.settings["control_port"])), H)
        self.httpd.daemon_threads = True
        self.thread = threading.Thread(target=self.httpd.serve_forever, name="control",
                                       daemon=True)

    def start(self):
        self.thread.start()


def setup_logging():
    C.ensure_dirs()
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s  %(levelname)s  %(name)s  %(message)s",
                            "%Y-%m-%d %H:%M:%S")
    fh = RotatingFileHandler(C.LOG_DIR / "collector.log", maxBytes=5 * 1024 * 1024,
                             backupCount=5, encoding="utf-8")
    fh.setFormatter(fmt)
    root.addHandler(fh)
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    root.addHandler(sh)


def _another_collector_running():
    """True when a collector already answers on the control port (e.g. the Windows
    service is running and someone also started run.bat)."""
    from . import ctl
    try:
        ctl.ping()
        return True
    except ctl.CollectorDown:
        return False


def main():
    setup_logging()
    if _another_collector_running():
        log.warning("Another collector is already running on this PC (control port %s answers). "
                    "This copy waits and takes over only if that one stops.",
                    C.load_settings()["control_port"])
        print("\nAnother collector is already running on this PC - this window is not needed.\n"
              "It waits and takes over only if the other one stops. You can close it.\n")
        while _another_collector_running():
            time.sleep(10)
    svc = CollectorService()

    def _stop(*_):
        svc.stop_ev.set()
    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, _stop)
    svc.run()
