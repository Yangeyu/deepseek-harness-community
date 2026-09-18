"""Offline functional tests; stdlib only, no installed dependencies or live Chrome."""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import types
import unittest
import uuid
from unittest.mock import patch

PYTHON_DIR = Path(__file__).resolve().parents[2] / "python"
sys.path.insert(0, str(PYTHON_DIR))
import worker


class StalePage(ValueError):
    pass


def page(*actions, url="https://example.test/", **fields):
    return {"url": url, "title": "Example", "text": "Form", "actions": list(actions),
            "guards": {"private": "secret"}, "marker": [1], "page_key": [2], **fields}


def action(action_id="e1", kind="click", label="Control", **fields):
    return {"id": action_id, "kind": kind, "label": label, "node": 4, **fields}


class FakeBrowser:
    def __init__(self, pages=(), outcomes=(), freshness=(), origins=()):
        self.pages, self.outcomes = iter(pages), iter(outcomes)
        self.freshness, self.origins = iter(freshness), iter(origins)
        self.origin = "https://example.test"
        self.attempts, self.mutations, self.observations = [], [], []
        self.closed = 0
        self.fresh_pages = []

    def evaluate(self, expression):
        assert expression == "location.origin"
        return next(self.origins, self.origin)

    def observe(self, screenshot):
        self.observations.append(screenshot)
        item = next(self.pages)
        if isinstance(item, BaseException):
            raise item
        return item

    def fresh(self, observed):
        self.fresh_pages.append(observed)
        return next(self.freshness, True)

    def act(self, selected, observed, text=None):
        self.attempts.append((selected, observed, text))
        outcome = next(self.outcomes, None)
        if isinstance(outcome, BaseException):
            raise outcome
        self.mutations.append((selected["id"], text))
        return {"executed": selected["id"]} if outcome is None else outcome

    def close(self):
        self.closed += 1


