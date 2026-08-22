# DeepSeek Harness Community

Community-maintained extensions and a one-command terminal launcher for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This repository keeps the upstream Harness checkout separate and owns the integration layer:

```text
deepseek-harness-community/
├── bin/              # minimal JavaScript executable shims
├── src/launcher.ts   # typed profile setup and launcher implementation
├── packages/llm-bailian/ # first-class Bailian provider and model policy
├── packages/memory/  # Markdown-backed project memory plugin
├── packages/vision/  # image route policy, proxy analysis, and evidence admission
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

The TUI has no React dependency. The official `@deepseek-ai/dsh` executable is
the profile/plugin manager used by the launcher and currently brings its Web UI
and React graph transitively; removing that graph would require replacing the
official boot path rather than simplifying this package.

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
Use repeatable `--patch <path>` options to apply Harness profile overlays.

`exec` runs one task through the upstream Harness headless profile and prints
its final assistant message. It accepts a positional prompt or piped stdin and
does not configure the TUI profile. `config` and `plugin` explicitly delegate
their work to the underlying `dsh` profile manager.
All three version aliases print the root package version as `dscode <version>`.

## Packages

- [`@vascent/dsh-tui`](package.json) is the only published npm package. It
  provides the launcher, bundled profile, and public TUI entry point.
- [`packages/tui`](packages/tui) owns the public terminal-client API and private
  Cordis Bundle implementation exposed by the package root `@vascent/dsh-tui`.
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
[`docs/tui-product-roadmap.md`](docs/tui-product-roadmap.md). Implemented
per-version contracts live in the architecture document; a standalone
`docs/tui-v0.1.x-design.md` exists only while its target version is being
designed and is removed once the version lands.

## Agent guidance

dscode's agent already knows who it is (the persona patch in
`packages/tui/cordis.patch.yml`) and what environment it runs in (the
Harness runtime-context snapshot). On top of that, the repository ships a
documentation-driven guidance layer:

- [`AGENTS.md`](AGENTS.md) at the repository root is the developer instruction
  entry point. Every dscode session working in this repository injects it
  automatically (`dsh-agent-instructions`); it is not part of the npm runtime
  artifact and should not be deployed as global user guidance.

- For global use across every project, deploy the user-facing
  [`guides/AGENTS.md`](guides/AGENTS.md) instead:

  ```sh
  cp guides/AGENTS.md ~/.dsh/AGENTS.md
  mkdir -p ~/.dsh/docs
  cp guides/docs/*.md ~/.dsh/docs/
  ```

- The details live as ordinary documentation and are loaded on demand with
  the agent's own `read` tool, guided by the catalog at the top of
  `guides/AGENTS.md`:

  | Document | Read when |
  |---|---|
  | [`guides/docs/configuration.md`](guides/docs/configuration.md) | Config viewing/editing, providers, vision routing, web search policy, API keys |
  | [`guides/docs/troubleshooting.md`](guides/docs/troubleshooting.md) | Session errors, `dscode doctor` output, provider/key failures, upgrades |

  Both ship inside the npm package under `guides/docs/`, and should be deployed
  to `~/.dsh/docs/` for agent access. Project-specific documentation (architecture,
  design, roadmap) stays in `docs/` and is not distributed with the package.
  Skills are reserved for procedural capabilities, not knowledge storage.

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
ignored JavaScript and declarations to each package's `dist/`; release archives
are written to the ignored root `artifacts/` directory. Generated output is not
committed, and source maps are not generated or published.

`pnpm start` remains the production-equivalent local launcher and uses the
regular `tui` profile.

## Release

The coordinated DeepSeek runtime version lives once in the named `dsh` catalog
inside `pnpm-workspace.yaml`. Change the anchored value and let pnpm update the
lockfile normally:

```sh
pnpm install
```

Every workspace manifest refers to `catalog:dsh`, so an upgrade never requires
distributing the same version across package files. `pnpm pack` replaces the
catalog protocol with the concrete version in the published root manifest.

The public distribution version lives only in the root `package.json`. Private
workspaces deliberately have no independent versions. Prepare a release by
changing that one committed value, for example:

```sh
pnpm exec npm version patch --no-git-tag-version
git add package.json
git commit -m "chore: prepare vX.Y.Z"
git push
```

Use `minor` or `major` in place of `patch` when that is the intended semantic
change. The version change is an ordinary reviewed source commit; the release
workflow never writes back to `main`.

After CI succeeds for that exact `origin/main` commit, trigger the remote
release transaction from an authenticated development machine:

```sh
pnpm release
```

The workflow accepts no version input and performs no version mutation. It
requires successful CI for the exact source commit, builds one tarball, records
its source and SHA-256 in a receipt, then performs one strict fresh install and
real 80x24 PTY startup check. Separate least-privilege jobs tag that exact
commit, publish the retained tarball through Trusted Publishing (OIDC), and
attach the same bytes to one GitHub Release. Retried downstream jobs reuse the
accepted candidate and reconcile only identical tag and artifact state, so a
partial external failure cannot silently replace a release. Routine Linux and
macOS CI owns the full
`pnpm check`; release acceptance does not duplicate its lint, typecheck, or test
passes. Node, pnpm, npm, the public package, and the DeepSeek runtime train each
have one repository-owned version source. Local npm credentials and repository
`NPM_TOKEN` secrets are not used.
