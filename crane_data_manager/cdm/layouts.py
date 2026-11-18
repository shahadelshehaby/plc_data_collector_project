"""
layouts.py
==========
Packet versions ("layouts"). One version = the list of fields a crane PLC
packs into its UDP packet: where each field sits and how to read it.

Field types (slot = 4-byte word index, as in the PLC ConvertValArr / BufferConvert):
    REAL   32-bit float, big-endian            -> InfluxDB float
    DINT   32-bit integer, read as unsigned    -> InfluxDB integer   (same as the old scripts)
    DWORD  32-bit status word                  -> InfluxDB integer   (bits can be split out of it)
    BIT    one bit of a DWORD field (0/1)      -> InfluxDB integer
    TEXT   ASCII text starting at a slot       -> InfluxDB string

The baseline versions below reproduce the old scripts exactly (names, slots,
bits and types), so the data in InfluxDB stays the same:
    T2  v2    typingtensions_updatedv2.py   / terminal2_collector version "2"
    T2  v2.1  typingtensions_updatedv2.1.py / terminal2_collector version "2.1"
    T3  v3    typingtensions_updatedv3.py
    T4  v4    typingtensions_updatedv4.py
"""
import json
import math
import re
import struct
import time

TYPES = ("REAL", "DINT", "DWORD", "BIT", "TEXT")
INFLUX_TYPE = {"REAL": "float", "DINT": "integer", "DWORD": "integer", "BIT": "integer",
               "TEXT": "string"}
NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")

# ── Groups (same grouping as the project PDF) ────────────────────────────────
GROUPS = ["Text", "Spreader", "Load cells", "Gantry", "Trolley", "Hoist", "Drive currents",
          "Drive voltages", "Power cable reel", "Neighbour cranes", "Control",
          "Job & automation", "Status words", "Crane state", "Anti-collision", "Brakes", "Other"]


def guess_group(name: str, type_: str) -> str:
    n = name.lower()
    if type_ == "TEXT":
        return "Text"
    if type_ == "DWORD":
        return "Status words"
    if "brake" in n:
        return "Brakes"
    if n.startswith("antic") or n.startswith("longd"):
        return "Anti-collision"
    if "current" in n and n.startswith("in_"):
        return "Drive currents"
    if "voltage" in n:
        return "Drive voltages"
    if n.startswith("pcr_") or "feedingpoint" in n:
        return "Power cable reel"
    if n.startswith("fwdcrane") or n.startswith("bwdcrane"):
        return "Neighbour cranes"
    if "lc" == n[-2:] or n.startswith("loadcell"):
        return "Load cells"
    if type_ == "DINT":
        return "Job & automation"
    if type_ == "BIT":
        return "Crane state"
    if n in ("controlstate", "connecteddeskno"):
        return "Control"
    if any(k in n for k in ("trim", "list", "skew", "in_rt", "in_rg", "cylinder", "in_mm")):
        return "Spreader"
    if "gantry" in n:
        return "Gantry"
    if "trolley" in n:
        return "Trolley"
    if "hoist" in n:
        return "Hoist"
    return "Other"


UNITS = {"Drive currents": "%", "Drive voltages": "%", "Gantry": "", "Trolley": "",
         "Hoist": ""}


def _f(name, type_, slot=None, bit=None, word=None, length=None, strip=None, group=None,
       unit="", description=""):
    d = {"name": name, "type": type_, "group": group or guess_group(name, type_),
         "unit": unit, "description": description}
    if type_ == "BIT":
        d["word"], d["bit"] = word, bit
    else:
        d["slot"] = slot
    if type_ == "TEXT":
        d["length"], d["strip"] = length, strip or "both"
    return d


def _reals(pairs):
    return [_f(n, "REAL", s) for s, n in pairs]


def _bits(word, names, start=0):
    return [_f(n, "BIT", word=word, bit=start + i) for i, n in enumerate(names)]


_TEXT = [_f("PLCTime", "TEXT", 16, length=19, strip="both",
            description="PLC date/time text, slots 16-20"),
         _f("ContainerID", "TEXT", 51, length=11, strip="right",
            description="Container ID text, slots 51-53")]

