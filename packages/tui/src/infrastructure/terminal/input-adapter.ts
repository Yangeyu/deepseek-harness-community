import type { TerminalGesture } from '../../presentation/shell/input/gesture.ts'
import { decodeTerminalInput } from './decode-input.ts'

export interface RawInputScreen {
  addInputListener(listener: (data: string) => { consume?: boolean } | undefined): () => void
}

/** Confines raw terminal decoding to the terminal adapter boundary. */
export function attachTerminalInput(
  screen: RawInputScreen,
  handle: (gesture: TerminalGesture) => { consume?: boolean } | undefined,
): () => void {
  return screen.addInputListener(data => handle(decodeTerminalInput(data)))
}
