#!/usr/bin/env python3
"""One owned tab per JSONL process; decisions and approvals belong to the host."""

import contextlib
import ipaddress
import json
import re
import signal
import sys
import uuid
from urllib.parse import urlsplit, urlunsplit

MAX_LINE = 100_000
MAX_TEXT = 20_000
MAX_FILL = 10_000
MAX_ACTIONS = 250
MAX_ACTION_TEXT = 32_000
MAX_SCREENSHOT = 16 * 1024 * 1024  # Encoded size; the host validates decoded attachments.
ACTION_KINDS = {"click", "fill", "select", "scroll", "wait"}
ACTION_FIELDS = {"role": 100, "checked": 32, "selected": 32, "expanded": 32}


class ProtocolError(ValueError):
    pass


class SessionError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message


class Cancelled(BaseException):
    def __init__(self, signum):
        self.signum = signum


def read_message(stream):
    line = stream.readline(MAX_LINE + 1)
    if not line:
        raise EOFError
    if len(line) > MAX_LINE:
        raise ProtocolError("JSONL line exceeds limit")
    try:
        message = json.loads(line)
    except (ValueError, RecursionError):
        raise ProtocolError("Invalid JSONL") from None
    if not isinstance(message, dict) or type(message.get("id")) is not int or message["id"] <= 0:
        raise ProtocolError("Expected a positive integer request id")
    return message


def normalized_url(url):
    """Conservative HTTP URL boundary, with one canonical effective-port origin."""
    invalid = SessionError("invalid", "Expected an HTTP(S) URL without credentials or ambiguous authority")
    if not isinstance(url, str) or not 1 <= len(url) <= 8192:
        raise invalid
    if any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in url) or "\\" in url:
        raise invalid
    try:
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or "@" in parsed.netloc:
            raise invalid
        host = parsed.hostname
        if ":" in host:
            if not re.fullmatch(r"\[[^\]]+\](?::[0-9]+)?", parsed.netloc):
                raise invalid
            host = "[" + ipaddress.IPv6Address(host).compressed + "]"
        else:
            host = host.encode("idna").decode("ascii").lower()
            if len(host) > 253 or not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                                           for label in host.rstrip(".").split(".")):
                raise invalid
            # WHATWG treats a numeric final label as IPv4; reject its noncanonical aliases.
            final = host.rstrip(".").split(".")[-1]
            if final.isdigit() or re.fullmatch(r"0x[0-9a-f]+", final):
                if str(ipaddress.IPv4Address(host)) != host:
                    raise invalid
        if "%" in host or parsed.netloc.endswith(":"):
            raise invalid
        port = parsed.port
        if port == 0:
            raise invalid
        default = 443 if parsed.scheme == "https" else 80
        authority = host + (f":{port}" if port is not None and port != default else "")
        origin = f"{parsed.scheme}://{authority}"
        return urlunsplit((parsed.scheme, authority, parsed.path, parsed.query, parsed.fragment)), origin
    except (ValueError, UnicodeError):
        raise invalid from None


def bounded_string(value, limit):
    return value[:limit] if isinstance(value, str) else ""


