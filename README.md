# DeepSeek Harness Community

Community-maintained extensions and a one-command terminal launcher for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This repository keeps the upstream Harness checkout separate and owns the integration layer:

```text
deepseek-harness-community/
├── packages/memory/  # Markdown-backed project memory plugin
├── packages/tui/     # terminal UI bundle
└── src/launcher.js   # profile setup and dsh-tui launcher
```

## Install

Node.js `^22.19.0` or `>=24.0.0` is required. Install a tagged GitHub release globally:

```sh
npm install --global https://github.com/Yangeyu/deepseek-harness-community/releases/download/v0.1.1/yangeyu-dsh-tui-0.1.1.tgz
```

Then start the TUI from any project directory:

```sh
dsh-tui
```

The release tarball avoids npm's unreliable lifecycle handling for large Git-source dependency trees. The first launch creates or updates the `tui` Harness profile under `~/.dsh`; later launches start immediately. Set `DEEPSEEK_API_KEY` before beginning a model-backed session. `DSH_HOME` continues to override the Harness data directory.

## Packages

- [`@yangeyu/deepseek-harness-tui`](packages/tui) provides the terminal client, profile patch, streaming transcript, diffs, rewind checkpoints, model selection, and memory UI.
- [`@yangeyu/deepseek-harness-memory`](packages/memory) provides file-backed global and per-project memory with explicit remember/forget tools and correction learning.

The TUI bundle embeds the Memory runtime in its `./memory` entry so a GitHub installation has no unpublished registry dependency. The standalone Memory package remains available for other Harness profiles.

## Develop

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm run start -- --help
```

Run `pnpm run start` from the project you want the agent to edit. The launcher uses the local workspace TUI package and the published `@deepseek-ai/dsh` CLI.

## Release

Tags named `v*` run the complete checks and create a GitHub Release containing installable tarballs. npm package manifests are public-ready, but npm publication is a separate authenticated step.
