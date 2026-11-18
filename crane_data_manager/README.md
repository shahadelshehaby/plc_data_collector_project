# Crane Data Manager

One platform on the collector PC that **collects, protects, shows and exports** the crane PLC
data of Terminals 2, 3 and 4. It replaces the per-crane collector scripts
(`typingtensions_updatedv2 / v2.1 / v3 / v4.py`), the Excel launcher list and the console
status screen.

**InfluxDB is not changed:** same bucket (`Crane_Telemetry`), measurement
(`crane_telemetry`), tag (`crane_id`), field names and field types as the old scripts. Gantry
Watch, FDD Evaluation and your InfluxDB notebooks keep working. This is checked
automatically against the original scripts (`tests/test_layouts.py`: 108 / 127 / 100 / 89
fields for Retrofit v2 / Retrofit v2.1 / ZPMC v3 / New v4).

## PLC programs

Packet versions belong to the crane's **PLC program**, not to the terminal:

| Program | Cranes | Versions (baseline = old script) |
|---|---|---|
| **Retrofit** | T2 lanes A–E (A201 … E211, except A213 and A214) | v2, v2.1 |
| **New** | T2 lane F (F201 … F210), A213, A214 and all of T4 | v4 |
| **ZPMC** | T3 (A301 … E310) | v3 |

The platform knows which program each crane is expected to run (Configuration → System;
`program_rules` in `settings.json`). It uses this to pre-select versions and to warn when a
crane is given another program's version. Lane sizes follow the crane roster: T2 A 14,
B 14, C 12, D 11, E 11, F 10; T3 10 per lane; T4 7 per lane.

```
Crane PLCs ──UDP──► Westermo ──► COLLECTOR PC (192.168.100.237)
                                  ├─ CraneDataCollector  (Windows service, always on)
                                  │    one listener per crane port, IP lock, packet versions,
                                  │    outage buffer, alarms, insights
                                  ├─ CraneDataPlatform   (Windows service)  http://127.0.0.1:5300
                                  │    the web page + watchdog that restarts the collector
                                  └─ Notifier            (starts at sign-in) desktop pop-ups
                                              │
                                              ▼
                                  InfluxDB on the NAS (192.168.100.218:8089) - unchanged
```

## Install (once, on the collector PC)