_DINTS = [_f(n, "DINT", s) for s, n in [
    (72, "WorkorderIdent"), (73, "MoveType"), (74, "LandingType"), (75, "JobClearance"),
    (76, "TargetType"), (77, "ControlReject"), (81, "Step"), (82, "StepInfo"),
    (83, "RemoteRequestInfo")]]

# ── Terminal 2 ───────────────────────────────────────────────────────────────
_T2_REALS = [
    (0, "In_TRIM"), (1, "In_LIST"), (2, "In_SKEW"), (3, "In_RT"), (4, "In_RG"),
    (5, "In_CYLINDER1"), (6, "In_CYLINDER2"), (7, "In_GANTRY1"), (8, "GANTRYSPEED1"),
    (9, "In_TROLLEYPOMUX"), (10, "In_TROLLEYENC"), (11, "TROLLEYSPEED1"),
    (12, "In_HOIST"), (13, "HOISTSPEED1"), (14, "Gantry_obs_start"), (15, "Gantry_obs_end"),
    (21, "In_RIGHTLC"), (22, "In_LEFTLC"), (23, "In_NEARSLC"), (24, "In_FARSLC"),
    (25, "In_GANTRYCurrent1"), (26, "In_GANTRYCurrent2"), (27, "In_HOISTCurrent1"),
    (28, "In_HOISTCurrent2"), (29, "In_TROLLEYCurrent1"), (30, "In_TROLLEYCurrent2"),
    (31, "ControlState"), (32, "HoistSpdLim"), (33, "TrolleySpdLim"), (34, "ConnectedDeskNo"),
    (35, "In_GANTRYVoltage1"), (36, "In_GANTRYVoltage2"), (37, "In_TROLLEYVoltage1"),
    (38, "In_HOISTVoltage1"), (39, "In_HOISTVoltage2"), (40, "In_TROLLEYVoltage2"),
    (41, "FwdCraneGantry"), (42, "BwdCraneGantry"),
    (54, "GANTRYSPEED2"), (55, "HOISTSPEED2"), (56, "TROLLEYSPEED2"),
    (57, "GantryTorque1"), (58, "GantryTorque2"), (59, "HoistTorque1"), (60, "HoistTorque2"),
    (61, "TrolleyTorque1"), (62, "TrolleyTorque2"),
    (63, "PCR_SpdRef"), (64, "PCR_SpdActual"), (65, "PCR_TorqueRef"), (66, "PCR_TorqueAct"),
    (67, "PCR_Current"), (68, "In_GANTRY2"), (69, "GantrySpdRef"), (70, "GantrySpdLim"),
    (71, "GantrySpdReq"), (78, "GantryRef"), (79, "TrolleyRef"), (80, "HoistRef"),
]
_T2_SW = ["ControlON", "Spreader20ft", "Spreader40ft", "Spreader45ft", "SingleMode",
          "TwinMode", "LandedAllPins", "TwistlockLocked", "TwistlockUnlocked",
          "InnerLaneInPosition", "OuterLaneInPosition", "GantrySynchOk", "Gantry_obs_active",
          "AbortRequest",
          "AntiCLandSrightPreStop", "AntiCLandSrightStop", "AntiCLandSrightWarning",
          "AntiCWaterSrightPreStop", "AntiCWaterSrightStop", "AntiCWaterSrightWarning",
          "AntiCLandSLeftPreStop", "AntiCLandSLeftStop", "AntiCLandSLeftWarning",
          "AntiCWaterSLeftPreStop", "AntiCWaterSLeftStop", "AntiCWaterSLeftWarning",
          "LongDLandSRight", "LongDLandSLeft", "LongDWaterSLeft", "LongDWaterSRight",
          "AntiCGantryFwdLatch", "AntiCGantryBwdLatch"]
_T2_SW2_V2 = ["AutoActive", "ManualIntervention", "ForwardRequest", "BackwardRequest"]
_T2_SW2_V21_EXTRA = [f"Brake{i}Released" for i in range(1, 13)] + \
                    ["RailBrake1LeftReleased", "RailBrake2LeftReleased"]


