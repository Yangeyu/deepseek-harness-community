/** Remove terminal control sequences from untrusted model, tool, and user text. */
export function sanitizeTerminalText(value: string): string {
  return value
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, '')
}

/** Render an unknown value as bounded, terminal-safe text. */
export function displayUnknown(value: unknown): string {
  if (typeof value === 'string') return sanitizeTerminalText(value)
  try {
    return sanitizeTerminalText(JSON.stringify(value, null, 2))
  } catch {
    return sanitizeTerminalText(String(value))
  }
}
