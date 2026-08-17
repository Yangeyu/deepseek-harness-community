# DeepSeek Harness Vision

This workspace owns the public, terminal-independent API for model-capability
routing, image proxy analysis, and two-phase admission of source-attributed
observations into supported user-message events. Proxy media stays in the
standard durable inbox carrier used by authenticated attachment lookup and
session export; image blocks never enter a text-only model request.

The service also registers `inspect_image`, a workspace-contained Agent tool
for PNG, JPEG, WebP, and GIF files. Composer admission and tool inspection share
one proxy inference path and the same attachment validation limits; only their
observation context differs. Tool results are bounded, text-only, and explicitly
untrusted, so text-only main-model routes never receive an image block.

Consumers import the API from `@vascent/dsh-tui/vision`. The workspace is not
published independently and contains no terminal presentation code.

TypeScript under `src/` is the maintained implementation. Builds write ignored
runtime, declaration, and source-map artifacts to `dist/` for bundling by the
TUI workspace.

Vision policy lives in the `vision` settings namespace. Provider endpoints,
model catalogs, wire policy, and credentials remain owned by the selected LLM
Provider. Vision itself has no provider or model default; the TUI bundle
selects `bailian/qwen3.7-plus` in its composition layer.
