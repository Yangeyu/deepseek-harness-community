import type { ExecutionKey } from './types.ts'

function key(value: string): ExecutionKey {
  return value as ExecutionKey
}

export function turnExecutionKey(turn: number): ExecutionKey {
  return key(`turn:${String(turn)}`)
}

export function promptExecutionKey(messageId: string): ExecutionKey {
  return key(`prompt:${messageId}`)
}

export function stepExecutionKey(turn: number, step: number): ExecutionKey {
  return key(`step:${String(turn)}:${String(step)}`)
}

export function thoughtExecutionKey(turn: number, step: number): ExecutionKey {
  return key(`thought:${String(turn)}:${String(step)}`)
}

export function toolExecutionKey(callId: string): ExecutionKey {
  return key(`tool:${callId}`)
}

export function commandExecutionKey(commandId: string): ExecutionKey {
  return key(`command:${commandId}`)
}

export function visionExecutionKey(analysisId: string): ExecutionKey {
  return key(`vision:${analysisId}`)
}
