"""
Checks that the baseline versions reproduce the original collector scripts
exactly: same field names, same slots / bits, same InfluxDB types.

    python -m unittest discover -s tests      (from the crane_data_manager folder)
"""
import re
import struct
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from cdm import layouts as L   # noqa: E402

REPO = HERE.parent.parent
SCRIPTS = {
    ("T2", "v2"): REPO / "typingtensions_updatedv2.py",
    ("T2", "v2.1"): REPO / "typingtensions_updatedv2.1.py",
    ("T3", "v3"): REPO / "typingtensions_updatedv3.py",
    ("T4", "v4"): REPO / "typingtensions_updatedv4.py",
}


def parse_script(path: Path):
    """Read an old collector script and return {field: (type, slot_or_(word,bit))}
    for every field it writes to InfluxDB."""
    src = path.read_text(encoding="utf-8", errors="replace")
    reals = {n: int(s) for n, s in re.findall(
        r"^\s*(\w+)\s*=\s*struct\.unpack\('>f',\s*data\[(\d+)\s*\*\s*4", src, re.M)}
    dints = {n: int(s) for n, s in re.findall(
        r"^\s*(\w+)\s*=\s*int\(struct\.unpack\('>I',\s*data\[(\d+)\s*\*\s*4", src, re.M)}
    dwords = {n: int(s) for n, s in re.findall(
        r"^\s*(\w+)\s*=\s*struct\.unpack\('>I',\s*data\[(\d+)\s*\*\s*4", src, re.M)}
    bits = {n: (dwords[w], int(b)) for n, w, b in re.findall(
        r"^\s*(\w+)\s*=\s*bool\((\w+)\s*&\s*\(1\s*<<\s*(\d+)\)\)", src, re.M) if w in dwords}
    call = re.search(r"point = build_point\((.*?)\n\s*\)\n", src, re.S).group(1)
    written = set(re.findall(r"^\s*(\w+)\s*=", call, re.M))
    written |= set(re.findall(r'point\.field\("(\w+)"', src))
    out = {}
    for n in written:
        if n in reals:
            out[n] = ("REAL", reals[n])
        elif n in dints:
            out[n] = ("DINT", dints[n])
        elif n in dwords:
            out[n] = ("DWORD", dwords[n])
        elif n in bits:
            out[n] = ("BIT", bits[n])
        elif n in ("PLCTime", "ContainerID"):
            out[n] = ("TEXT", 16 if n == "PLCTime" else 51)
        else:
            out[n] = ("?", None)
    return out


def baseline(term, name):
    for t, n, size, fn, _ in L.BASELINES:
        if (t, n) == (term, name):
            return {"id": 1, "name": n, "terminal": t, "packet_size": size, "fields": fn()}
    raise KeyError(name)


class TestBaselinesMatchScripts(unittest.TestCase):
    def test_fields_slots_types(self):
        for (term, name), path in SCRIPTS.items():
            if not path.exists():
                self.skipTest(f"{path.name} not found")
            want = parse_script(path)
            v = baseline(term, name)
            got = {}
            for f in v["fields"]:
                key = (f["word"], f["bit"]) if f["type"] == "BIT" else f["slot"]
                got[f["name"]] = (f["type"], key)
            with self.subTest(version=f"{term} {name}"):
                self.assertEqual(set(got), set(want),
                                 f"field set differs: missing={set(want) - set(got)} "
                                 f"extra={set(got) - set(want)}")
                for n in want:
                    self.assertEqual(got[n], want[n], f"{term} {name}: {n}")
                self.assertEqual(L.validate(v["fields"], v["packet_size"]), [])

    def test_sizes(self):
        self.assertEqual(L.min_size(baseline("T2", "v2")["fields"]), 344)
        self.assertEqual(L.min_size(baseline("T2", "v2.1")["fields"]), 364)
        self.assertEqual(L.min_size(baseline("T3", "v3")["fields"]), 340)
        self.assertEqual(L.min_size(baseline("T4", "v4")["fields"]), 340)

    def test_decode_types_and_text(self):
        v = baseline("T2", "v2.1")
        data = bytearray(364)
        struct.pack_into(">f", data, 7 * 4, 2291.3)
        struct.pack_into(">I", data, 72 * 4, 116)
        struct.pack_into(">I", data, 84 * 4, 6421)            # bits 0,2,4,8,11,12
        struct.pack_into(">I", data, 85 * 4, (1 << 0) | (1 << 17))
        data[64:83] = b"2026-10-02-09:08:40"
        data[204:215] = b"MNBU4519765"
        f, dropped = L.Decoder(v).decode(bytes(data))
        self.assertEqual(dropped, [])
        self.assertIsInstance(f["In_GANTRY1"], float)
        self.assertIsInstance(f["WorkorderIdent"], int)
        self.assertEqual(f["WorkorderIdent"], 116)
        self.assertEqual(f["PLCTime"], "2026-10-02-09:08:40")
        self.assertEqual(f["ContainerID"], "MNBU4519765")
        self.assertEqual([f[n] for n in ("ControlON", "Spreader20ft", "Spreader40ft",
                                          "SingleMode", "TwistlockUnlocked", "GantrySynchOk",
                                          "Gantry_obs_active")], [1, 0, 1, 1, 1, 1, 1])
        self.assertEqual(f["AutoActive"], 1)
        self.assertEqual(f["RailBrake2LeftReleased"], 1)
        self.assertEqual(f["StatusWord"], 6421)

    def test_nan_left_out(self):
        v = baseline("T3", "v3")
        data = bytearray(340)
        struct.pack_into(">f", data, 0, float("nan"))
        f, dropped = L.Decoder(v).decode(bytes(data))
        self.assertNotIn("In_TRIM", f)
        self.assertEqual(dropped, ["In_TRIM"])

    def test_validation_locks_and_types(self):
        base = baseline("T2", "v2")
        new = [dict(x) for x in base["fields"]]
        new[1] = {**new[1], "name": "RenamedTrim"}
        errs = L.validate(new, 344, base=base)
        self.assertTrue(any("locked" in e for e in errs))
        new = [dict(x) for x in base["fields"]] + [L._f("In_TRIM2", "REAL", 43)]
        self.assertEqual(L.validate(new, 344, base=base), [])
        new = [dict(x) for x in base["fields"]] + [L._f("In_TRIM3", "REAL", 0)]
        self.assertTrue(any("overlaps" in e for e in L.validate(new, 344, base=base)))
        other = baseline("T3", "v3")
        new = [dict(x) for x in base["fields"]] + [L._f("LoadCellLWS", "DINT", 43)]
        self.assertTrue(any("already stored" in e for e in
                            L.validate(new, 344, base=base, others=[other])))


if __name__ == "__main__":
    unittest.main()
