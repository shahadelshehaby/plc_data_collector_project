"""
insights.py
===========
Offline "intelligence" in plain Python. Runs inside the collector on every
packet (cheap, constant memory) and reports *insights*, not alarms:
things an engineer may want to look at.

Rules (each one only runs when the crane's version has the fields it needs):
  TWIN_DRIVE      the two drives of one motion differ a lot while running
  STUCK_SENSOR    speed says moving, position does not change
  ENCODER_DIFF    two position measurements of the same motion disagree
  LOAD_IMBALANCE  one load cell carries most / almost none of the load
  UNUSUAL_HIGH    value far above what this crane normally shows (learned)
  FROZEN_DATA     every measurement identical for many packets in a row
  CLOCK_DRIFT     PLC clock differs from the collector PC by more than a minute
"""
import math

EMIT_EVERY = 600            # same insight for the same crane at most every 10 min
SUSTAIN = 10                # condition must hold for this many packets in a row

TWINS = [("Gantry", "In_GANTRYCurrent1", "In_GANTRYCurrent2"),
         ("Hoist", "In_HOISTCurrent1", "In_HOISTCurrent2"),
         ("Trolley", "In_TROLLEYCurrent1", "In_TROLLEYCurrent2")]
MOTIONS = [("Gantry", "In_GANTRY1", "GANTRYSPEED1"),
           ("Trolley", "In_TROLLEYPOMUX", "TROLLEYSPEED1"),
           ("Hoist", "In_HOIST", "HOISTSPEED1")]
ENCODERS = [("Gantry", "In_GANTRY1", "In_GANTRY2", 2.0),
            ("Trolley", "In_TROLLEYPOMUX", "In_TROLLEYENC", 1.0)]
LOADCELLS = [("In_RIGHTLC", "In_LEFTLC", "In_NEARSLC", "In_FARSLC"),
             ("LoadCellLWS", "LoadCellLLS", "LoadCellRWS", "LoadCellRLS")]
LEARNED = ["In_GANTRYCurrent1", "In_GANTRYCurrent2", "In_HOISTCurrent1", "In_HOISTCurrent2",
           "In_TROLLEYCurrent1", "In_TROLLEYCurrent2", "GantryTorque1", "GantryTorque2",
           "HoistTorque1", "HoistTorque2", "TrolleyTorque1", "PCR_Current"]
LEARN_MIN = 3600            # packets before a learned baseline is trusted (~1 h of Auto)


class _Stat:
    """Exponentially weighted mean / variance (slowly adapting baseline)."""
    __slots__ = ("n", "mean", "var")

    def __init__(self):
        self.n, self.mean, self.var = 0, 0.0, 0.0

    def add(self, x, alpha=0.0005):
        self.n += 1
        if self.n == 1:
            self.mean = x
            return
        a = max(alpha, 1.0 / self.n)
        d = x - self.mean
        self.mean += a * d
        self.var = (1 - a) * (self.var + a * d * d)

    @property
    def sd(self):
        return math.sqrt(self.var)


