export type ClipboardTextWriter = (text: string) => Promise<void>

/** One derived interruption decision shared by input execution and its visible hint. */
export interface InputInterruption {
  readonly action: 'cancel-interaction' | 'cancel-image-preparation' | 'interrupt-session' | 'interrupt-and-send'
  readonly target: string
  readonly requested: boolean
}
