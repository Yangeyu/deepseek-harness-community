"""Offline JSONL executor fixture. No browser, network, or model dependencies."""
import json
from pathlib import Path
import signal
import sys
import time
from urllib.parse import parse_qs, urlsplit

marker = None
mode = "normal"
sequence = 0


def stop(_signum, _frame):
    raise SystemExit(0)


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    for line in sys.stdin:
        request = json.loads(line)
        op = request["op"]
        if op == "open":
            parsed = urlsplit(request["url"])
            query = parse_qs(parsed.query)
            marker = query.get("marker", [None])[0]
            mode = query.get("mode", ["normal"])[0]
            value = {"status": "opened", "origin": "https://example.com"}
        elif op == "observe":
            if mode == "pending":
                continue
            if mode == "crash":
                print("private account diagnostic", file=sys.stderr)
                raise SystemExit(1)
            sequence += 1
            value = {"observationId": str(sequence), "url": "https://example.com/", "title": "测试",
                     "text": "Result", "actions": [{"id": "e1", "kind": "click", "label": "Search"}], "omittedActions": 0}
        elif op == "act":
            print(json.dumps({"id": request["id"], "ok": False, "error": {"code": "uncertain", "message": "uncertain mutation; do not retry"}}), flush=True)
            continue
        elif op == "close":
            value = {"status": "closed"}
        else:
            raise RuntimeError("Unexpected operation")
        print(json.dumps({"id": request["id"], "ok": True, "value": value}), flush=True)
        if op == "close":
            break
finally:
    if marker:
        # Model a bounded CDP cleanup slower than the old 2.5s kill grace.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        if mode == "pending":
            time.sleep(3)
        Path(marker).write_text("closed", encoding="utf-8")
