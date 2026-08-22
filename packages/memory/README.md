# DeepSeek Harness Memory

File-backed adaptive memory for DeepSeek Harness. Markdown is the authoritative store; the plugin loads bounded global and project indexes, exposes model-facing memory tools, and learns reusable corrections in quiet, logged maintenance sessions.

This workspace owns a public, terminal-independent API maintained in the
community extension repository. The TUI consumes its service to show memory
state and include mutations in the existing rewind workflow. Other Harness
clients import it from `@vascent/dsh-tui/memory`; the workspace is not published
as a separate npm artifact.

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
metadata and can therefore participate in source-attributed Rewind.

Project identity uses the normalized Git `origin` URL when available, including the repository name used in the directory prefix, so differently named clones and linked Worktrees share one memory directory on a synchronized memory root. Repositories without an origin use their Git common directory, which also unifies linked Worktrees. Non-Git directories fall back to their canonical path.

## Behavior

- `memory_write` handles explicit “remember this” requests and reusable corrections.
- `memory_read` opens the index or a topic file.
- `memory_forget` removes an exact summary.
- Sessions receive durable, source-attributed snapshots when effective global or project memory changes; disabling memory publishes an explicit replacement marker.
- Candidate correction turns are processed after the parent Agent becomes idle. A short-lived subagent is limited to the three memory tools, so the auxiliary request and writes remain in Harness session logs.
- Every write publishes an exact before/after mutation that clients can include
  in a source-attributed Rewind plan.
- Clients can call `ctx.memory.settle(sessionId)` before preparing a cross-domain
  transaction; it waits only for already-scheduled learning for that source
  session and does not start or cancel work.
- Secret-like values are rejected before files are created.

## Configuration

Mount the package after the base bundle:

```yaml
- id: memory
  name: '@vascent/dsh-tui/memory'
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

The workspace builds ESM runtime and declarations into ignored `dist/` output.
The release pipeline verifies and embeds that runtime in the public
`@vascent/dsh-tui` package; generated artifacts are not committed and this
workspace is not published independently.