def _t2_v2():
    return (_TEXT[:1] + _reals(_T2_REALS) + _DINTS + _TEXT[1:] +
            [_f("StatusWord", "DWORD", 84, description="Status word 1 (32 flags)")] +
            _bits(84, _T2_SW) +
            [_f("StatusWord2", "DWORD", 85, description="Status word 2")] +
            _bits(85, _T2_SW2_V2))


def _t2_v21():
    return _t2_v2() + _bits(85, _T2_SW2_V21_EXTRA, start=4) + _reals([
        (86, "FwdCraneState"), (87, "BwdCraneState"), (88, "FwdCraneDistance"),
        (89, "BwdCraneDistance"), (90, "SpreaderSkew")])


# ── Terminals 3 and 4 (same slots, different status word) ───────────────────
_T34_REALS = [
    (0, "In_TRIM"), (1, "In_LIST"), (2, "In_SKEW"), (3, "In_RT"), (4, "In_RG"),
    (5, "In_MM1"), (6, "In_MM2"), (7, "In_GANTRY1"), (8, "GANTRYSPEED1"),
    (9, "In_TROLLEYPOMUX"), (10, "In_TROLLEYENC"), (11, "TROLLEYSPEED1"),
    (12, "In_HOIST"), (13, "HOISTSPEED1"), (14, "Gantry_obs_start"), (15, "Gantry_obs_end"),
    (21, "LoadCellLWS"), (22, "LoadCellLLS"), (23, "LoadCellRWS"), (24, "LoadCellRLS"),
    (25, "In_GANTRYCurrent1"), (26, "In_GANTRYCurrent2"), (27, "In_HOISTCurrent1"),
    (28, "In_HOISTCurrent2"), (29, "In_TROLLEYCurrent1"),
    (31, "ControlState"), (32, "HoistSpdLim"), (33, "TrolleySpdLim"), (34, "ConnectedDeskNo"),
    (35, "In_GANTRYVoltage1"), (36, "In_GANTRYVoltage2"), (37, "In_TROLLEYVoltage1"),
    (38, "In_HOISTVoltage1"), (39, "In_HOISTVoltage2"), (40, "In_MM3"), (41, "In_MM4"),
    (42, "FwdCraneGantry"), (43, "BwdCraneGantry"),
    (54, "GANTRYSPEED2"), (55, "HOISTSPEED2"),
    (57, "GantryTorque1"), (58, "GantryTorque2"), (59, "HoistTorque1"), (60, "HoistTorque2"),
    (61, "TrolleyTorque1"),
    (63, "Feedingpointpos"), (64, "PCR_SpdActual"), (66, "PCR_TorqueAct"), (67, "PCR_Current"),
    (68, "In_GANTRY2"), (69, "GantrySpdRef"), (70, "GantrySpdLim"), (71, "GantrySpdReq"),
    (78, "GantryRef"), (79, "TrolleyRef"), (80, "HoistRef"),
]
_T34_SW_COMMON = ["ControlON", "Spreader20ft", "Spreader40ft", "Spreader45ft", "SingleMode",
                  "TwinMode", "LandedAllPins", "TwistlockLocked", "TwistlockUnlocked",
                  "WatersideInPosition", "LandsideInPosition", "GantrySynchOk",
                  "Gantry_obs_active", "AbortRequest"]
_T3_SW_REST = ["AntiCLandSrightPreStop", "AntiCLandSrightStop", "AntiCLandSrightWarning",
               "AntiCWaterSLeftPreStop", "AntiCWaterSLeftStop", "AntiCWaterSLeftWarning",
               "AntiCLandSLeftPreStop", "AntiCLandSLeftStop", "AntiCLandSLeftWarning",
               "AntiCWaterSrightPreStop", "AntiCWaterSrightStop", "AntiCWaterSrightWarning",
               "AutoActive", "ManualIntervention", "ForwardRequest", "BackwardRequest",
               "AntiCGantryFwdLatch", "AntiCGantryBwdLatch"]
_T4_SW_REST = ["AntiCLandSrightStop", "AntiCWaterSLeftStop", "AntiCLandSLeftStop",
               "AntiCWaterSrightStop", "AutoActive", "AntiCGantryFwdLatch",
               "AntiCGantryBwdLatch"]