class CraneInsights:
    def __init__(self, crane):
        self.crane = crane
        self.count = {}
        self.last_emit = {}
        self.stats = {k: _Stat() for k in LEARNED}
        self.prev = None
        self.frozen = 0

    def _hold(self, key, cond):
        self.count[key] = self.count.get(key, 0) + 1 if cond else 0
        return self.count[key] >= SUSTAIN

    def _emit(self, out, key, now, msg, value):
        if now - self.last_emit.get(key, 0) >= EMIT_EVERY:
            self.last_emit[key] = now
            out.append((key.split(":")[0], msg, value))

    def update(self, f, now, drift=None):
        out = []
        c = self.crane
        for name, a, b in TWINS:
            if a in f and b in f:
                va, vb = abs(f[a]), abs(f[b])
                hi = max(va, vb)
                cond = hi > 15 and abs(va - vb) / hi > 0.35
                if self._hold(f"TWIN_DRIVE:{name}", cond):
                    self._emit(out, f"TWIN_DRIVE:{name}", now,
                               f"{c}: {name} drives differ - {a} {f[a]:.1f} vs {b} {f[b]:.1f}",
                               abs(va - vb))
        if self.prev:
            for name, pos, spd in MOTIONS:
                if pos in f and spd in f and pos in self.prev:
                    cond = abs(f[spd]) > 5 and abs(f[pos] - self.prev[pos]) < 0.001
                    if self._hold(f"STUCK_SENSOR:{name}", cond):
                        self._emit(out, f"STUCK_SENSOR:{name}", now,
                                   f"{c}: {name} speed {f[spd]:.1f} but {pos} is not changing "
                                   f"({f[pos]:.2f}) - position sensor stuck?", f[spd])
        for name, a, b, limit in ENCODERS:
            if a in f and b in f and f[a] and f[b]:
                d = abs(f[a] - f[b])
                if self._hold(f"ENCODER_DIFF:{name}", d > limit):
                    self._emit(out, f"ENCODER_DIFF:{name}", now,
                               f"{c}: {name} positions disagree by {d:.2f} m ({a} {f[a]:.2f}, "
                               f"{b} {f[b]:.2f})", d)
        for group in LOADCELLS:
            if all(k in f for k in group):
                vals = [f[k] for k in group]
                tot = sum(vals)
                cond = tot > 10 and (max(vals) > 0.6 * tot or min(vals) < 0.05 * tot)
                if self._hold("LOAD_IMBALANCE", cond):
                    self._emit(out, "LOAD_IMBALANCE", now,
                               f"{c}: unbalanced load - " + ", ".join(
                                   f"{k} {v:.1f}" for k, v in zip(group, vals)), max(vals) / tot)
        for k, st in self.stats.items():
            if k not in f:
                continue
            x = abs(f[k])
            if st.n > LEARN_MIN and st.sd > 0.5:
                limit = st.mean + 6 * st.sd
                if self._hold(f"UNUSUAL_HIGH:{k}", x > limit and x > 20):
                    self._emit(out, f"UNUSUAL_HIGH:{k}", now,
                               f"{c}: {k} is unusually high ({x:.1f}; this crane usually "
                               f"{st.mean:.1f} ± {st.sd:.1f})", x)
            if x > 0.5:                     # learn from the crane actually running
                st.add(x)
        reals = tuple(v for v in f.values() if isinstance(v, float))
        prev_reals = getattr(self, "_prev_reals", None)
        self.frozen = self.frozen + 1 if reals and reals == prev_reals else 0
        self._prev_reals = reals
        if self.frozen >= 60:
            self._emit(out, "FROZEN_DATA", now, f"{c}: all measurements identical for "
                       f"{self.frozen} packets - PLC may be sending a stale buffer", self.frozen)
        if drift is not None and abs(drift) > 60:
            self._emit(out, "CLOCK_DRIFT", now,
                       f"{c}: PLC clock is {drift:+.0f} s off the collector PC", drift)
        self.prev = {k: f[k] for _, k, _ in MOTIONS if k in f}
        return out


def quality_score(stats: dict) -> dict:
    """Data quality 0-100 for one crane-day from its daily counters."""
    rx = stats.get("received") or 0
    if not rx:
        return {"score": None, "notes": ["no data"]}
    score, notes = 100.0, []
    written = stats.get("written") or 0
    lost = max(0, rx - written) / rx
    if lost > 0.001:
        score -= min(40, lost * 400)
        notes.append(f"{lost:.1%} of packets not written")
    for key, label, weight in (("wrong_size", "wrong-size packets", 300),
                               ("parse_err", "parse errors", 300),
                               ("dup_sec", "repeated PLC seconds", 60),
                               ("gaps", "short gaps", 20)):
        v = stats.get(key) or 0
        if v:
            r = v / rx
            score -= min(25, r * weight)
            notes.append(f"{v} {label}")
    if stats.get("dropped_ip"):
        score -= 10
        notes.append(f"{stats['dropped_ip']} packets from a wrong IP blocked")
    if (stats.get("max_drift") or 0) > 60:
        score -= 10
        notes.append(f"PLC clock off by up to {stats['max_drift']:.0f} s")
    return {"score": max(0, round(score)), "notes": notes}
