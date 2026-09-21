# DeepSeek Harness Vision

This workspace owns terminal-independent proxy image analysis and the
`inspect_image` tool. The official Attachment store and provider adapters remain
the media core: Vision does not decode images, derive dimensions, normalize
bytes, or serialize native-provider requests.

## Service contract

- `resolveProxyRoute(signal?)` resolves the configured proxy to a verified image
  route or an actionable disabled result. It does not inspect the main model.
- `analyze(route, { analysisId, userText, images }, signal?)` saves images through
  the official Attachment store and returns `analysisId`, provider result
  metadata, `observation`, and `references`. The observation is the sanitized raw
  body limited to `maxObservationChars`; it has no evidence wrapper or truncation
  suffix. `truncated` records either character truncation or a provider token
  limit. References correspond one-to-one with attachments in input order.
- `status(signal?)` reports live config and proxy capabilities; `setMode(mode)`
  updates the live `vision` settings namespace.

Callers generate analysis identities and own native-image routing, evidence
formatting, persistence, and session submission. Vision owns no session queue,
steering, admission adapter, or custom message/content-block types. The TUI
persists the returned data as standard text evidence and passes that same text
to the main model.

## Image inspection

`inspect_image` supports PNG, JPEG, WebP, and GIF. Unless proxy mode is forced,
execution first checks the current main model: an image-capable model is native
and the tool rejects with guidance to use the inline image or `read_image`.
`disabled` disables only the proxy, not native image input. Text-only routes use
`resolveProxyRoute`.

The explicit `source` union supports local file paths and complete durable
`attachment_ref` objects. File sources resolve through the Host filesystem seam
and declare media type by extension; the official Attachment store validates
and normalizes their bytes. Existing attachments are verified without
republishing. There is no path-to-attachment fallback, and attachment identifiers
are never manufactured by the Agent. Tool results are bounded, text-only, and
explicitly wrapped as untrusted visual evidence.

Consumers import the API from `@vascent/dsh-tui/vision`. The workspace is not
published independently and contains no terminal presentation code. TypeScript
under `src/` is maintained; builds write ignored runtime and declaration
artifacts to `dist/` for bundling by the TUI workspace.

Provider endpoints, model catalogs, wire policy, and credentials remain owned
by the selected LLM Provider. Vision has no provider or model default; the TUI
bundle selects `bailian/qwen3.7-plus` in its composition layer.
