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

## ChatGPT subscription models

Run `npm run dev` locally, then `/connect` → **OpenAI Codex** to sign in with
your ChatGPT subscription. Choose browser or device-code login, complete the
provider's authorization instructions, and select an `openai-codex` model in
`/model`.
`/connect openai-codex` signs in again when you need to change accounts.

This is direct model inference through Harness's existing pi-ai provider. Harness
continues to own the agent loop, tools, permissions, Memory, Rewind and session
history. No Codex CLI or App Server is launched. OAuth tokens and refresh remain
with the upstream provider and Host credential store; the terminal only handles
login instructions and input. API-key OpenAI and ChatGPT subscriptions are distinct
provider routes. Model availability remains account-dependent. This is a third-party
compatibility integration; official OAuth application authorization for dscode has
not been established.

Credentials persist in the DSH credential store, so a Codex CLI login is not
automatically imported. Esc cancels an authorization attempt without changing
the selected model. Browser login supports pasting the redirect URL when the
callback cannot reach the terminal; device-code login supports remote terminals.
`/connect` currently offers the Codex subscription connection. `/model` selects a
model independently; the provider resolves and validates credentials when called.

Opening `/model` refreshes the Host catalog without changing the current
selection. DeepSeek's catalog and model capabilities come from the upstream
provider and its settings; refreshing does not query DeepSeek's `/models` API.

`/usage` reads the selected provider's subscription quotas on demand. For
`openai-codex`, it shows remaining percentages and local reset times for every
reported window, including separate model quotas such as Spark. Window lengths
come from the server; an absent 5-hour or weekly window is not inferred. This is
account-wide quota, separate from the current session's token statistics. Other
providers currently report that subscription usage is unavailable.

`/copy` copies the latest completed assistant reply in the current conversation
to the clipboard, preserving Markdown and excluding reasoning and tool output.

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

公开版本号只存于根 `package.json`，私有 workspace 不维护独立版本。
在已合入待发布变更的 `main` 分支、干净工作区执行：

```sh
pnpm exec npm version patch -m "chore: release v%s"
version=$(node --print "require('./package.json').version")
git push --atomic origin main "refs/tags/v${version}"
```

第一条命令更新版本号并创建版本提交和 tag；需要时将 `patch` 换成 `minor` 或 `major`。
推送 `vX.Y.Z` tag 后自动启动 Release，无需等待另一条 CI 后再手动触发发布。
tag 必须与该提交的 `package.json` 版本一致；当前只发布稳定版本。

Release 内依次完成 Linux/macOS 检查、版本身份与候选包验收、npm 发布及 GitHub Release
创建。双平台检查复用 `ci.yml` 的 `workflow_call`，检查的就是 tag 对应提交；日常
main/PR CI 继续独立自动运行，不是发布流程的人工前置条件。

候选验收只打包一份 tarball，记录源码 SHA 和产物 SHA-256，并执行全新安装及真实
80×24 PTY 启动验证。后续 job 按最小权限通过 Trusted Publishing（OIDC）发布 npm 包，
将同一份 tarball 附加到已有 tag 的 GitHub Release。工作流不修改版本号，也不创建或移动 tag。

正常流程以 `npm publish` 和 GitHub Release 创建/上传命令的成功结果为准，
不在发布后轮询 npm 或重新下载产物；npm 接受发布后，包仍可能需要几分钟才可下载。
下游发布步骤失败时使用 Actions 的 **Re-run failed jobs** 复用已验收的候选包，
不要移动或重新推送 tag。仅在重跑中，npm 步骤先查询一次对应版本：已存在则校验
产物一致性并继续，否则尝试发布。既有产物冲突会失败，不覆盖已发布内容。

Node、pnpm、npm、公开包版本及 DeepSeek runtime train 各自只有一个仓库内版本来源。
发布不使用本地 npm 凭据或仓库 `NPM_TOKEN` secret。