def public_observation(page, observation_id, screenshot):
    actions, executable, budget, controls = [], {}, MAX_ACTION_TEXT, 0
    raw_actions = page.get("actions", [])
    if not isinstance(raw_actions, list):
        raise SessionError("observe_failed", "Observation returned invalid actions")
    def auxiliary(action):
        return isinstance(action, dict) and (action.get("id"), action.get("kind")) in (
            ("scroll_down", "scroll"), ("scroll_up", "scroll"), ("wait", "wait"))
    # Reserve room and budget for navigation/wait before ordinary page controls.
    for action in sorted(raw_actions, key=auxiliary, reverse=True):
        if not isinstance(action, dict):
            continue
        action_id, kind = action.get("id"), action.get("kind")
        if (not isinstance(action_id, str) or not re.fullmatch(r"(?:e[1-9][0-9]*|scroll_down|scroll_up|wait)", action_id)
                or len(action_id) > 64 or not isinstance(kind, str) or kind not in ACTION_KINDS or action_id in executable):
            continue
        public = {"id": action_id, "kind": kind, "label": bounded_string(action.get("label"), 500)}
        for key, limit in ACTION_FIELDS.items():
            if isinstance(action.get(key), str):
                public[key] = action[key][:limit]
        cost = sum(len(value) for value in public.values())
        is_auxiliary = auxiliary(action)
        if (not is_auxiliary and controls >= MAX_ACTIONS) or cost > budget:
            continue
        budget -= cost
        controls += not is_auxiliary
        actions.append(public)
        executable[action_id] = action
    omitted = page.get("omitted_actions", 0)
    if type(omitted) is not int or omitted < 0:
        omitted = 0
    value = {"observationId": observation_id, "url": bounded_string(page.get("url"), 8192),
             "title": bounded_string(page.get("title"), 1000), "text": bounded_string(page.get("text"), MAX_TEXT),
             "actions": actions, "omittedActions": omitted + len(raw_actions) - len(actions)}
    if screenshot:
        image = page.get("screenshot")
        if not isinstance(image, str) or not image or len(image) > MAX_SCREENSHOT or not image.isascii():
            raise SessionError("observe_failed", "Screenshot missing or exceeds encoded size limit")
        value["screenshot"] = image
    return value, executable


class Session:
    def __init__(self, browser_factory, stale_error):
        self.browser_factory, self.stale_error = browser_factory, stale_error
        self.browser = None
        self.origin = None
        self.open_attempted = False
        self.closed = False
        self.observation = None

    def check_origin(self):
        # Read only location.origin before asking Jev for any DOM or screenshot.
        try:
            current = self.browser.evaluate("location.origin")
            _, origin = normalized_url(current)
        except SessionError:
            raise SessionError("origin_changed", "Current page is outside the session origin") from None
        except Exception:
            raise SessionError("observe_failed", "Could not confirm current origin") from None
        if origin != self.origin:
            raise SessionError("origin_changed", "Current page is outside the session origin")

    def close(self):
        self.observation = None
        self.closed = True
        if self.browser is not None:
            browser, self.browser = self.browser, None
            try:
                browser.close()
            except Exception:
                raise SessionError("close_failed", "Failed to close owned browser tab") from None

    def dispatch(self, request):
        op = request.get("op")
        # Every act attempt, including malformed or wrong-token requests, consumes it.
        observation = self.observation
        if op in ("act", "observe"):
            self.observation = None
        fields = {"open": {"id", "op", "url"}, "observe": {"id", "op", "screenshot"},
                  "act": {"id", "op", "observationId", "actionId", "text"}, "close": {"id", "op"}}
        if not isinstance(op, str) or op not in fields or set(request) - fields[op]:
            raise SessionError("invalid", "Unknown operation or unexpected request fields")
        if type(request.get("id")) is not int or request["id"] <= 0:
            raise SessionError("invalid", "Expected a positive integer request id")
        if self.closed:
            raise SessionError("invalid", "Session is closed")
        if op == "close":
            self.close()
            return {"status": "closed"}
        if op == "open":
            if self.open_attempted:
                raise SessionError("invalid", "Session can only be opened once")
            url, self.origin = normalized_url(request.get("url"))
            self.open_attempted = True
            try:
                self.browser = self.browser_factory(url)
            except Exception:
                self.closed = True
                raise SessionError("open_failed", "Could not open owned browser tab or confirm startup cleanup") from None
            self.check_origin()
            return {"status": "opened", "origin": self.origin}
        if self.browser is None:
            raise SessionError("invalid", "Open a session first")
        if op == "observe":
            if type(request.get("screenshot")) is not bool:
                raise SessionError("invalid", "observe requires a boolean screenshot field")
            self.check_origin()
            try:
                page = self.browser.observe(screenshot=request["screenshot"])
                # Check both the snapshot URL and the live origin after observation/capture.
                self.check_origin()
                try:
                    _, observed_origin = normalized_url(page.get("url"))
                except SessionError:
                    raise SessionError("origin_changed", "Observation is outside the session origin") from None
                if observed_origin != self.origin:
                    raise SessionError("origin_changed", "Observation is outside the session origin")
                if request["screenshot"] and not self.browser.fresh(page):
                    raise SessionError("stale", "Page changed during screenshot; observe again")
                self.check_origin()
                observation_id = str(uuid.uuid4())
                value, actions = public_observation(page, observation_id, request["screenshot"])
                self.observation = (observation_id, page, actions)
                return value
            except self.stale_error:
                raise SessionError("stale", "Page changed during observation; observe again") from None
            except SessionError:
                raise
            except Exception:
                raise SessionError("observe_failed", "Could not observe page") from None
        if not isinstance(request.get("observationId"), str) or not isinstance(request.get("actionId"), str):
            raise SessionError("invalid", "act requires observationId and actionId strings")
        if observation is None or observation[0] != request["observationId"]:
            raise SessionError("stale", "Observation is no longer available; observe again")
        _, page, actions = observation
        action = actions.get(request["actionId"])
        if action is None:
            raise SessionError("invalid", "Action was not offered by this observation")
        if action["kind"] == "fill":
            if not isinstance(request.get("text"), str) or len(request["text"]) > MAX_FILL:
                raise SessionError("invalid", "fill requires text of at most 10000 characters")
        elif "text" in request:
            raise SessionError("invalid", "Only fill accepts text")
        self.check_origin()
        try:
            # Jev act itself performs its per-action freshness and target guard.
            result = self.browser.act(action, page, text=request.get("text"))
        except self.stale_error:
            raise SessionError("stale", "Action target changed before execution; observe again") from None
        except Exception:
            raise SessionError("uncertain", "Action may have executed; observe before deciding what to do next") from None
        if result != {"executed": action["id"]}:
            raise SessionError("uncertain", "Action execution was not confirmed; observe again")
        return {"status": "executed", "actionId": action["id"]}