class SessionTests(unittest.TestCase):
    def session(self, browser):
        instance = worker.Session(lambda url: browser, StalePage)
        self.assertEqual(instance.dispatch({"id": 1, "op": "open", "url": "https://example.test/"}),
                         {"status": "opened", "origin": "https://example.test"})
        self.addCleanup(instance.close)
        return instance

    def observe(self, session, screenshot=False):
        return session.dispatch({"id": 2, "op": "observe", "screenshot": screenshot})

    def act(self, session, observation, action_id="e1", **fields):
        return session.dispatch({"id": 3, "op": "act", "observationId": observation["observationId"],
                                 "actionId": action_id, **fields})

    def assert_error(self, code, call):
        with self.assertRaises(worker.SessionError) as raised:
            call()
        self.assertEqual(raised.exception.code, code)
        return raised.exception

    def test_continuous_observe_act_uses_full_private_page_and_new_tokens(self):
        first, second = page(action(kind="fill", value="old")), page(action("e2", "click"))
        browser = FakeBrowser([first, second, page()])
        session = self.session(browser)
        observed = self.observe(session)
        self.assertEqual(self.act(session, observed, text="Ada"), {"status": "executed", "actionId": "e1"})
        next_observed = self.observe(session)
        self.assertEqual(self.act(session, next_observed, "e2"), {"status": "executed", "actionId": "e2"})
        final = self.observe(session)
        tokens = {observed["observationId"], next_observed["observationId"], final["observationId"]}
        self.assertEqual(len(tokens), 3)
        for token in tokens:
            self.assertEqual(uuid.UUID(token).version, 4)
        self.assertIs(browser.attempts[0][1], first)
        self.assertIs(browser.attempts[1][1], second)
        self.assertEqual(browser.mutations, [("e1", "Ada"), ("e2", None)])
        self.assertEqual(browser.closed, 0)

    def test_new_observe_and_each_act_attempt_invalidate_old_observation(self):
        browser = FakeBrowser([page(action()), page(action()), page(action())])
        session = self.session(browser)
        first, second = self.observe(session), self.observe(session)
        self.assert_error("stale", lambda: self.act(session, first))
        self.assert_error("stale", lambda: self.act(session, second))
        third = self.observe(session)
        self.assert_error("invalid", lambda: self.act(session, third, "unobserved"))
        self.assert_error("stale", lambda: self.act(session, third))
        self.assertEqual(browser.attempts, [])

    def test_stale_is_pre_mutation_and_never_replayed(self):
        browser = FakeBrowser([page(action()), page(action())], [StalePage(), None])
        session = self.session(browser)
        observed = self.observe(session)
        self.assert_error("stale", lambda: self.act(session, observed))
        self.assertEqual(browser.mutations, [])
        self.assert_error("stale", lambda: self.act(session, observed))
        self.act(session, self.observe(session))
        self.assertEqual(len(browser.attempts), 2)
        self.assertEqual(browser.mutations, [("e1", None)])

    def test_uncertain_is_sanitized_consumes_observation_and_does_not_retry(self):
        for outcome in (RuntimeError("TOP_SECRET fill text"), {"unexpected": "TOP_SECRET"}):
            browser = FakeBrowser([page(action(kind="fill"))], [outcome])
            session = self.session(browser)
            observed = self.observe(session)
            error = self.assert_error("uncertain", lambda: self.act(session, observed, text="TOP_SECRET"))
            self.assertNotIn("TOP_SECRET", json.dumps(worker.error_response(3, error)))
            self.assert_error("stale", lambda: self.act(session, observed, text="TOP_SECRET"))
            self.assertEqual(len(browser.attempts), 1)
            self.assertEqual(len(browser.observations), 1)

    def test_fill_accepts_empty_string_but_not_missing_or_nonstring_text(self):
        for text in (None, 7, "x" * (worker.MAX_FILL + 1)):
            browser = FakeBrowser([page(action(kind="fill"))])
            session = self.session(browser)
            observed = self.observe(session)
            self.assert_error("invalid", lambda: self.act(session, observed, text=text))
            self.assertEqual(browser.attempts, [])
        browser = FakeBrowser([page(action(kind="fill"))])
        session = self.session(browser)
        self.act(session, self.observe(session), text="")
        self.assertEqual(browser.mutations, [("e1", "")])

    def test_only_observed_public_actions_and_fill_text_are_accepted(self):
        raw = [action(f"e{i}", label="x" * 500) for i in range(1, 400)]
        browser = FakeBrowser([page(*raw), page(action())])
        session = self.session(browser)
        observation = self.observe(session)
        self.assert_error("invalid", lambda: self.act(session, observation, "e399"))
        observation = self.observe(session)
        self.assert_error("invalid", lambda: self.act(session, observation, text="unexpected"))
        self.assertEqual(browser.attempts, [])

    def test_public_fields_are_whitelisted_and_bounded(self):
        raw = [action(f"e{i}", label="x" * 900, value="PRIVATE_VALUE", current_value="PRIVATE_CURRENT",
                      guard="PRIVATE_GUARD", role="textbox", checked="true", selected="false", expanded="false")
               for i in range(1, 400)]
        browser = FakeBrowser([page(*raw, text="t" * 30_000, title="x" * 5000, omitted_actions=12)])
        result = self.observe(self.session(browser))
        self.assertEqual(set(result), {"observationId", "url", "title", "text", "actions", "omittedActions"})
        self.assertEqual(set(result["actions"][0]), {"id", "kind", "label", "role", "checked", "selected", "expanded"})
        self.assertLessEqual(len(result["actions"]), worker.MAX_ACTIONS)
        self.assertLessEqual(sum(len(value) for a in result["actions"] for value in a.values()), worker.MAX_ACTION_TEXT)
        self.assertEqual(result["omittedActions"], 12 + len(raw) - len(result["actions"]))
        self.assertEqual(len(result["text"]), worker.MAX_TEXT)
        self.assertEqual(len(result["title"]), 1000)
        serialized = json.dumps(result)
        for private in ("PRIVATE_VALUE", "PRIVATE_CURRENT", "PRIVATE_GUARD", "guards", "node", "marker", "page_key"):
            self.assertNotIn(private, serialized)

    def test_dense_pages_keep_scroll_and_wait_despite_control_and_text_budgets(self):
        for label in ("Control", "x" * 500):
            ordinary = [action(f"e{i}", label=label) for i in range(1, 251)]
            auxiliary = [action("scroll_down", "scroll"), action("scroll_up", "scroll"), action("wait", "wait")]
            browser = FakeBrowser([page(*ordinary, *auxiliary)])
            session = self.session(browser)
            observed = self.observe(session)
            offered = {a["id"] for a in observed["actions"]}
            self.assertTrue({"scroll_down", "scroll_up", "wait"} <= offered)
            self.assertLessEqual(len(offered), 253)
            if label == "Control":
                self.assertEqual(len(offered), 253)
            self.act(session, observed, "scroll_down")
            self.assertEqual(browser.mutations, [("scroll_down", None)])

    def test_cross_origin_before_observe_does_not_read_dom(self):
        browser = FakeBrowser([page(text="CROSS_ORIGIN_SECRET")])
        session = self.session(browser)
        browser.origin = "https://other.test"
        self.assert_error("origin_changed", lambda: self.observe(session, True))
        self.assertEqual(browser.observations, [])

    def test_cross_origin_snapshot_or_live_origin_is_not_exposed(self):
        for snapshot_url, origins in (("https://other.test/", []),
                                      ("https://example.test/", ["https://example.test", "https://other.test"])):
            browser = FakeBrowser([page(url=snapshot_url, text="CROSS_ORIGIN_SECRET", screenshot="SECRET_IMAGE")])
            session = self.session(browser)
            browser.origins = iter(origins)
            error = self.assert_error("origin_changed", lambda: self.observe(session, True))
            self.assertNotIn("SECRET", json.dumps(worker.error_response(2, error)))
            self.assertIsNone(session.observation)

    def test_cross_origin_before_act_prevents_execution_and_consumes_token(self):
        browser = FakeBrowser([page(action())])
        session = self.session(browser)
        observation = self.observe(session)
        browser.origin = "http://example.test"
        self.assert_error("origin_changed", lambda: self.act(session, observation))
        browser.origin = "https://example.test"
        self.assert_error("stale", lambda: self.act(session, observation))
        self.assertEqual(browser.attempts, [])

    def test_screenshots_are_opt_in_bounded_and_checked_for_drift(self):
        raw = page(screenshot="/9j/AA==")
        browser = FakeBrowser([raw, raw, raw], freshness=[True, False])
        session = self.session(browser)
        self.assertNotIn("screenshot", self.observe(session))
        self.assertEqual(self.observe(session, True)["screenshot"], "/9j/AA==")
        self.assert_error("stale", lambda: self.observe(session, True))
        self.assertEqual(browser.observations, [False, True, True])
        self.assertEqual(len(browser.fresh_pages), 2)
        self.assertIsNone(session.observation)
        browser = FakeBrowser([page(screenshot="x" * (worker.MAX_SCREENSHOT + 1))])
        self.assert_error("observe_failed", lambda: self.observe(self.session(browser), True))

    def test_failed_observe_drops_previous_token(self):
        browser = FakeBrowser([page(action()), RuntimeError("PRIVATE_PAGE")])
        session = self.session(browser)
        observed = self.observe(session)
        error = self.assert_error("observe_failed", lambda: self.observe(session))
        self.assertNotIn("PRIVATE_PAGE", error.message)
        self.assert_error("stale", lambda: self.act(session, observed))

    def test_open_is_unique_and_no_authorization_fields_are_accepted(self):
        browser = FakeBrowser([page(action())])
        session = self.session(browser)
        self.assert_error("invalid", lambda: session.dispatch({"id": 2, "op": "open", "url": "https://example.test"}))
        observed = self.observe(session)
        self.assert_error("invalid", lambda: self.act(session, observed, approved=True))
        self.assert_error("stale", lambda: self.act(session, observed))
        self.assertEqual(browser.attempts, [])

    def test_url_boundary_and_origin_normalization_before_allocation(self):
        valid = {"HTTPS://EXAMPLE.TEST:443/a": "https://example.test",
                 "http://example.test:80/": "http://example.test", "https://example.test:8443/": "https://example.test:8443",
                 "https://bücher.example/": "https://xn--bcher-kva.example",
                 "http://[2001:0db8:0:0::1]:80/": "http://[2001:db8::1]"}
        for url, origin in valid.items():
            self.assertEqual(worker.normalized_url(url)[1], origin)
        for url in ("file:///etc/passwd", "javascript:alert(1)", "https://@example.test", "https://user:pass@example.test",
                    "https://example.test\\@evil.test", "https://example.test\n/", "https://example.test:65536/",
                    "https://example.test:/", "https://127.1/", "https://0x7f000001/", "https://%65xample.test/",
                    "https://[fe80::1%25en0]/", "https://[::1]junk/", "https://example.test:0/", "https://example.test/ a"):
            session = worker.Session(lambda _: self.fail("Allocated tab for invalid URL"), StalePage)
            self.assert_error("invalid", lambda: session.dispatch({"id": 1, "op": "open", "url": url}))


