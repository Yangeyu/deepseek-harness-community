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

Node.js `^22.19.0` or `>=24.0.0` is required. Install the launcher globally from npm:

```sh
npm install --global @vascent/dsh-tui
```

Then start the TUI from any project directory:

```sh
dsh-tui
```

The first launch creates or updates the `tui` Harness profile under `~/.dsh`; later launches start immediately. Set `DEEPSEEK_API_KEY` before beginning a model-backed session. `DSH_HOME` continues to override the Harness data directory.

## Packages

- [`packages/tui`](packages/tui) is the private terminal-client workspace with the profile patch, streaming transcript, diffs, rewind checkpoints, model selection, and memory UI.
- [`packages/memory`](packages/memory) is the private file-backed memory workspace with explicit remember/forget tools and correction learning.

Both workspaces are source modules managed in this GitHub repository. They are embedded in `@vascent/dsh-tui` and are not published as standalone npm packages.
The long-term ownership boundaries and staged design are documented in
[`docs/tui-architecture.md`](docs/tui-architecture.md).

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
`pnpm dev -- --resume <session-id>`.

`pnpm start` remains the production-equivalent local launcher and uses the
regular `tui` profile.

## Release

Create a patch, minor, or major release from any authenticated development machine:

```sh
pnpm release patch
```

`release-it` verifies the branch and worktree, runs the complete checks, updates the root version, creates the release commit and `v*` tag, and pushes them. GitHub Actions then builds the single installable package, publishes it to npm through Trusted Publishing (OIDC), and creates the GitHub Release. Local npm credentials and repository `NPM_TOKEN` secrets are not used. All source code stays in this GitHub repository; the private plugin workspaces are embedded in the root distribution.

Each npm package needs a one-time bootstrap publish before its Trusted Publisher can be configured. See [npm's Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers/) when applying this release pattern to another repository.

After that first publish, an npm account with package write access and 2FA can bind the package to its workflow without creating a token:

```sh
npm exec --package=npm@^11.15.0 -- npm trust github @scope/package \
  --repo owner/repository \
  --file release.yml \
  --allow-publish
```

The package `repository.url`, GitHub owner/repository, and workflow filename are exact, case-sensitive identifiers. A monorepo configures this trust once for each independently published package.
