# Internal TUI Bundle

This private workspace is the terminal-facing Cordis Bundle embedded in the
single public `@vascent/dsh-tui` package. Do not install or publish it
independently; the root launcher adds this lean Bundle directory to the Harness
profile. That keeps the launcher/official CLI and Cordis Bundle dependency
identities separate, while the local profile link reuses the already installed
distribution without a second registry install.

The current contracts and ownership boundaries live in
[`../../docs/tui-architecture.md`](../../docs/tui-architecture.md). Milestones
live in [`../../docs/tui-product-roadmap.md`](../../docs/tui-product-roadmap.md).
Historical behavior belongs in Git history and GitHub Releases, not in this
README or private-workspace release files.

Development uses the repository commands:

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm dev
pnpm check
```

Input is resolved through one fixed semantic binding table in
`src/input/keymap.ts`. Image paste uses `Ctrl+V`; configuration does not carry a
second keymap or selectable preset.