class TransportTests(unittest.TestCase):
    def serve(self, browser, requests):
        messages, pending = [], iter(requests)
        def receive():
            item = next(pending, EOFError())
            if isinstance(item, BaseException):
                raise item
            return item
        code = worker.serve(receive, messages.append, lambda _: browser, StalePage)
        return code, messages

    def test_request_response_envelopes_and_explicit_close(self):
        browser = FakeBrowser([page()])
        code, responses = self.serve(browser, [{"id": 11, "op": "open", "url": "https://example.test/"},
            {"id": 12, "op": "observe", "screenshot": False}, {"id": 13, "op": "close"}])
        self.assertEqual(code, 0)
        self.assertEqual([r["id"] for r in responses], [11, 12, 13])
        self.assertTrue(all(r["ok"] for r in responses))
        self.assertEqual(responses[-1]["value"], {"status": "closed"})
        self.assertEqual(browser.closed, 1)

    def test_eof_and_cancellation_close_owned_tab(self):
        for interruption, expected in ((EOFError(), 0), (worker.Cancelled(signal.SIGTERM), 0)):
            browser = FakeBrowser()
            code, responses = self.serve(browser, [{"id": 1, "op": "open", "url": "https://example.test/"}, interruption])
            self.assertEqual(code, expected)
            self.assertEqual(browser.closed, 1)
            self.assertEqual(len(responses), 1)

    def test_close_failure_is_visible_in_response_and_exit_status(self):
        for explicit in (True, False):
            browser = FakeBrowser()
            browser.close = lambda: (_ for _ in ()).throw(RuntimeError("PRIVATE_DIAGNOSTIC"))
            requests = [{"id": 1, "op": "open", "url": "https://example.test/"}]
            if explicit:
                requests.append({"id": 2, "op": "close"})
            with contextlib.redirect_stderr(io.StringIO()) as diagnostics:
                code, responses = self.serve(browser, requests)
            self.assertEqual(code, 1)
            if explicit:
                self.assertEqual(responses[-1]["error"]["code"], "close_failed")
            else:
                self.assertIn("Failed to close", diagnostics.getvalue())
            self.assertNotIn("PRIVATE_DIAGNOSTIC", json.dumps(responses) + diagnostics.getvalue())

    def test_protocol_reader_bounds_lines_and_rejects_unaddressable_messages(self):
        for content in ("[]\n", "not json\n", "x" * (worker.MAX_LINE + 1), '{"id":true}\n', '{"id":0}\n'):
            with self.assertRaises(worker.ProtocolError):
                worker.read_message(io.StringIO(content))
        self.assertEqual(worker.read_message(io.StringIO('{"id":1,"op":"close"}\n')), {"id": 1, "op": "close"})


