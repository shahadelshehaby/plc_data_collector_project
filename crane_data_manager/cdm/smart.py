"""
smart.py - the smart search box (plain rules, fully offline).

    "E208 hoist current yesterday 10-12"
    "C210 C207 gantry speed last 3 hours every 1m"
    "T2 anti-collision today"
    "B308 load cells 17.11 08:00-09:30"

-> a query spec (cranes, fields, start, stop, window) + a short explanation.
"""
import re
from datetime import datetime, timedelta

from . import config as C
from . import query, registry

MOTIONS = {"gantry": "GANTRY", "trolley": "TROLLEY", "hoist": "HOIST", "spreader": None,
           "cable reel": "PCR", "pcr": "PCR"}
MEASURES = {"current": ["current"], "voltage": ["voltage"], "torque": ["torque"],
            "speed": ["speed", "spd"], "reference": ["ref"], "ref": ["ref"],
            "limit": ["lim"], "position": ["__pos__"], "pos": ["__pos__"]}
GROUP_WORDS = {"load cell": "Load cells", "load": "Load cells", "anti-collision": "Anti-collision",
               "anticollision": "Anti-collision", "anti collision": "Anti-collision",
               "brake": "Brakes", "status": "Crane state", "job": "Job & automation",
               "work order": "Job & automation", "workorder": "Job & automation",
               "step": "Job & automation", "neighbour": "Neighbour cranes",
               "spreader": "Spreader", "voltage": "Drive voltages", "current": "Drive currents",
               "container": "Text", "plc time": "Text"}
POS_RE = re.compile(r"^In_(GANTRY\d?|TROLLEYPOMUX|TROLLEYENC|HOIST)$")


def _times(t, now):
    day0 = now.replace(hour=0, minute=0, second=0, microsecond=0)
    start = stop = None
    expl = []
    m = re.search(r"last\s+(\d+)\s*(min|minute|minutes|h|hour|hours|d|day|days)\b", t)
    if m:
        n, u = int(m.group(1)), m.group(2)[0]
        delta = {"m": timedelta(minutes=n), "h": timedelta(hours=n), "d": timedelta(days=n)}[u]
        start, stop = now - delta, now
        expl.append(f"last {n} {m.group(2)}")
    day = None
    if re.search(r"\byesterday\b", t):
        day = day0 - timedelta(days=1)
        expl.append("yesterday")
    elif re.search(r"\btoday\b", t):
        day = day0
        expl.append("today")
    elif re.search(r"\b(this|last)\s+week\b", t):
        start, stop = day0 - timedelta(days=6), now
        expl.append("last 7 days")
    m = re.search(r"\b(20\d\d)-(\d\d)-(\d\d)\b", t) or None
    if m:
        day = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), tzinfo=C.LOCAL_TZ)
    else:
        m = re.search(r"\b(\d{1,2})[./](\d{1,2})(?:[./](20\d\d))?\b", t)
        if m and not re.search(r"\d[./]\d+\s*(?:s|m|min|h)\b", m.group(0)):
            try:
                day = datetime(int(m.group(3) or now.year), int(m.group(2)), int(m.group(1)),
                               tzinfo=C.LOCAL_TZ)
            except ValueError:
                day = None
    if day is not None and day.date() != now.date() and "yesterday" not in expl:
        expl.append(day.strftime("%d.%m.%Y"))
    rng = re.search(r"(?:from\s+)?\b(\d{1,2})(?::(\d\d))?\s*(?:-|to|until)\s*(\d{1,2})(?::(\d\d))?\b",
                    t)
    if rng and int(rng.group(1)) <= 24 and int(rng.group(3)) <= 24:
        base = day or day0
        h1, m1 = int(rng.group(1)), int(rng.group(2) or 0)
        h2, m2 = int(rng.group(3)), int(rng.group(4) or 0)
        start = base.replace(hour=h1 % 24, minute=m1)
        stop = base.replace(hour=h2 % 24, minute=m2)
        if stop <= start:
            stop += timedelta(days=1)
        expl.append(f"{h1:02d}:{m1:02d}-{h2:02d}:{m2:02d}")
    elif day is not None and start is None:
        start, stop = day, min(day + timedelta(days=1), now) if day.date() == now.date() \
            else day + timedelta(days=1)
    if start is None:
        start, stop = now - timedelta(hours=1), now
        expl.append("last hour")
    return start, stop, expl


def parse(text):
    t = (text or "").strip()
    low = t.lower()
    now = C.local_now()
    known = {c["crane"]: c for c in registry.list_cranes()}
    cranes = [c for c in dict.fromkeys(x.upper() for x in re.findall(r"\b[A-Za-z]\d{3}\b", t))
              if c in known]
    for m in re.finditer(r"\b(?:t|terminal\s*)([234])\b", low):
        cranes += [c for c, v in known.items() if v["terminal"] == f"T{m.group(1)}"]
    cranes = list(dict.fromkeys(cranes))
    cat = query.field_catalog(cranes or None)
    fields = []
    for name in cat:                                       # field names typed as-is
        if re.search(rf"\b{re.escape(name.lower())}\b", low):
            fields.append(name)
    motions = [v for k, v in MOTIONS.items() if k in low]
    measures = [v for k, v in MEASURES.items() if re.search(rf"\b{k}s?\b", low)]
    if measures:
        for name in cat:
            n = name.lower()
            for mv in measures:
                for token in mv:
                    hit = POS_RE.match(name) if token == "__pos__" else token in n
                    if hit and (not motions or any(mo and mo.lower() in n for mo in motions)):
                        fields.append(name)
    elif motions:
        for name, f in cat.items():
            if any(mo and mo.lower() in name.lower() for mo in motions) and \
                    f["group"] in ("Gantry", "Trolley", "Hoist", "Power cable reel"):
                fields.append(name)
    for word, group in GROUP_WORDS.items():
        if word in low and not (word in ("current", "voltage") and measures):
            if word == "spreader" and measures:
                continue
            fields += [n for n, f in cat.items() if f["group"] == group]
    fields = list(dict.fromkeys(fields))
    window = "raw"
    m = re.search(r"\b(?:every|per|avg|average)\s*(\d+)?\s*(s|sec|m|min|minute|h|hour)\b", low)
    if m:
        n = m.group(1) or "1"
        unit = {"s": "s", "sec": "s", "m": "m", "min": "m", "minute": "m", "h": "h",
                "hour": "h"}[m.group(2)]
        cand = f"{n}{unit}"
        window = cand if cand in query.WINDOWS else "1m"
    start, stop, texpl = _times(low, now)
    if (stop - start).total_seconds() > 6 * 3600 and window == "raw":
        window = "1m"
        texpl.append("averaged per minute (long range)")
    expl = []
    expl.append("cranes: " + (", ".join(cranes) if cranes else "none recognised"))
    expl.append(f"fields: {len(fields)}" + (f" ({', '.join(fields[:6])}"
                                             f"{'…' if len(fields) > 6 else ''})" if fields
                                             else " (none recognised - all fields)"))
    expl.append("time: " + ", ".join(texpl))
    fmt = "%Y-%m-%dT%H:%M"
    return {"cranes": cranes, "fields": fields, "start": start.strftime(fmt),
            "stop": stop.strftime(fmt), "window": window, "fn": "mean",
            "explanation": " · ".join(expl)}
