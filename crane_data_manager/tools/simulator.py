"""
simulator.py - fake crane PLCs for testing (never needed in production).

Sends UDP packets built from a packet version in the platform, with moving
gantry / trolley / hoist values, to the collector.

    python tools\\simulator.py E208 C210              # cranes from the register
    python tools\\simulator.py E208 --from-ip 127.0.0.2   # pretend to be another IP
    python tools\\simulator.py E208 --size 344         # send a wrong packet size
    python tools\\simulator.py --all                   # every registered crane

Use only on a test PC, or on the collector PC with cranes switched OFF.
"""
import argparse
import math
import socket
import struct
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from cdm import config as C, db, layouts, registry  # noqa: E402


def build_packet(version, t, wo, size=None):
    n = size or int(version["packet_size"])
    data = bytearray(max(n, layouts.min_size(version["fields"])))
    phase = t / 40.0
    vals = {
        "In_GANTRY1": 1200 + 400 * math.sin(phase / 3), "In_GANTRY2": 1200 + 400 * math.sin(phase / 3) + 0.3,
        "GANTRYSPEED1": 40 * math.cos(phase / 3), "GANTRYSPEED2": 40 * math.cos(phase / 3),
        "In_TROLLEYPOMUX": 12 + 10 * math.sin(phase), "In_TROLLEYENC": 12.1 + 10 * math.sin(phase),
        "TROLLEYSPEED1": 60 * math.cos(phase), "In_HOIST": 10 + 8 * math.sin(phase * 1.7),
        "HOISTSPEED1": 70 * math.cos(phase * 1.7), "ControlState": 4.0,
        "In_GANTRYCurrent1": 35 + 10 * abs(math.cos(phase / 3)),
        "In_GANTRYCurrent2": 34 + 10 * abs(math.cos(phase / 3)),
        "In_HOISTCurrent1": 40 + 20 * abs(math.cos(phase * 1.7)),
        "In_HOISTCurrent2": 41 + 20 * abs(math.cos(phase * 1.7)),
        "In_TROLLEYCurrent1": 20 + 5 * abs(math.cos(phase)),
        "In_TROLLEYCurrent2": 20.5 + 5 * abs(math.cos(phase)),
        "In_RIGHTLC": 7.1, "In_LEFTLC": 7.3, "In_NEARSLC": 6.9, "In_FARSLC": 7.0,
        "LoadCellLWS": 7.1, "LoadCellLLS": 7.3, "LoadCellRWS": 6.9, "LoadCellRLS": 7.0,
        "FwdCraneGantry": 2461.7, "BwdCraneGantry": 341.9,
    }
    dints = {"WorkorderIdent": wo, "MoveType": 1, "Step": int(t / 5) % 12, "StepInfo": 0}
    for f in version["fields"]:
        if f["type"] == "REAL":
            struct.pack_into(">f", data, f["slot"] * 4, vals.get(f["name"], 0.0))
        elif f["type"] == "DINT":
            struct.pack_into(">I", data, f["slot"] * 4, dints.get(f["name"], 0))
        elif f["type"] == "DWORD":
            struct.pack_into(">I", data, f["slot"] * 4, (1 << 0) | (1 << 2) | (1 << 4) | (1 << 11)
                             if f["slot"] == 84 else 1)
        elif f["type"] == "TEXT":
            txt = datetime.now(C.LOCAL_TZ).strftime("%Y-%m-%d-%H:%M:%S") \
                if f["name"] == "PLCTime" else "MNBU4519765"
            raw = txt.encode()[:f["length"]].ljust(f["length"], b" ")
            data[f["slot"] * 4:f["slot"] * 4 + f["length"]] = raw
    return bytes(data[:n])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cranes", nargs="*")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--from-ip", default=None, help="local source IP to send from")
    ap.add_argument("--size", type=int, default=None, help="force a packet size")
    ap.add_argument("--interval", type=float, default=1.2)
    ap.add_argument("--count", type=int, default=0, help="stop after N packets per crane")
    a = ap.parse_args()
    db.init()
    cranes = registry.list_cranes()
    if not a.all:
        cranes = [c for c in cranes if c["crane"] in {x.upper() for x in a.cranes}]
    if not cranes:
        sys.exit("No matching cranes in the register.")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    if a.from_ip:
        sock.bind((a.from_ip, 0))
    vers = {c["crane"]: layouts.get_version(c["version_id"]) for c in cranes}
    print("Sending:", ", ".join(f"{c['crane']}->{c['port']}" for c in cranes))
    t0, n, wo = time.time(), 0, 100
    while not a.count or n < a.count:
        t = time.time() - t0
        if int(t) % 60 == 0:
            wo += 1
        for c in cranes:
            sock.sendto(build_packet(vers[c["crane"]], t, wo, a.size), (a.host, c["port"]))
        n += 1
        time.sleep(a.interval)


if __name__ == "__main__":
    main()
