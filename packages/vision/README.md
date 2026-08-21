# DeepSeek Harness Vision

This workspace owns the public, terminal-independent API for model-capability
routing, image proxy analysis, and two-phase admission of source-attributed
observations into supported user-message events. Proxy media stays in the
standard durable inbox carrier used by authenticated attachment lookup and
session export; image blocks never enter a text-only model request.

The service also registers `inspect_image`, an Agent tool for PNG, JPEG, WebP,
and GIF images. Its explicit `source` union supports both local file paths and
complete durable `attachment_ref` objects. File sources resolve through the Host
filesystem seam and are validated and persisted once; attachment sources resolve
through the Host attachment store and are verified without republishing. There
is no path-to-attachment fallback and opaque attachment identifiers are never
manufactured by the Agent. Both sources feed the same reference-only proxy
inference path; only their admission boundary differs. Tool results are
bounded, text-only, and explicitly untrusted, so text-only main-model routes
never receive an image block.

Consumers import the API from `@vascent/dsh-tui/vision`. The workspace is not
published independently and contains no terminal presentation code.

TypeScript under `src/` is the maintained implementation. Builds write ignored
runtime, declaration, and source-map artifacts to `dist/` for bundling by the
TUI workspace.

Vision policy lives in the `vision` settings namespace. Provider endpoints,
model catalogs, wire policy, and credentials remain owned by the selected LLM
Provider. Vision itself has no provider or model default; the TUI bundle
selects `bailian/qwen3.7-plus` in its composition layer.
