import type { LifecycleKey } from './types.ts'

function key(value: string): LifecycleKey {
  return value as LifecycleKey
}

export function turnLifecycleKey(turn: number): LifecycleKey {
  return key(`turn:${String(turn)}`)
}

export function promptLifecycleKey(messageId: string): LifecycleKey {
  return key(`prompt:${messageId}`)
}

export function stepLifecycleKey(turn: number, step: number): LifecycleKey {
  return key(`step:${String(turn)}:${String(step)}`)
}

export function thoughtLifecycleKey(turn: number, step: number): LifecycleKey {
  return key(`thought:${String(turn)}:${String(step)}`)
}

export function toolLifecycleKey(callId: string): LifecycleKey {
  return key(`tool:${callId}`)
}

export function commandLifecycleKey(commandId: string): LifecycleKey {
  return key(`command:${commandId}`)
}

export function visionLifecycleKey(analysisId: string): LifecycleKey {
  return key(`vision:${analysisId}`)
}
