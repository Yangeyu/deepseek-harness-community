# Community Web policy

This package keeps the official DeepSeek Harness model-tool contracts while
adding a live, registry-driven provider policy:

- `community-web` is the one stable search provider selected by the profile.
  It delegates each operation to `auto` or a persisted concrete provider ID.
- `community-tavily` supplies Tavily search and provider-neutral page
  extraction.
- `deepseek-official` reuses the official DeepSeek search implementation and
  its existing settings and credential references.

`auto` evaluates local readiness before every search and selects the
highest-priority ready registration. It does not retry a second provider after
a request starts, so provider failures cannot silently create duplicate work or
cost. Manual selection is persisted through Harness settings and applies to the
next search without restarting the TUI.

Provider registrations carry execution, display metadata, priority, and a
secret-free readiness projection. `/config web` renders that registry directly;
adding another provider does not require a new Profile entry, router branch, or
UI option. Replacing an implementation under the same provider ID preserves the
saved selection; choosing a different ID is the only case that requires a new
manual selection.

Extraction remains separate from official `web_fetch`: Tavily returns readable
content but not the origin HTTP status required by that upstream contract.
Tavily search and extraction share authentication, transport, cancellation,
and error mapping without merging their request or result contracts. Credentials
are resolved per operation and never stored in package settings.
