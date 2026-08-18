/** Remove terminal control sequences from untrusted model, tool, and user text. */
export function sanitizeTerminalText(value: string): string {
  return value
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    // oxlint-disable-next-line no-control-regex -- terminal-safe text removes C0/C1 bytes.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, '')
}

/** Remove terminal control bytes and collapse text onto one display row. */
export function sanitizeTerminalLine(value: string): string {
  return sanitizeTerminalText(value).replaceAll(/\s+/gu, ' ').trim()
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