1. Copy this folder to e.g. `C:\CraneDataManager\`. Avoid the Desktop: the services run
   without a signed-in user.
2. Install Python 3.10+ ("Add python.exe to PATH").
3. Create `influx_token.txt` in the folder with the InfluxDB token on one line.
   **Never upload this file to GitHub.** The `.gitignore` already excludes it.
4. Copy `nssm.exe` into the folder (the one from `terminal2_collector`, or from
   https://nssm.cc/download → `win64\nssm.exe`).
5. Right-click `install_service.bat` → **Run as administrator**.
   It installs the packages, both services and the notifier, then opens the page.
   It offers to stop and disable the old `CraneCollectorT2` service; it does not remove it.

`run.bat` opens the page. If the services are not installed, it starts a test mode in
two windows instead.

## Moving over, one terminal at a time

The new collector opens the UDP port of every crane **registered in the platform**. An old
collector that still holds a port makes that crane show **Port busy** until the old one stops.
After that, the new collector takes the port over by itself within 10 seconds.

1. **Configuration → Cranes → Download template.** The template is pre-filled with every
   crane, port and program from your current collectors. Fill in each PLC's **IP**.
   F202 and F209 are T2 cranes running the New program (v4).
2. Delete the T3/T4 rows for now (or set *Enabled* = No), then **Import Excel…** →
   check the preview → apply.
3. Stop the old T2 collectors (the installer offers to). Check **Live Status**: T2 cranes go
   OK or *Idle / no data*.
4. Repeat for T3, then T4: import their rows and close their CMD windows.

## Daily use

| Tab | What it is for |
|---|---|
| **Live Map** | The **Crane Yard** live twin, in the Engineering City look. *Yard*: an isometric 3D yard with every lane's rails and container stacks, and every crane as a 3D ARMG at its live gantry position. Trolley, hoist, spreader and container move too. A roof beacon shows health and a girder band shows the program. Each real packet flows as a light dot from the crane over the Westermo router to the collector building, and on to the NAS. Blocked intruder packets stop in red at the IP-lock gate. Side panels: terminals and lanes (live/registered, show or hide), collector status, live events. Scroll to zoom, drag to move. *Data path*: every crane in a list, linked to Westermo → collector → InfluxDB. *Replay*: play a past period back on the 3D yard. Hover a crane for a summary, click it for its panel. |
| **Live Status** | The console table, live (updates every 1.5 s), sortable, with filters. |
| **Alarms & Events** | Active alarms (acknowledge with a note; one-click *Switch version* for wrong-size packets) and 90 days of history, CSV download. |
| **Dashboard** | Per terminal and day: cranes onboarded, versions in use, packets, Auto hours, moves, data-quality score, coverage grid (lanes × cranes), insights. *Yesterday* = daily digest. |
| **Data Explorer** | Pick cranes, time and field groups → chart or table. |
| **Query** | Smart search (`E208 hoist current yesterday 10-12`), a query builder without Flux, saved queries, templates and a read-only Flux box. |
| **Export** | Excel/CSV with every option: cranes, range plus a daily time window, fields, resolution (raw or averaged), one file per crane-day (Gantry Watch naming) / one sheet per crane / combined, Dubai time or InfluxDB-style `_time`. Runs in the background. |
| **Configuration** | Cranes (manual or Excel with preview), packet versions, collector, notifications, InfluxDB, system (self-test, backups, change log, port rules). |

**Crane panel** (click any crane): state, port, registered IP, version, packets/min, last
packet and size, blocked IPs, PLC clock drift, live values, 15-minute sparklines, insights,
events. Actions: stop/start writing, change version, edit, **Packet X-ray** (raw hex and the
decoded value of every field), open in Data Explorer, export today.

### Crane states

| State | Meaning |
|---|---|
| OK | Packets from the registered IP, written to InfluxDB. |
| Idle / no data | No packet for 10 s. **Normal**: a PLC only sends in Auto, without manual intervention, with a work order active. Never an alarm. |
| OFF | Writing switched off in the platform. The port is still listened to, so you still see whether the crane sends. Nothing is written. |
| IP conflict | Another IP sends to this crane's port. **Those packets are blocked (not written)**; the crane itself keeps being collected. The alarm says which crane the IP belongs to, when it is in the register. |
| Wrong size | Packet size ≠ the crane's version. Longer packets are still written (extra bytes ignored); shorter ones cannot be decoded and are not written. The alarm suggests the matching version. |
| Port busy | Another program holds the UDP port (old collector?). Retried every 10 s. |
| Buffering | InfluxDB/NAS unreachable. Data is kept on disk (`data\buffer.db`) and sent in time order when InfluxDB is back. |
| Missing IP / No version | The register entry is incomplete; nothing is written. |

**Alarms** (banner, sound, alarm list, Windows pop-up): IP conflict, wrong size, parse error,
port busy, InfluxDB write failure, collector service down, disk almost full. An alarm clears
itself once the problem is gone (after 2 minutes for crane alarms) and stays in the history.

### Safety on critical actions

Stopping writing, changing a version, IP or port, importing, refreshing, restoring and
restarting all open a confirmation that shows exactly what will change and **requires a
reason**. Some also require a typed word:

| Action | Type |
|---|---|
| Stop one crane | the crane ID |
| Stop several cranes | `STOP <n>` |
| Stop every crane | `STOP ALL` |
| Restart the collector service | `RESTART` |
| Restore a backup | `RESTORE` |

The server checks these as well, not only the page. Every change is written to the change
log with before/after. A configuration backup is saved before each change (last 50 kept,
one-click restore).

**Applying changes:** a confirmed change reloads **only the affected cranes**. An IP, version or
on/off change has no gap at all. A port change re-opens that one port. *Refresh collector*
reloads everything that changed. If the collector service was down, it uses the saved
settings when it starts.

## Packet versions (when the PLC sends new data)

Configuration → Packet versions (grouped by program) → pick the current version (e.g.
Retrofit v2.1) → **New version from v2.1**.

1. Name it (e.g. `v2.2`) and describe what changed.
2. Add one row per new value: field name, type (REAL / DINT / DWORD / BIT of a status word /
   TEXT), slot (index in the PLC `BufferConvert` array) or status word + bit, group, unit.
   The editor shows the next free slot and the free bits, and draws the packet map.
3. **Test on live data**: decodes a crane's latest real packet with the new version, so you
   see the new values before anything is saved.
4. Choose the cranes that run it (one by one, or *All Retrofit cranes*).
5. **Save & apply**: only those cranes reload.

Rules that keep InfluxDB consistent:
- Fields from the previous version are **locked**: they cannot be renamed, moved or removed.
- A field name that exists anywhere must keep its InfluxDB type. For example, `LoadCellLWS`
  is a float in ZPMC, so it cannot become an integer elsewhere; InfluxDB would reject the data.
- The packet size is calculated from the fields (you can override it).

## Intelligence (offline, plain Python)

- **Data quality score** per crane per day (not-written packets, wrong sizes, repeated PLC
  seconds, gaps, blocked IPs, PLC clock drift).
- **Insights** (shown, not alarmed): twin drives differing, position sensor stuck while
  moving, encoder disagreement, load-cell imbalance, values unusually high for *that* crane
  (learned baseline), frozen data, PLC clock off.
- **Conflict detective**: tells which registered crane an intruder IP belongs to.
- **Version suggestion** from the packet size.
- **Smart search** in the Query tab.
- Ready for a local chat assistant later.

## Files

| Path | What |
|---|---|
| `collector_service.py`, `cdm/collector.py` | collector service |
| `app.py` | platform (Flask + waitress, port 5300, localhost only) |
| `notifier.py` | desktop pop-ups |
| `cdm/layouts.py` | packet versions; baselines = the old scripts |
| `cdm/registry.py` | crane register, port rule, Excel template/import, backups |
| `cdm/influx.py` | InfluxDB writer + outage buffer, health |
| `cdm/query.py`, `cdm/exporter.py`, `cdm/smart.py` | queries, exports, smart search |
| `cdm/insights.py`, `cdm/dashboard.py` | insights, quality score, dashboard |
| `static/` | the page (no internet needed) |
| `settings.json` | created on first start (InfluxDB address, ports, terminals) |
| `data/manager.db` | register, versions, alarms/events (90 days), change log, daily figures |
| `data/buffer.db` | outage buffer |
| `data/config_backups/`, `data/exports/` | backups, finished exports (last 20) |
| `logs/` | `collector.log`, one log per crane (one summary line per minute + warnings), `platform.log` |
| `tools/simulator.py`, `tools/fake_influx.py` | test tools (fake PLCs, stand-in InfluxDB) |

Port rule used for the consistency check (Configuration → System):
port = base + (crane number − 1) × number of lanes + lane position (A = 1).
T2: 12200, lanes A–F. T3/T4: 12300/12400, lanes A–E. It is advisory only; your list is the
master.

The Engineering Building status page is at `http://127.0.0.1:5300/building/status`.

## Troubleshooting

- **Configuration → System → Self-test** checks the service, InfluxDB, token, ports,
  buffer, disk and register.
- A crane on *Port busy*: another program holds the port. In PowerShell, run
  `Get-NetUDPEndpoint -LocalPort 12247 | Select OwningProcess`, then stop that process.
- InfluxDB unreachable: nothing is lost. The buffer fills, and it empties by itself in time
  order once InfluxDB is back.
- Tests: `python -m unittest discover -s tests`.
