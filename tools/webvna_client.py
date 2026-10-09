"""Tiny WebVNA automation client.

Setup:   pip install websockets
Run:     node tools/ws-bridge.mjs            (in one terminal)
         open WebVNA > Script tab > Automation bridge > enable   (the page must stay open)
         python tools/webvna_client.py [ws://127.0.0.1:8765/client[?token=SECRET]]

call(method, **params) forwards to window.webvna.<method> and returns the result; a failure raises WebVNAError.
Non-finite numbers arrive as the strings "Infinity" / "-Infinity" (NaN as None); use as_float() for those.
"""
import itertools
import json
import sys

from websockets.sync.client import connect


class WebVNAError(Exception):
    pass


def as_float(v):
    return float("nan") if v is None else float(v)


class WebVNA:
    def __init__(self, url="ws://127.0.0.1:8765/client", timeout=120):
        self.ws = connect(url, max_size=32 * 1024 * 1024)
        self.timeout = timeout
        self.ids = itertools.count(1)
        self.events = []  # events received while waiting for a reply

    def call(self, method, **params):
        rid = next(self.ids)
        self.ws.send(json.dumps({"id": rid, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv(timeout=self.timeout))
            if "event" in msg:
                self.events.append(msg)
            elif msg.get("id") == rid:
                if "error" in msg:
                    raise WebVNAError(msg["error"].get("message", str(msg["error"])))
                return msg.get("result")

    def close(self):
        self.ws.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


if __name__ == "__main__":
    url = sys.argv[1] if len(sys.argv) > 1 else "ws://127.0.0.1:8765/client"
    with WebVNA(url) as vna:
        vna.call("connectSimulator", model="nanovna-h", dut="antenna")
        vna.call("setStimulus", start=400e6, stop=470e6, points=101)
        data = vna.call("sweep")
        swr = vna.call("trace", i=1)  # trace 1 shows SWR by default
        values = [as_float(v) for v in swr["values"]]
        best = min(range(len(values)), key=values.__getitem__)
        print(f"{len(data)} points, minimum SWR {values[best]:.2f} at {swr['freqs'][best] / 1e6:.2f} MHz")
