import type { TerminalCommandDefinition } from '../contracts.ts'
import type { HistoryEntry } from '../../../runtime/session/contracts.ts'

export interface CopyReplySession {
  readonly current: {
    readonly events: readonly HistoryEntry[]
    readonly historyHasMore: boolean
  }
  captureSession(): { readonly active: boolean }
  loadEarlierHistory(): Promise<boolean>
  notice(message: string): void
}

/** Read completed history, page only when needed, then copy the original Markdown. */
export function createCopyCommand(
  session: CopyReplySession,
  clipboardText: (text: string) => Promise<void>,
  signal: AbortSignal,
): TerminalCommandDefinition {
  return {
    name: 'copy',
    description: 'Copy the latest completed assistant reply to the clipboard',
    async handler() {
      let text = latestAssistantText(session.current.events)
      if (text === undefined && session.current.historyHasMore) {
        // An empty, unbound conversation can report no reply without a Session capture.
        const captured = session.captureSession()
        while (text === undefined && session.current.historyHasMore) {
          const loaded = await session.loadEarlierHistory()
          if (signal.aborted || !captured.active) return
          if (!loaded) break
          text = latestAssistantText(session.current.events)
        }
      }
      if (text === undefined) {
        session.notice('No completed assistant reply to copy.')
        return
      }
      await clipboardText(text)
    },
  }
}

/** Ignore live output, interrupted attempts, reasoning, tools, and compaction replacements. */
function latestAssistantText(entries: readonly HistoryEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const event = entries[index]!.event
    if (event.type !== 'assistant/message' || event.surfaceOp !== 'append') continue
    if (event.data.interrupted) continue
    const text = event.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text ?? '')
      .join('\n')
    if (text.trim() !== '') return text
  }
  return undefined
}
