# DeepSeek Harness Vision

This workspace owns the public, terminal-independent policy for resolving one
image route per submission, running proxy fallback inference, and admitting
source-attributed observations into supported user-message events. The official
Host, Attachment service, and provider adapters remain the sole media core:
Vision does not decode images, derive dimensions, normalize bytes, or serialize
native-provider requests. The official Attachment store persists proxy images;
a complete pre-admission carrier keeps their standard image blocks available
until `pre-step` emits the human Prompt and source-attributed evidence. Image
blocks never enter a text-only model request.

The service also registers `inspect_image`, an Agent tool for PNG, JPEG, WebP,
and GIF images. Its schema is stable, but execution first resolves the current
route: native `auto` routes reject before source parsing, while text-only `auto`
and forced `proxy` routes proceed. Its explicit `source` union supports both
local file paths and complete durable `attachment_ref` objects. File sources
resolve through the Host filesystem seam and declare media type by extension;
the official Attachment store validates and normalizes their bytes. Existing
attachments are verified without republishing. There is no path-to-attachment
fallback and opaque attachment identifiers are never manufactured by the
Agent. Both sources feed the same reference-only proxy inference path. Tool
results are bounded, text-only, and explicitly untrusted.

The current Agent API admits one message at a time, so a stateless `pre-step`
adapter expands one complete proxy carrier into the exact human Prompt and its
evidence message. It owns no staging Map, expiry, or discard lifecycle and can
be removed when upstream supports atomic multi-message admission.

Consumers import the API from `@vascent/dsh-tui/vision`. The workspace is not
published independently and contains no terminal presentation code.

TypeScript under `src/` is the maintained implementation. Builds write ignored
runtime, declaration, and source-map artifacts to `dist/` for bundling by the
TUI workspace.

Vision policy lives in the `vision` settings namespace. Provider endpoints,
model catalogs, wire policy, and credentials remain owned by the selected LLM
Provider. Vision itself has no provider or model default; the TUI bundle
selects `bailian/qwen3.7-plus` in its composition layer.
