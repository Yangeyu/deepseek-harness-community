"""Observed actions through Browser Harness; one CDP session, no per-step subprocess."""

import hashlib
import json
import signal
import sys
import threading
import time
from pathlib import Path

from browser_harness.admin import ensure_daemon
from browser_harness.helpers import cdp

# Atomically read visible content and controls, preserving actual DOM node identity.
READ_STATE = Path(__file__).with_name("snapshot.js").read_text()
MARKER = f"(() => {{ const state={READ_STATE}; return state?.marker ?? null; }})()"

class StalePage(ValueError):
    """A decision no longer refers to the observed page."""


class Browser:
    def __init__(self, url):
        self.target = None
        try:
            self._start(url)
        except BaseException:
            # Attachment/navigation can fail after allocation; close any known target.
            try:
                self.close()
            except Exception:
                raise RuntimeError("Failed to close owned browser tab after startup failure") from None
            raise

    def _start(self, url):
        ensure_daemon()
        # A signal must not discard the target ID after Chrome allocated the tab.
        # Delay cancellation only across this RPC and assignment, then replay it.
        handlers, pending = {}, []
        def defer_cancel(signum, frame):
            if not pending:
                pending.append(signum)
        if threading.current_thread() is threading.main_thread():
            for sig in (signal.SIGTERM, signal.SIGINT):
                handlers[sig] = signal.signal(sig, defer_cancel)
        try:
            self.target = cdp("Target.createTarget", url="about:blank", background=True)["targetId"]
        finally:
            for sig, handler in handlers.items():
                signal.signal(sig, handler)
            if pending:
                signal.raise_signal(pending[0])
        self.session = cdp("Target.attachToTarget", targetId=self.target, flatten=True)["sessionId"]
        self.call("Emulation.setDeviceMetricsOverride", width=1120, height=780, deviceScaleFactor=1, mobile=False)
        # Keep rAF/menus rendering in an owned background tab, without activating the user's Chrome tab.
        self.call("Emulation.setFocusEmulationEnabled", enabled=True)
        self.call("Page.navigate", url=url)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if self.evaluate("document.readyState") == "complete":
                break
            time.sleep(0.02)

    def call(self, method, **params):
        return cdp(method, session_id=self.session, **params)

    def evaluate(self, expression):
        response = self.call("Runtime.evaluate", expression=expression, returnByValue=True)
        if response.get("exceptionDetails"):
            raise StalePage("Document changed during evaluation")
        return response.get("result", {}).get("value")

    def observe(self, screenshot=True):
        if getattr(self, "after_input", None):
            action, self.after_input = self.after_input, None
            # This is read-only and happens after execution was logged, even if navigation interrupts it.
            try:
                self.call(
                    "Runtime.evaluate",
                    expression="""(action => new Promise(resolve => {
                      const field=window.__jevFast?.nodes.get(action.node);
                      const autocomplete=action.kind==='fill' && field?.getAttribute('role')==='combobox';
                      let frames=0, stopped=false;
                      const finish=()=>{stopped=true;resolve()};
                      setTimeout(finish,autocomplete ? 200 : 50);
                      const ready=()=>{
                        if (stopped) return;
                        const ids=(field?.getAttribute('aria-controls')||field?.getAttribute('aria-owns')||'')
                          .split(/\\s+/).filter(Boolean);
                        const roots=ids.length ? ids.map(id=>document.getElementById(id)).filter(Boolean) : [document];
                        const options=roots.flatMap(root=>[...root.querySelectorAll('[role="option"]')]);
                        if (++frames>=2 && (!autocomplete || options.some(e=>{
                          const r=e.getBoundingClientRect();
                          return r.width && r.height && r.bottom>0 && r.top<innerHeight &&
                            e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
                        }))) finish();
                        else requestAnimationFrame(ready);
                      };
                      requestAnimationFrame(ready);
                    }))(""" + json.dumps(action) + ")",
                    awaitPromise=True,
                    returnByValue=True,
                )
            except RuntimeError:
                pass
        for attempt in range(10):
            try:
                return browser_operation(
                    {"operation": "observe", "session": self.session, "screenshot": screenshot}
                )
            except StalePage:
                if attempt == 9:
                    raise
                time.sleep(0.02)
        raise StalePage("Page did not settle")

    def fresh(self, page):
        # Include all offered actions, notably unselected option labels and values.
        return self.evaluate(MARKER) == page["marker"]

    def act(self, action, page, text=None):
        if not self.fresh(page):
            raise StalePage("Page changed since this decision. Observe again.")
        if action["kind"] == "wait":
            time.sleep(0.1)
        result = browser_operation({"operation": "act", "session": self.session, "action": action, "text": text,
                                    "guard": page["guards"].get(str(action.get("node"))),
                                    "document_key": page["marker"][:2]})
        self.after_input = action if action["kind"] != "wait" else None
        return result

    def close(self):
        # A signal arriving during cleanup must not strand the owned tab. Never stop
        # the shared daemon/browser, and do not change signal handlers in a thread.
        handlers = {}
        if threading.current_thread() is threading.main_thread():
            for sig in (signal.SIGTERM, signal.SIGINT):
                handlers[sig] = signal.signal(sig, signal.SIG_IGN)
        try:
            if self.target:
                result = cdp("Target.closeTarget", targetId=self.target)
                if not isinstance(result, dict) or result.get("success") is not True:
                    raise RuntimeError("Owned tab closure was not confirmed")
                self.target = None
        finally:
            for sig, handler in handlers.items():
                signal.signal(sig, handler)


