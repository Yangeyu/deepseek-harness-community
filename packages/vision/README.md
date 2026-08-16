# DeepSeek Harness Vision

Private community workspace providing model-capability routing, image proxy
analysis, and source-attributed observations staged into supported user-message
events.

The workspace is bundled into the public `@vascent/dsh-tui` package through its
`./vision` subpath. It is not published independently and contains no terminal
presentation code.

TypeScript under `src/` is the maintained implementation. Builds write ignored
runtime, declaration, and source-map artifacts to `dist/` for bundling by the
TUI workspace.

Vision policy lives in the `vision` settings namespace. Provider endpoints,
model catalogs, and credential references remain owned by the Harness
`llm-pi-ai` settings namespace.
