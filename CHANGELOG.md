# Changelog

## 0.1.0

- Add Markdown-backed global and project memory.
- Add model-facing read, write, and forget tools.
- Add durable memory-context injection and idle background learning.
- Replace retained context snapshots when memory changes or session use is disabled.
- Expose status, policy, document, and reversible mutation APIs for terminal clients.
- Restore multi-file memory mutations with full stale-state preflight and
  failure compensation.