def _t34(rest):
    return (_TEXT[:1] + _reals(_T34_REALS) + _DINTS + _TEXT[1:] +
            [_f("StatusWord", "DWORD", 84, description="Status word")] +
            _bits(84, _T34_SW_COMMON + rest))


BASELINES = [
    ("T2", "v2", 344, _t2_v2, "Baseline from typingtensions_updatedv2.py (86 slots, 344 bytes)"),
    ("T2", "v2.1", 364, _t2_v21, "v2 + brakes, neighbour crane state/distance, spreader skew "
                                 "(91 slots, 364 bytes)"),
    ("T3", "v3", 340, lambda: _t34(_T3_SW_REST), "Baseline from typingtensions_updatedv3.py "
                                                 "(85 slots, 340 bytes)"),
    ("T4", "v4", 340, lambda: _t34(_T4_SW_REST), "Baseline from typingtensions_updatedv4.py "
                                                 "(85 slots, 340 bytes)"),
]


def seed_versions():
    from . import db
    if db.one("SELECT id FROM versions LIMIT 1"):
        return
    ids, all_ids = {}, []
    for term, name, size, fn, notes in BASELINES:
        base = ids.get(term) if name == "v2.1" else None
        ids[term] = db.execute(
            "INSERT INTO versions(terminal,name,base_id,packet_size,fields_json,notes,created) "
            "VALUES(?,?,?,?,?,?,?)",
            (term, name, base, size, json.dumps(fn()), notes, time.time()))
        all_ids.append(ids[term])
    db.meta_set("baseline_ids", all_ids)


# ── Access ───────────────────────────────────────────────────────────────────
def get_version(vid):
    from . import db
    v = db.one("SELECT * FROM versions WHERE id=?", (vid,))
    if v:
        v["fields"] = json.loads(v.pop("fields_json"))
    return v


def all_versions():
    from . import db
    out = []
    for v in db.rows("SELECT * FROM versions ORDER BY terminal, id"):
        v["fields"] = json.loads(v.pop("fields_json"))
        out.append(v)
    return out


def field_span(f):
    """Byte range a field occupies, or None for BIT."""
    if f["type"] == "BIT":
        return None
    start = int(f["slot"]) * 4
    return start, start + (int(f["length"]) if f["type"] == "TEXT" else 4)


def min_size(fields):
    return max((field_span(f)[1] for f in fields if field_span(f)), default=0)


# ── Validation ───────────────────────────────────────────────────────────────
def validate(fields, packet_size, base=None, others=()):
    """Returns a list of problems (empty = OK).
    base   = the version this one was copied from (its fields are locked)
    others = every other version (field types must match across versions,
             or InfluxDB would refuse the writes: one field = one type)."""
    errs = []
    names, spans, bits = {}, [], {}
    dwords = {int(f["slot"]) for f in fields if f.get("type") == "DWORD"}
    for i, f in enumerate(fields):
        n, t = str(f.get("name", "")).strip(), f.get("type")
        where = f"Field {i + 1} ({n or 'no name'})"
        if not NAME_RE.match(n):
            errs.append(f"{where}: name must start with a letter and use only letters, "
                        f"digits and _ (max 64)")
        if n in names:
            errs.append(f"{where}: name '{n}' is used twice")
        names[n] = f
        if t not in TYPES:
            errs.append(f"{where}: unknown type '{t}'")
            continue
        try:
            if t == "BIT":
                w, b = int(f["word"]), int(f["bit"])
                if w not in dwords:
                    errs.append(f"{where}: bit refers to slot {w}, which is not a DWORD "
                                f"status word in this version")
                if not 0 <= b <= 31:
                    errs.append(f"{where}: bit must be 0..31")
                if (w, b) in bits:
                    errs.append(f"{where}: slot {w} bit {b} is already used by "
                                f"{bits[(w, b)]}")
                bits[(w, b)] = n
            else:
                s = int(f["slot"])
                if s < 0:
                    errs.append(f"{where}: slot must be 0 or more")
                if t == "TEXT" and not 1 <= int(f.get("length") or 0) <= 64:
                    errs.append(f"{where}: text length must be 1..64 bytes")
                a, z = field_span(f)
                for (a2, z2, n2) in spans:
                    if a < z2 and a2 < z:
                        errs.append(f"{where}: overlaps {n2} (bytes {a2}-{z2 - 1})")
                spans.append((a, z, n))
        except (KeyError, TypeError, ValueError):
            errs.append(f"{where}: slot / bit / length must be numbers")
    need = min_size(fields) if not errs else 0
    if packet_size and need and int(packet_size) < need:
        errs.append(f"Packet size {packet_size} bytes is smaller than the fields need "
                    f"({need} bytes)")
    if base:
        for bf in base["fields"]:
            f = names.get(bf["name"])
            if not f:
                errs.append(f"'{bf['name']}' comes from {base['name']} and is locked: it cannot "
                            f"be removed or renamed")
                continue
            for k in ("type", "slot", "word", "bit", "length", "strip"):
                if bf.get(k) != f.get(k) and not (bf.get(k) is None and f.get(k) is None):
                    if str(bf.get(k)) != str(f.get(k)):
                        errs.append(f"'{bf['name']}' is locked (from {base['name']}): its {k} "
                                    f"cannot change")
                        break
    known = {}
    for o in others:
        for f in o["fields"]:
            known.setdefault(f["name"], (INFLUX_TYPE[f["type"]], o["terminal"], o["name"]))
    for n, f in names.items():
        if n in known and f.get("type") in INFLUX_TYPE and INFLUX_TYPE[f["type"]] != known[n][0]:
            errs.append(f"'{n}' is already stored in InfluxDB as {known[n][0]} "
                        f"({known[n][1]} {known[n][2]}); it cannot become "
                        f"{INFLUX_TYPE[f['type']]}")
    return errs


