export interface LearningRow {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

export function buildLearningInput(
  rows: readonly LearningRow[],
  maxBytes: number,
): { readonly userText: string; readonly transcript: string } | undefined {
  const users = rows.filter(row => row.role === 'user' && row.text !== '')
  if (users.length === 0) return undefined
  let bytes = Buffer.byteLength(JSON.stringify(users), 'utf8')
  if (!(bytes <= maxBytes)) return undefined

  const selected = rows.filter(row => {
    if (row.text === '') return false
    if (row.role === 'user') return true
    // Users already reserve a nonempty array; each assistant adds one comma.
    const addedBytes = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1
    if (bytes + addedBytes > maxBytes) return false
    bytes += addedBytes
    return true
  })
  return {
    userText: users.map(row => row.text).join('\n'),
    transcript: JSON.stringify(selected),
  }
}
