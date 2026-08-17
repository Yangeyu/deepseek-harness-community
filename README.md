# DeepSeek Harness Community

Community-maintained extensions and a one-command terminal launcher for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This repository keeps the upstream Harness checkout separate and owns the integration layer:

```text
deepseek-harness-community/
├── bin/              # minimal JavaScript executable shims
├── src/launcher.ts   # typed profile setup and launcher implementation
├── packages/memory/  # Markdown-backed project memory plugin
├── packages/vision/  # image routing, proxy analysis, and staged evidence
└── packages/tui/     # terminal UI bundle
```

## Install

Node.js `^22.19.0` or `>=24.0.0` is required. Install the launcher globally from npm:

```sh
npm install --global @vascent/dsh-tui
```

Then start the TUI from any project directory:

```sh
dsh-tui
```

The first launch creates or updates the `tui` Harness profile under `~/.dsh`; later launches start immediately. Set `DEEPSEEK_API_KEY` before beginning a model-backed session. For image understanding with a text-only DeepSeek route, set `DASHSCOPE_API_KEY`, open `/config vision`, and confirm the recommended `qwen3.7-plus` route. `DSH_HOME` continues to override the Harness data directory.

## Command line

`dsh-tui` parses the requested action before touching a Harness profile. Help,
version output, completion generation, usage errors, and `doctor` therefore do
not initialize or repair the `tui` profile.

```text
dsh-tui [options] [prompt...]
dsh-tui resume <session-id> [options] [prompt...]
dsh-tui resume --last [options] [prompt...]
dsh-tui sessions [list] [--json]
dsh-tui exec [-C <path>] [prompt...]
dsh-tui doctor [--json]
dsh-tui completion <bash|zsh|fish|powershell>
dsh-tui config [show|default]
dsh-tui plugin <pnpm-args...>
dsh-tui -v | -V | --version
```

Interactive startup supports `-C`/`--cwd`, repeatable `-i`/`--image`,
`-m`/`--model`, `--effort`, `--permission-mode`, `--plan`, and `--no-color`.
`--resume <session-id>` remains accepted as a compatibility form. Use repeatable
`--patch <path>` options to apply Harness profile overlays.

`exec` runs one task through the upstream Harness headless profile and prints
its final assistant message. It accepts a positional prompt or piped stdin and
does not configure the TUI profile. `config` and `plugin` explicitly delegate
their work to the underlying `dsh` profile manager.
All three version aliases print the root package version as `dsh-tui <version>`.

## Packages

- [`@vascent/dsh-tui`](package.json) is the only published npm package. It
  provides the launcher, bundled profile, and public TUI entry point.
- [`packages/tui`](packages/tui) owns the public terminal-client API and Cordis
  bundle implementation exposed as `@vascent/dsh-tui/tui`.
- [`packages/memory`](packages/memory) owns the public file-backed Memory API
  exposed as `@vascent/dsh-tui/memory`.
- [`packages/vision`](packages/vision) owns the public, terminal-independent
  Vision API exposed as `@vascent/dsh-tui/vision`.

The three workspaces remain independently owned modules, but their manifests
block standalone registry publication. One npm artifact therefore exposes all
public APIs without creating separate package versions or release pipelines.
The long-term ownership boundaries and staged design are documented in
[`docs/tui-architecture.md`](docs/tui-architecture.md).
Functional milestones are tracked in
[`docs/tui-product-roadmap.md`](docs/tui-product-roadmap.md). The implemented
`v0.1.8` lifecycle contract is specified in
[`docs/tui-v0.1.8-design.md`](docs/tui-v0.1.8-design.md).

## Develop

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm dev
```

`pnpm dev` builds the current Memory and TUI sources, then launches the local
bundle through an isolated `tui-dev` profile. It does not use the globally
installed `dsh-tui` package or modify the regular `tui` profile. Run it from the
project you want the agent to edit; pass TUI arguments after `--`, for example
`pnpm dev -- resume <session-id> --image screenshot.png`.

TypeScript under `src/` is the only maintained implementation. Builds write
ignored JavaScript, declarations, and source maps to each package's `dist/`;
release archives are written to the ignored root `artifacts/` directory. Neither
kind of generated output is committed.

`pnpm start` remains the production-equivalent local launcher and uses the
regular `tui` profile.

## Release

Create a patch, minor, or major release from any authenticated development machine:

```sh
pnpm release patch
```

`release-it` verifies the branch and worktree, runs the complete checks, updates
the root version, creates the release commit and `v*` tag, and pushes them.
GitHub Actions then builds and packs the single `@vascent/dsh-tui` artifact,
publishes it through Trusted Publishing (OIDC), and attaches it to one GitHub
Release. Local npm credentials and repository `NPM_TOKEN` secrets are not used.
