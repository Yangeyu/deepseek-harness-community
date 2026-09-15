export interface LearningRow {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/** Drop optional assistant context from an input encoded by buildLearningInput. */
export function userLearningInput(input: string): string {
  const turn = JSON.parse(input) as { turn: number; messages: LearningRow[] }
  return JSON.stringify({ ...turn, messages: turn.messages.filter(row => row.role === 'user') })
}

/** Encode a whole turn, falling back to its complete user evidence when needed. */
export function buildLearningInput(
  turn: number,
  rows: readonly LearningRow[],
  maxBytes: number,
): string | undefined {
  const users = rows.filter(row => row.role === 'user' && row.text !== '')
  if (users.length === 0) return undefined
  const userTranscript = JSON.stringify({ turn, messages: users })
  if (Buffer.byteLength(userTranscript, 'utf8') > maxBytes) return undefined

  const fullTranscript = JSON.stringify({ turn, messages: rows.filter(row => row.text !== '') })
  return Buffer.byteLength(fullTranscript, 'utf8') <= maxBytes ? fullTranscript : userTranscript
}
