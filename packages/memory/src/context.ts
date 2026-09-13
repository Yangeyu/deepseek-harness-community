/** Whole-entry memory snapshots with a shared UTF-8 byte budget. */

import type { MemoryDocument } from './store.ts'

export const MIN_CONTEXT_BYTES = 256

const OPEN = '<memory-context>'
const CLOSE = '\n</memory-context>'

function renderScope(document: MemoryDocument, label: string, maxBytes: number): string {
  if (!document.exists || document.content.trim() === '') return ''
  const content = document.content.trim().replaceAll('\r\n', '\n').replaceAll('</memory-context>', '<\\/memory-context>')
  const heading = `\n\n${label} memory:\n`
  const full = heading + content
  if (Buffer.byteLength(full, 'utf8') <= maxBytes) return full

  const omitted = `\n\n[Entries omitted; read full index with memory_read({"scope":"${document.scope}"}).]`
  let remaining = maxBytes - Buffer.byteLength(heading + omitted, 'utf8')
  const selected: string[] = []
  // Only self-contained bullets and indented continuations can be selected
  // independently. Keep prose conditions and unfamiliar structure together.
  const body = content.replace(new RegExp(`^# ${label} memory[ \\t]*(?:\\n|$)`, 'u'), '').trim()
  const simple = body.split('\n').every(line => line.trim() === '' || /^(?:[*+-] |[ \t]+)/u.test(line))
    && !/^[ \t]*(?:[*+-] )?(?:`{3,}|~{3,})/mu.test(body)
  const blocks = simple ? content.split(/\n[ \t]*\n(?=\S)|\n(?=[*+-] )/u) : [content]
  for (const block of blocks) {
    const entry = block.trim()
    const cost = Buffer.byteLength(entry, 'utf8') + (selected.length === 0 ? 0 : 2)
    // Skip an oversized entry, but keep considering later entries in file order.
    if (cost > remaining) continue
    selected.push(entry)
    remaining -= cost
  }
  return heading + selected.join('\n\n') + omitted
}

/** Requires a safe integer maxBytes >= MIN_CONTEXT_BYTES; never cuts a block. */
export function renderMemoryContext(global: MemoryDocument, project: MemoryDocument, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_CONTEXT_BYTES) {
    throw new RangeError(`memory: maxContextBytes must be a safe integer >= ${String(MIN_CONTEXT_BYTES)}`)
  }
  const available = maxBytes - Buffer.byteLength(OPEN + CLOSE, 'utf8')
  // Reserve half for the project before global selection; then lend either
  // scope's unused space to the other. Selection never implies relevance rank.
  let projectText = renderScope(project, 'Project', Math.floor(available / 2))
  const globalText = renderScope(global, 'Global', available - Buffer.byteLength(projectText, 'utf8'))
  projectText = renderScope(project, 'Project', available - Buffer.byteLength(globalText, 'utf8'))
  return OPEN + globalText + projectText + CLOSE
}