def error_response(request_id, error):
    return {"id": request_id, "ok": False, "error": {"code": error.code, "message": error.message}}


def serve(receive, emit, browser_factory, stale_error):
    session, exit_code, pending = Session(browser_factory, stale_error), 0, None
    try:
        while True:
            request = receive()
            pending = request["id"]
            try:
                value = session.dispatch(request)
                emit({"id": pending, "ok": True, "value": value})
            except SessionError as error:
                emit(error_response(pending, error))
                if error.code in {"open_failed", "close_failed"}:
                    exit_code = 1
            pending = None
            if session.closed:
                break
    except EOFError:
        pass
    except Cancelled:
        # The host records cancellation; nonzero exit is reserved for failed cleanup.
        exit_code = 0
        if pending is not None:
            emit(error_response(pending, SessionError("cancelled", "Request cancelled; action outcome may be uncertain")))
    except Exception:
        # Never echo dependency exceptions, request text, or page fields.
        print("Browser worker protocol or execution failure", file=sys.stderr)
        exit_code = 1
    finally:
        try:
            session.close()
        except SessionError:
            print("Failed to close owned browser tab", file=sys.stderr)
            exit_code = 1
    return exit_code


def main(browser_factory=None, stale_error=None):
    output = sys.stdout

    def emit(message):
        output.write(json.dumps(message, ensure_ascii=True, allow_nan=False) + "\n")
        output.flush()

    def cancel(signum, frame):
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, signal.SIG_IGN)
        raise Cancelled(signum)

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, cancel)
    try:
        # Diagnostics cannot corrupt JSONL; our own errors never include raw exceptions.
        with contextlib.redirect_stdout(sys.stderr):
            if browser_factory is None:
                if sys.version_info < (3, 12):
                    raise RuntimeError("version")
                from jev_browser.browser import Browser, StalePage
                browser_factory, stale_error = Browser, StalePage
            return serve(lambda: read_message(sys.stdin), emit, browser_factory, stale_error)
    except Cancelled:
        return 0
    except Exception:
        print("Browser worker startup failed (requires Python >=3.12 and browser-harness==0.1.13)", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
