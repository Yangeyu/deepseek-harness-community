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
├── projects/
│   └── <project-name>-<identity>/
│       ├── MEMORY.md
│       ├── preferences.md
│       ├── conventions.md
│       ├── decisions.md
│       └── debugging.md
└── sessions/
    └── <sha256-session-id>.json
```

`MEMORY.md` is the compact cross-session index. Keep summaries short and useful for deciding when a memory applies; put rationale and supporting user evidence in topic files, read on demand through `memory_read`. Prefer reusable corrections, preferences and non-obvious decisions over conversation logs or copies of current code and project instructions. No database is authoritative or required.

Direct edits and file synchronization are supported because Markdown remains
the source of truth. Only writes made through the plugin carry source-turn
metadata and can therefore participate in source-attributed Rewind.

Project identity uses the normalized Git `origin` URL when available, including the repository name used in the directory prefix, so differently named clones and linked Worktrees share one memory directory on a synchronized memory root. Repositories without an origin use their Git common directory, which also unifies linked Worktrees. Non-Git directories fall back to their canonical path.

## Behavior

- `memory_write` handles explicit “remember this” requests and reusable corrections.
- `memory_read` opens the index or a topic file.
- `memory_forget` removes an exact summary.
- Stable usage guidance is registered in the system prompt. Sessions receive durable, source-attributed index snapshots when effective global or project memory changes; disabling memory publishes an explicit replacement marker. Current requests override historical defaults; a temporary exception should not become a lasting preference.
- Snapshots reserve space for both scopes and select complete index entries, not truncated strings. Omitted entries are identified with a scope-specific `memory_read` prompt; full indexes and topic files remain unchanged on disk. Structured documents that cannot safely be split are omitted as a whole when they do not fit.
- Candidate correction turns are processed after the parent Agent becomes idle. Complete user messages take precedence over assistant messages within the extraction budget; a turn whose user evidence does not fit is skipped rather than partially remembered. The existing keyword gate is only a best-effort backstop, not a semantic classifier or a replacement for explicit main-agent memory tools. A short-lived subagent is limited to the three memory tools, so the auxiliary request and writes remain in Harness session logs.
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

`maxContextBytes` must be at least 256 bytes to fit scope labels, omission guidance and closed context markers. Its default remains 25,600 bytes; this is a ceiling, not a target index size. Keep the root index concise and read relevant detail on demand. `extractionMaxInputBytes` bounds the serialized conversation JSON, not the entire maintenance prompt.

`extractionProvider` and `extractionModel` may be configured together to give maintenance sessions a dedicated route. When omitted, they use the parent Agent route.

Session clients await `ctx.memory.setPolicy(sessionId, patch)` to persist memory
switches without changing deployment defaults. `ctx.memory.policy(sessionId)`
also returns a Promise. Disabling learning resolves after queued and active
learning has been canceled and drained. Failed child cleanup rejects the call
and publishes error activity; the disabled policy remains persisted. The TUI
displays the acknowledged policy. After a failed operation it reads the current
policy and shows it alongside the error; an unreadable policy is shown as unknown.

The [context and learning quality contract](../../docs/tui-architecture.md#memory-上下文与学习质量) defines selection, evidence preservation and evaluation limits. Session policy ownership, recovery, and cancellation boundaries remain defined in
[the session policy contract](../../docs/tui-architecture.md#memory-session-policy-and-learning).

## Develop

```sh
cd ../..
pnpm install --frozen-lockfile
pnpm run check
```

Two opt-in real-model suites share the same isolated Agent runner:

- `pnpm test:memory:e2e`: lifecycle acceptance (36 model calls maximum): explicit remembering, cross-process recall, current overrides, policy restoration, update/forget, background learning and cancellation.
- `pnpm test:memory:quality`: learning-to-reuse comparisons (64 model calls maximum): historical corrections, configuration decisions, temporary exceptions, irrelevant memory and stale validation clues. The model first writes memory from historical feedback; fresh processes then answer identical tasks with and without memory access. The no-memory arm may honestly report unknown history. Evaluation copies stay read-only; a separate learning-enabled branch checks that a temporary exception does not persist.

Both read `agent-default-model` from user settings and use the existing public
Bailian or `dsh-llm-pi-ai` adapter. Bailian keeps the repository's provider defaults;
pi-ai uses the selected provider's configured profile or catalog defaults. Run
`node scripts/memory-e2e.mjs --preflight` after building to check route registration
without a model call or credential loading. It does not validate authentication.
For environment-backed API keys, export the configured reference before running.
Live execution uses the normal credential provider internally: OAuth refresh or
legacy credential-format migration may update the authentication store, but
settings and real Memory directories are not modified. No credentials are copied
into scenario specs or artifacts.

Model calls may incur charges. Foreground requests set `maxTokens: 2000`, and
maintenance retains its 900-token setting. Adapter retries are disabled for the
run; each worker has a 150-second turn deadline and a 180-second process timeout.
The caps count canonical `llm/stream` attempts, not every HTTP/OAuth request or
exact provider charges. A crashed worker without a readable result marks the
report's request count incomplete. Canonical LLM requests/usage, assistant responses, tool events, mutations and
scores are saved under ignored `artifacts/memory-{e2e,quality}-*/`. The runner does
not intercept HTTP or authentication responses. Temporary Memory files are removed.

To revise grading without more model calls, run
`node scripts/memory-e2e.mjs --rescore artifacts/memory-quality-<run>/report.json`.
Keep the worker JSON files beside that report. Rescoring requires successful
worker evidence and unchanged history/task prompts; it writes a separate
`report-rubric-<version>.json`, preserving the original failure report. It does
not validate a changed Memory implementation; that needs a new live run.

`generateMemories: false` disables background learning, not foreground memory
tools. Background-only lifecycle tests restrict the main agent's tool access
at runtime instead of assuming it always obeys a natural-language no-tools request.

The quality corpus reconstructs two confirmed project-preference summaries and
adds synthetic controls; it is not a raw production-history replay. Small-sample
structured-field scores test specific behaviors, not overall answer quality.
These suites exercise the real Agent loop and provider, but do not drive the
terminal UI or resume persisted conversation history. See the
[quality evaluation contract](../../docs/tui-architecture.md#memory-质量回放).

The workspace builds ESM runtime and declarations into ignored `dist/` output.
The release pipeline verifies and embeds that runtime in the public
`@vascent/dsh-tui` package; generated artifacts are not committed and this
workspace is not published independently.
