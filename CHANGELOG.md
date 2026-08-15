# Changelog

All notable changes to this project are documented in this file.

## Unreleased

- Add application-owned conversation scrolling with pointer and PageUp/PageDown
  navigation while preserving local Thinking and Diff viewports.
- Render submitted prompts immediately, hand presentation to visible queue
  snapshots, and retire local state on durable user-message RPC identity.
- Show explicit checkpoint preview, workspace restore, conversation rewind,
  session reload, and failure rollback progress without unlocking the composer.
- Replace last-turn-only rewind with an instant bounded checkpoint selector,
  keyboard navigation, asynchronous file counts, and selected-node restore.
- Add input history navigation and an optimistic `/clear` session transition
  with failure recovery.
- Replace prompt `Sending`/`Accepted` phases and the duplicate running status
  row with one animated transcript loader that yields to the first visible
  Thinking, answer, or tool output.
- Report checkpoint file counts per turn instead of cumulative rollback scope,
  and align confirmation with a vertical Claude Code-style choice surface.
- Preserve checkpoints before the restored turn on the forked conversation so
  rewind can be used repeatedly until its retained history is exhausted.

## 0.1.0 - 2026-08-15

- Add the DeepSeek Harness terminal profile bundle and in-process API client.
- Add streaming Markdown, model selection, usage statistics, and interaction dialogs.
- Add mouse-only expandable thinking blocks and Claude Code-style file edit cards.
- Add coordinated last-turn workspace and conversation rewind.