class BrowserLifecycleTests(unittest.TestCase):
    def load_browser(self, cdp):
        admin = types.ModuleType("browser_harness.admin")
        admin.ensure_daemon = lambda: None
        helpers = types.ModuleType("browser_harness.helpers")
        helpers.cdp = cdp
        spec = importlib.util.spec_from_file_location("vendor_browser_test", PYTHON_DIR / "jev_browser" / "browser.py")
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"browser_harness": types.ModuleType("browser_harness"), "browser_harness.admin": admin,
                                     "browser_harness.helpers": helpers}):
            spec.loader.exec_module(module)
        return module

    def test_startup_failure_closes_only_the_new_target(self):
        calls = []
        def cdp(method, **params):
            calls.append((method, params))
            if method == "Target.createTarget":
                return {"targetId": "owned"}
            if method == "Target.attachToTarget":
                raise RuntimeError("attach failed")
            if method == "Target.closeTarget":
                return {"success": True}
        module = self.load_browser(cdp)
        with self.assertRaisesRegex(RuntimeError, "attach failed"):
            module.Browser("https://example.test/")
        self.assertEqual(calls[-1], ("Target.closeTarget", {"targetId": "owned"}))
        self.assertEqual(len(calls), 3)

    @unittest.skipUnless(os.name == "posix", "POSIX cancellation during target allocation")
    def test_cancellation_during_create_retains_target_for_cleanup(self):
        def cancel(signum, frame):
            raise worker.Cancelled(signum)
        previous = signal.signal(signal.SIGTERM, cancel)
        try:
            for close_success in (True, False):
                calls = []
                def cdp(method, **params):
                    calls.append((method, params))
                    if method == "Target.createTarget":
                        signal.raise_signal(signal.SIGTERM)
                        # Cancellation must be deferred until this ID is assigned.
                        return {"targetId": "owned"}
                    if method == "Target.closeTarget":
                        return {"success": close_success}
                    self.fail("Cancellation must run before attaching or navigating")
                module = self.load_browser(cdp)
                responses = []
                pending = iter([{"id": 1, "op": "open", "url": "https://example.test/"}])
                code = worker.serve(lambda: next(pending), responses.append, module.Browser, module.StalePage)
                self.assertEqual(calls[-1], ("Target.closeTarget", {"targetId": "owned"}))
                self.assertEqual(len(calls), 2)
                self.assertEqual(code, 0 if close_success else 1)
                self.assertEqual(responses[0]["error"]["code"], "cancelled" if close_success else "open_failed")
        finally:
            signal.signal(signal.SIGTERM, previous)

    def test_unconfirmed_tab_close_is_not_reported_successful(self):
        module = self.load_browser(lambda *a, **kw: {"success": False})
        browser = module.Browser.__new__(module.Browser)
        browser.target = "owned"
        with self.assertRaisesRegex(RuntimeError, "not confirmed"):
            browser.close()
        self.assertEqual(browser.target, "owned")

    def test_jev_freshness_rejects_before_any_execution(self):
        calls = []
        def cdp(method, **params):
            calls.append(method)
            return {"result": {"value": None}}
        module = self.load_browser(cdp)
        browser = module.Browser.__new__(module.Browser)
        browser.session = "s"
        with self.assertRaises(module.StalePage):
            browser.act(action(), page())
        self.assertEqual(calls, ["Runtime.evaluate"])

    def test_unselected_option_changes_reject_before_execution_even_with_same_node_guard(self):
        selected = action(kind="select", label="Choice → Approved", value="approved")
        observed = page(selected, guards={"4": ["same node guard"]}, page_key=["same selected value"],
                        marker=[1, "https://example.test/", {"label": "Approved", "value": "approved"}])
        calls = []
        def cdp(method, **params):
            calls.append(method)
            if params["expression"] == module.MARKER:
                value = [1, "https://example.test/", {"label": "Other", "value": "approved"}]
            else:
                # The former shortcut would miss changes to unselected options.
                value = [observed["page_key"], observed["guards"]["4"]]
            return {"result": {"value": value}}
        module = self.load_browser(cdp)
        browser = module.Browser.__new__(module.Browser)
        browser.session = "s"
        with self.assertRaises(module.StalePage):
            browser.act(selected, observed)
        self.assertEqual(calls, ["Runtime.evaluate"])

    def test_real_execution_distinguishes_pre_mutation_and_uncertain_select(self):
        calls = []
        def cdp(method, **params):
            calls.append(method)
            return {"exceptionDetails": {"text": "navigation"}}
        module = self.load_browser(cdp)
        with self.assertRaises(module.StalePage):
            module.browser_operation({"operation": "act", "session": "s", "action": action()})
        with self.assertRaisesRegex(RuntimeError, "interrupted"):
            module.browser_operation({"operation": "act", "session": "s", "action": action(kind="select", value="v")})
        self.assertEqual(calls, ["Runtime.evaluate", "Runtime.evaluate"])

    def test_fill_stops_uncertain_when_click_or_select_all_changes_focus(self):
        for changes_after in ("click", "selectAll"):
            calls, checks = [], 0
            def cdp(method, **params):
                nonlocal checks
                calls.append((method, params))
                if method == "Runtime.evaluate":
                    if params["expression"].startswith("(payload =>"):
                        checks += 1
                        return {"result": {"value": changes_after == "selectAll" and checks == 1}}
                    return {"result": {"value": {"x": 20, "y": 30}}}
                return {}
            module = self.load_browser(cdp)
            with self.assertRaisesRegex(RuntimeError, "uncertain"):
                module.browser_operation({"operation": "act", "session": "s", "action": action(kind="fill"),
                                          "text": "private fill", "document_key": [1, "https://example.test/"]})
            self.assertEqual([p["type"] for m, p in calls if m == "Input.dispatchMouseEvent"],
                             ["mousePressed", "mouseReleased"])
            self.assertFalse(any(m == "Input.insertText" or p.get("key") == "Backspace" for m, p in calls))
            self.assertEqual(checks, 1 if changes_after == "click" else 2)

    def test_empty_fill_dispatches_delete_after_select_all(self):
        calls = []
        def cdp(method, **params):
            calls.append((method, params))
            if method == "Runtime.evaluate" and params["expression"].startswith("(payload =>"):
                return {"result": {"value": True}}
            return {"result": {"value": {"x": 20, "y": 30}}}
        module = self.load_browser(cdp)
        result = module.browser_operation({"operation": "act", "session": "s", "action": action(kind="fill"), "text": ""})
        self.assertEqual(result, {"executed": "e1"})
        keys = [params for method, params in calls if method == "Input.dispatchKeyEvent"]
        self.assertEqual(keys[0]["commands"], ["selectAll"])
        self.assertEqual([(p["type"], p["key"]) for p in keys[-2:]], [("keyDown", "Backspace"), ("keyUp", "Backspace")])


