# DeepSeek Harness Memory

File-backed adaptive memory for DeepSeek Harness. Markdown is the authoritative store; the plugin loads bounded global and project indexes, exposes model-facing memory tools, and learns reusable corrections in quiet, logged maintenance sessions.

This is a third-party Harness plugin maintained in the community extension
monorepo, outside the upstream `packages/` tree. The TUI consumes its public
service to show memory state and include mutations in the existing rewind
workflow.

## Storage

```text
~/.dsh/memories/
├── global/
│   ├── MEMORY.md
│   └── preferences.md
└── projects/
    └── <project-name>-<identity>/
        ├── MEMORY.md
        ├── preferences.md
        ├── conventions.md
        ├── decisions.md
        └── debugging.md
```

`MEMORY.md` is the bounded cross-session index. Topic files hold optional detail and are read on demand through `memory_read`. No database is authoritative or required.

Direct edits and file synchronization are supported because Markdown remains
the source of truth. Only writes made through the plugin carry source-turn
metadata and can therefore participate in client checkpoint rewind.

Project identity uses the normalized Git `origin` URL when available, so clones of the same repository share one memory directory on a synchronized memory root. Non-Git directories fall back to their canonical path.

## Behavior

- `memory_write` handles explicit “remember this” requests and reusable corrections.
- `memory_read` opens the index or a topic file.
- `memory_forget` removes an exact summary.
- Sessions receive durable, source-attributed snapshots when effective global or project memory changes; disabling memory publishes an explicit replacement marker.
- Candidate correction turns are processed after the parent Agent becomes idle. A short-lived subagent is limited to the three memory tools, so the auxiliary request and writes remain in Harness session logs.
- Every write publishes an exact before/after mutation that clients can include in their existing rewind checkpoint.
- Secret-like values are rejected before files are created.

## Configuration

Mount the package after the base bundle:

```yaml
- id: memory
  name: '@yangeyu/deepseek-harness-memory'
  config:
    root: !!js dshHomePath('memories')
    useMemories: true
    generateMemories: true
    idleDelayMs: 1500
    maxContextBytes: 25600
    maxDocumentBytes: 262144
    maxSummaryChars: 600
    maxDetailsChars: 4000
    extractionMaxInputBytes: 32768
    minCandidateChars: 6
```

`extractionProvider` and `extractionModel` may be configured together to give maintenance sessions a dedicated route. When omitted, they use the parent Agent route.

Session clients can call `ctx.memory.setPolicy()` to disable memory use or learning for the current session without changing deployment defaults.

## Develop

```sh
cd ../..
pnpm install --frozen-lockfile
pnpm run check
```

The package builds ESM runtime and declarations into `lib/`. Verified `lib/`
artifacts are committed so GitHub and local-path installation do not depend on
a target-machine build. The TUI embeds this runtime for its GitHub release but
the standalone package remains independently publishable.