def fingerprint(state):
    content = {k: state[k] for k in ("url", "text", "actions", "scroll")}
    return hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()


def browser_operation(request):
    operation = request["operation"]
    session = request["session"]

    def call(method, **params):
        return cdp(method, session_id=session, **params)

    def evaluate(expression):
        result = call("Runtime.evaluate", expression=expression, returnByValue=True)
        if result.get("exceptionDetails"):
            if operation == "act" and request["action"]["kind"] == "select":
                raise RuntimeError("Dropdown execution was interrupted; inspect before retrying.")
            raise StalePage("Document changed during evaluation")
        return result.get("result", {}).get("value")

    if operation == "act":
        action = request["action"]
        kind = action["kind"]
        if kind == "scroll":
            call("Input.dispatchMouseEvent", type="mouseWheel", x=550, y=650, deltaX=0, deltaY=action["delta"])
        elif kind != "wait":
            if type(action["node"]) is not int:
                raise ValueError("Invalid observed node")
            # Code-owned node IDs refer to actual observed elements, never model-generated selectors.
            target = evaluate("""(({action,guard,documentKey}) => {
              const cache=window.__jevFast, e=cache?.nodes.get(action.node);
              if (!documentKey || performance.timeOrigin!==documentKey[0] || location.href!==documentKey[1] ||
                  !guard || JSON.stringify(cache?.guard(e))!==JSON.stringify(guard)) return {stale:true};
              if (!e?.isConnected || !window.__jevFast?.safe(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
                  !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
              if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
              const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
              if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight) return null;
              if (!e.contains(document.elementFromPoint(x,y))) return null;
              if (action.kind==='select') {
                if (e.tagName!=='SELECT') return {stale:true};
                const option=[...e.options].find(o=>o.value===action.value);
                if (!option || option.disabled || option.closest('optgroup[disabled]') ||
                    (cache.name(e)||action.role)+' → '+option.label!==action.label) return {stale:true};
                e.value=action.value;
                e.dispatchEvent(new Event('input',{bubbles:true}));
                e.dispatchEvent(new Event('change',{bubbles:true}));
              }
              return {x,y};
            })(""" + json.dumps({"action": action, "guard": request.get("guard"),
                                  "documentKey": request.get("document_key")}) + ")")
            if target == {"stale": True}:
                raise StalePage("Target or option changed before execution. Observe again.")
            if target is None:
                if kind == "select":
                    raise RuntimeError("Dropdown execution was not confirmed; inspect before retrying.")
                raise StalePage("Target changed or is covered. Observe again.")
            if kind != "select":
                x, y = target["x"], target["y"]
                for event in ("mousePressed", "mouseReleased"):
                    call("Input.dispatchMouseEvent", type=event, x=x, y=y, button="left", clickCount=1)
                if kind == "fill":
                    def confirm_fill_target():
                        # Clicking already mutated the page. Never call a changed
                        # document/focus a harmless stale failure or type into it.
                        expression = """(payload => {
                          const e=window.__jevFast?.nodes.get(payload.node), key=payload.documentKey;
                          return !!(key && performance.timeOrigin===key[0] && location.href===key[1] &&
                            e?.isConnected && document.activeElement===e && window.__jevFast?.safe(e) &&
                            !e.readOnly && e.getAttribute('aria-readonly')!=='true' && !e.matches(':disabled') &&
                            !e.closest('[aria-disabled="true"],[inert]') &&
                            (e.isContentEditable || e.tagName==='TEXTAREA' ||
                              e.tagName==='INPUT' && ['text','search','email','url','tel','number'].includes(e.type)));
                        })(""" + json.dumps({"node": action["node"], "documentKey": request.get("document_key")}) + ")"
                        try:
                            checked = call("Runtime.evaluate", expression=expression, returnByValue=True)
                            if checked.get("exceptionDetails") or checked.get("result", {}).get("value") is not True:
                                raise RuntimeError("changed")
                        except Exception:
                            raise RuntimeError("Fill target changed after clicking; outcome uncertain") from None

                    confirm_fill_target()
                    call(
                        "Input.dispatchKeyEvent",
                        type="keyDown",
                        key="a",
                        code="KeyA",
                        modifiers=4 if sys.platform == "darwin" else 2,
                        commands=["selectAll"],
                    )
                    call(
                        "Input.dispatchKeyEvent",
                        type="keyUp",
                        key="a",
                        code="KeyA",
                        modifiers=4 if sys.platform == "darwin" else 2,
                    )
                    confirm_fill_target()
                    if request["text"] == "":
                        # CDP insertText('') need not delete the selected contents.
                        for event in ("keyDown", "keyUp"):
                            call("Input.dispatchKeyEvent", type=event, key="Backspace", code="Backspace",
                                 windowsVirtualKeyCode=8)
                    else:
                        call("Input.insertText", text=request["text"])
        return {"executed": action["id"]}

    info = evaluate(READ_STATE)
    if info is None:
        raise StalePage("Document is navigating")
    info["fingerprint"] = fingerprint(info)
    if request.get("screenshot", True):
        info["screenshot"] = call("Page.captureScreenshot", format="jpeg", quality=72)["data"]
    return info