@unittest.skipUnless(os.name == "posix", "POSIX process signal integration")
class StdioProcessTests(unittest.TestCase):
    def test_stdio_and_owned_tab_cleanup_survive_repeated_signals(self):
        script = '''
import os, signal, sys, types
sys.path.insert(0, sys.argv[1])
admin = types.ModuleType("browser_harness.admin")
admin.ensure_daemon = lambda: None
helpers = types.ModuleType("browser_harness.helpers")
def cdp(method, **params):
    if method == "Target.closeTarget":
        os.kill(os.getpid(), signal.SIGTERM)
        os.kill(os.getpid(), signal.SIGINT)
        print("CLOSED " + params["targetId"], file=sys.stderr, flush=True)
        return {"success": True}
helpers.cdp = cdp
sys.modules.update({"browser_harness": types.ModuleType("browser_harness"), "browser_harness.admin": admin,
                    "browser_harness.helpers": helpers})
from jev_browser.browser import Browser, StalePage
class FakeBrowser(Browser):
    def _start(self, url):
        self.target = "owned"
        print("dependency diagnostic")
    def evaluate(self, expression):
        assert expression == "location.origin"
        return "https://example.test"
import worker
raise SystemExit(worker.main(FakeBrowser, StalePage))
'''
        for end in ("sigterm", "sigint", "close", "eof"):
            with self.subTest(end=end):
                process = subprocess.Popen([sys.executable, "-B", "-u", "-c", script, str(PYTHON_DIR)], stdin=subprocess.PIPE,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    process.stdin.write(json.dumps({"id": 1, "op": "open", "url": "https://example.test/"}) + "\n")
                    process.stdin.flush()
                    self.assertTrue(select.select([process.stdout], [], [], 5)[0], "worker did not open")
                    self.assertEqual(json.loads(process.stdout.readline())["value"]["status"], "opened")
                    if end.startswith("sig"):
                        process.send_signal(signal.SIGTERM if end == "sigterm" else signal.SIGINT)
                    elif end == "close":
                        process.stdin.write('{"id":2,"op":"close"}\n')
                        process.stdin.flush()
                    stdout, stderr = process.communicate(timeout=5)
                    self.assertEqual(process.returncode, 0, stderr)
                    if end == "close":
                        self.assertEqual(json.loads(stdout), {"id": 2, "ok": True, "value": {"status": "closed"}})
                    else:
                        self.assertEqual(stdout, "")
                    self.assertIn("CLOSED owned", stderr)
                    self.assertIn("dependency diagnostic", stderr)
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
