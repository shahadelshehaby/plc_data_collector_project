"""
notifier.py - Windows desktop pop-ups for new alarms.

Windows services cannot show pop-ups on the desktop, so this small program
runs in your Windows session (started at sign-in by install_service.bat,
or by start_notifier.bat). It asks the platform for active alarms every
5 seconds and shows a Windows notification for each new one. It also warns
if the platform or the collector service cannot be reached.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdm import config as C  # noqa: E402
from cdm import ctl  # noqa: E402

SEEN_FILE = C.DATA_DIR / "notified.json"
PS_TOAST = r"""
$ErrorActionPreference = 'Stop'
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
  $t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $n = $t.GetElementsByTagName('text')
  $n.Item(0).AppendChild($t.CreateTextNode($env:CDM_TITLE)) > $null
  $n.Item(1).AppendChild($t.CreateTextNode($env:CDM_TEXT)) > $null
  $app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($t))
} catch {
  msg * /time:300 "$($env:CDM_TITLE): $($env:CDM_TEXT)"
}
"""


def popup(title, text):
    print(time.strftime("%H:%M:%S"), title, "-", text)
    if os.name != "nt":
        return
    env = dict(os.environ, CDM_TITLE=title[:120], CDM_TEXT=text[:400])
    try:
        subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
                        PS_TOAST], env=env, timeout=30, capture_output=True,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError):
        pass


def load_seen():
    try:
        return set(json.loads(SEEN_FILE.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return set()


def save_seen(seen):
    try:
        SEEN_FILE.write_text(json.dumps(sorted(seen)[-2000:]), encoding="utf-8")
    except OSError:
        pass


def main():
    seen = load_seen()
    platform_down_since, warned_platform = None, False
    first = True
    while True:
        s = C.load_settings()
        url = f"http://127.0.0.1:{s['platform_port']}/api/alarms/active"
        try:
            with urllib.request.urlopen(url, timeout=5) as r:
                alarms = json.loads(r.read())
            if warned_platform:
                popup("Crane Data Manager", "The platform is reachable again.")
            platform_down_since, warned_platform = None, False
            if s.get("desktop_popups", True):
                types = set(s.get("popup_types") or [])
                for a in alarms:
                    if a["id"] in seen:
                        continue
                    seen.add(a["id"])
                    if (not first or time.time() - a["ts"] < 600) and \
                            (not types or a["type"] in types) and not a.get("acked"):
                        where = a.get("crane") or "Collector"
                        popup(f"Crane alarm: {where} - {a['type'].replace('_', ' ')}",
                              a["message"])
                save_seen(seen)
            first = False
        except Exception:                                   # noqa: BLE001
            platform_down_since = platform_down_since or time.time()
            if time.time() - platform_down_since > 60 and not warned_platform:
                warned_platform = True
                try:
                    ctl.ping()
                    popup("Crane Data Manager", "The platform page is not reachable, but the "
                          "collector service is still collecting.")
                except ctl.CollectorDown:
                    popup("Crane Data Manager - COLLECTOR DOWN", "Neither the platform nor the "
                          "collector service answers. Data is NOT being collected.")
        time.sleep(5)


if __name__ == "__main__":
    main()
