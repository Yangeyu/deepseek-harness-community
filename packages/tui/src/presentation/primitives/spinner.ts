const SPINNER_FRAMES = ['·', '✢', '✳', '✦']

export function spinnerGlyph(frame: number): string {
  return SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? '·'
}
