# DeepSeek Harness Community

Community-maintained extensions and a one-command terminal launcher for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This repository keeps the upstream Harness checkout separate and owns the integration layer:

```text
deepseek-harness-community/
├── bin/              # minimal JavaScript executable shims
├── src/launcher.ts   # typed profile setup and launcher implementation
├── packages/llm-bailian/ # first-class Bailian provider and model policy
├── packages/memory/  # Markdown-backed project memory plugin
├── packages/vision/  # image routing, proxy analysis, and staged evidence
├── packages/web/     # selectable Web search policy and page-reading providers
└── packages/tui/     # terminal UI bundle
```

## Install

Node.js `^22.19.0` or `>=24.0.0` is required. Install the launcher globally from npm:

```sh
npm install --global @vascent/dsh-tui
```

Then start the TUI from any project directory:

```sh
dscode
```

The first launch creates or updates the `tui` Harness profile under `~/.dsh`; later launches start immediately. Set `DASHSCOPE_API_KEY` for the bundled Bailian route or `DEEPSEEK_API_KEY` for DeepSeek Official before beginning a model-backed session. `web_search` automatically uses Tavily when `TAVILY_API_KEY` is configured and otherwise uses DeepSeek Official; `web_extract` uses Tavily. `/config web` changes the persisted search policy and reports every provider without displaying credential values. For image understanding with a text-only route, the bundle uses `bailian/qwen3.7-plus`; `/config vision` selects its routing mode. `DSH_HOME` continues to override the Harness data directory.

## Command line

`dscode` parses the requested action before touching a Harness profile. Help,
version output, completion generation, usage errors, and `doctor` therefore do
not initialize or repair the `tui` profile.

```text
dscode [options] [prompt...]
dscode resume <session-id> [options] [prompt...]
dscode resume --last [options] [prompt...]
dscode sessions [list] [--json]
dscode exec [-C <path>] [prompt...]
dscode doctor [--json]
dscode completion <bash|zsh|fish|powershell>
dscode config [show|default]
dscode plugin <pnpm-args...>
dscode -v | -V | --version
```

Interactive startup supports `-C`/`--cwd`, repeatable `-i`/`--image`,
`-m`/`--model`, `--effort`, `--permission-mode`, `--plan`, and `--no-color`.
`--resume <session-id>` remains accepted as a compatibility form. Use repeatable
`--patch <path>` options to apply Harness profile overlays.

`exec` runs one task through the upstream Harness headless profile and prints
its final assistant message. It accepts a positional prompt or piped stdin and
does not configure the TUI profile. `config` and `plugin` explicitly delegate
their work to the underlying `dsh` profile manager.
All three version aliases print the root package version as `dscode <version>`.

## Packages

- [`@vascent/dsh-tui`](package.json) is the only published npm package. It
  provides the launcher, bundled profile, and public TUI entry point.
- [`packages/tui`](packages/tui) owns the public terminal-client API and Cordis
  bundle implementation exposed as `@vascent/dsh-tui/tui`.
- [`packages/llm-bailian`](packages/llm-bailian) owns the first-class Bailian
  provider, endpoint validation, credential reference, common request
  policy, and schema-backed model capabilities exposed as
  `@vascent/dsh-tui/bailian`.
- [`packages/memory`](packages/memory) owns the public file-backed Memory API
  exposed as `@vascent/dsh-tui/memory`.
- [`packages/vision`](packages/vision) owns the public, terminal-independent
  Vision API exposed as `@vascent/dsh-tui/vision`.
- [`packages/web`](packages/web) owns the registry-driven search policy and
  page-extraction adapters exposed as `@vascent/dsh-tui/web`, while official
  Harness packages retain the model-tool contracts.

The five workspaces remain independently owned modules, but their manifests
block standalone registry publication. One npm artifact therefore exposes all
public APIs without creating separate package versions or release pipelines.
The long-term ownership boundaries and staged design are documented in
[`docs/tui-architecture.md`](docs/tui-architecture.md).
Functional milestones are tracked in
[`docs/tui-product-roadmap.md`](docs/tui-product-roadmap.md). The implemented
`v0.1.8` lifecycle contract is specified in
[`docs/tui-v0.1.8-design.md`](docs/tui-v0.1.8-design.md).

## Agent guidance

dscode's agent already knows who it is (the persona patch in
`packages/tui/cordis.patch.yml`) and what environment it runs in (the
Harness runtime-context snapshot). On top of that, the repository ships a
documentation-driven guidance layer:

- [`AGENTS.md`](AGENTS.md) at the repository root is a table of contents
  plus core facts, not a knowledge dump. Every dscode session working in
  this repository injects it automatically as its first-step instruction
  baseline (`dsh-agent-instructions`); nothing to configure. For global
  use across every project, copy it once:

  ```sh
  cp AGENTS.md ~/.dsh/AGENTS.md
  ```

  (It also ships inside the published npm package, so a global install
  provides it as `<npm prefix>/AGENTS.md`.)

- The details live as ordinary documentation and are loaded on demand with
  the agent's own `read` tool, guided by the catalog at the top of
  `AGENTS.md`:

  | Document | Read when |
  |---|---|
  | [`docs/dscode-configuration.md`](docs/dscode-configuration.md) | Config viewing/editing, providers, vision routing, web search policy, API keys |
  | [`docs/dscode-troubleshooting.md`](docs/dscode-troubleshooting.md) | Session errors, `dscode doctor` output, provider/key failures, upgrades |

  Both ship inside the npm package under `docs/`, so a globally installed
  copy is readable through `<npm prefix>/docs/` when the repository checkout
  is not at hand. Documentation stays a single source of truth in `docs/`;
  skills are reserved for procedural capabilities, not knowledge storage.

## Develop

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm dev
```

`pnpm dev` builds the current Bailian, Memory, Vision, Web, and TUI sources, then launches the local
bundle through an isolated `tui-dev` profile. It does not use the globally
installed `dscode` executable or modify the regular `tui` profile. Run it from the
project you want the agent to edit; pass TUI arguments after `--`, for example
`pnpm dev -- resume <session-id> --image screenshot.png`.

TypeScript under `src/` is the only maintained implementation. Builds write
ignored JavaScript, declarations, and source maps to each package's `dist/`;
release archives are written to the ignored root `artifacts/` directory. Neither
kind of generated output is committed.

`pnpm start` remains the production-equivalent local launcher and uses the
regular `tui` profile.

## Release

When moving to a new coordinated DeepSeek runtime train, update every manifest
and the lockfile through the single version source:

```sh
pnpm run runtime:update -- 0.1.0-rc.9
```

Run the same build, test, archive, dependency-tree, and isolated global-install
gate used by CI and publishing:

```sh
pnpm run release:check
```

Create a patch, minor, or major release from any authenticated development machine:

```sh
pnpm release patch
```

`release-it` verifies the branch and worktree, runs `release:check`, updates the
root version, creates the release commit and `v*` tag, and pushes them. GitHub
Actions repeats that exact gate while retaining its verified tarball, publishes
it through Trusted Publishing (OIDC), and attaches it to one GitHub Release.
Node, pnpm, npm, and the DeepSeek runtime train each have one repository-owned
version source. Local npm credentials and repository `NPM_TOKEN` secrets are not
used.
