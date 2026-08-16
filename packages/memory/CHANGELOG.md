# Changelog

## Unreleased

- Expose the Memory API through `@vascent/dsh-tui/memory` while retaining one
  release artifact.
- Share project memory across linked Git Worktrees and differently named clones.
- Migrate existing local-directory-based memory into the stable repository directory.

## 0.1.0

- Add Markdown-backed global and project memory.
- Add model-facing read, write, and forget tools.
- Add durable memory-context injection and idle background learning.
- Replace retained context snapshots when memory changes or session use is disabled.
- Expose status, policy, document, and reversible mutation APIs for terminal clients.
- Restore multi-file memory mutations with full stale-state preflight and
  failure compensation.
