"""
fake_influx.py - a stand-in InfluxDB for testing without the NAS.

Accepts writes (/api/v2/write) and answers /health. Lines are appended to
tools/fake_influx_lines.txt. Start/stop it to test the outage buffer.

    python tools\\fake_influx.py --port 8089
"""
import argparse
import gzip
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

OUT = Path(__file__).resolve().parent / "fake_influx_lines.txt"


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _ok(self, code=204, body=b""):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._ok(200, b'{"name":"influxdb","message":"ready for queries and writes",'
                          b'"status":"pass","version":"fake"}')
        else:
            self._ok(404, b"{}")

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        if self.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
        if self.path.startswith("/api/v2/write"):
            with OUT.open("ab") as fh:
                fh.write(body.rstrip(b"\n") + b"\n")
            self._ok(204)
        else:
            self._ok(404, b"{}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8089)
    a = ap.parse_args()
    print(f"fake InfluxDB on :{a.port}, writing to {OUT}")
    ThreadingHTTPServer(("127.0.0.1", a.port), H).serve_forever()