# ── Decoding ─────────────────────────────────────────────────────────────────
class Decoder:
    """Pre-compiled decoder for one version. decode() returns {field: value}
    with exactly the Python types the old scripts produced."""

    def __init__(self, version):
        self.version_id = version["id"]
        self.name = version["name"]
        self.packet_size = int(version["packet_size"])
        self.min_size = min_size(version["fields"])
        self.ops = []
        for f in version["fields"]:
            t = f["type"]
            if t == "BIT":
                self.ops.append((f["name"], "B", int(f["word"]) * 4, 1 << int(f["bit"]), None))
            elif t == "TEXT":
                a, z = field_span(f)
                self.ops.append((f["name"], "T", a, z, f.get("strip", "both")))
            else:
                self.ops.append((f["name"], "f" if t == "REAL" else "I", int(f["slot"]) * 4,
                                 None, None))
        self.float_fields = [f["name"] for f in version["fields"] if f["type"] == "REAL"]

    def decode(self, data: bytes):
        """Returns (fields, dropped) - dropped lists REAL fields that were NaN/inf
        (InfluxDB refuses those, so they are left out instead of losing the packet)."""
        out, dropped = {}, []
        unpack = struct.unpack_from
        for name, kind, off, arg, strip in self.ops:
            if kind == "f":
                v = unpack(">f", data, off)[0]
                if math.isfinite(v):
                    out[name] = v
                else:
                    dropped.append(name)
            elif kind == "I":
                out[name] = int(unpack(">I", data, off)[0])
            elif kind == "B":
                out[name] = int(bool(unpack(">I", data, off)[0] & arg))
            else:
                s = data[off:arg].decode(errors="replace")
                out[name] = s.strip() if strip == "both" else s.rstrip()
        return out, dropped


def decode_preview(version, data: bytes):
    """Field-by-field view for the Packet X-ray / 'test on live data'."""
    rows = []
    for f in version["fields"]:
        span = field_span(f) or (int(f["word"]) * 4, int(f["word"]) * 4 + 4)
        if span[1] > len(data):
            rows.append({**f, "value": None, "raw": "", "problem": "beyond packet end"})
            continue
        single = Decoder({"id": 0, "name": "", "packet_size": 0, "fields": [f]})
        vals, dropped = single.decode(data)
        rows.append({**f, "value": vals.get(f["name"]),
                     "raw": data[span[0]:span[1]].hex(" "),
                     "problem": "not a finite number (left out)" if dropped else ""})
    return rows
