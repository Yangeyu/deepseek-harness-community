import type { PointerAction, TerminalGesture } from './gesture.ts'
import {
  resolveKeymapInput,
  type KeymapAction,
  type KeymapContext,
} from './keymap.ts'

export type TerminalInputRoute =
  | { kind: 'action'; action: KeymapAction }
  | { kind: 'pointer'; action: PointerAction }
  | { kind: 'suppressed' }
  | { kind: 'passthrough' }

export interface TerminalInputResolution {
  readonly clearSelection: boolean
  readonly disarmRewind: boolean
  readonly route: TerminalInputRoute
}

/** Resolve one normalized terminal gesture before application behavior runs. */
export function resolveTerminalInput(
  gesture: TerminalGesture,
  context: KeymapContext,
): TerminalInputResolution {
  if (gesture.kind === 'pointer') {
    return {
      clearSelection: false,
      disarmRewind: false,
      route: { kind: 'pointer', action: gesture.action },
    }
  }

  const release = gesture.phase === 'release'
  const repeatedEscape = gesture.key === 'escape' && gesture.phase === 'repeat'
  const baseSurface = !context.interactionActive
    && !context.surfaceActive
    && !context.attachmentRailFocused
  const common = {
    clearSelection: !release,
    disarmRewind: baseSurface && gesture.key !== 'escape' && !release,
  }
  if (gesture.key === 'escape' && (release || repeatedEscape)) {
    return { ...common, route: { kind: 'suppressed' } }
  }

  const keymap = resolveKeymapInput(gesture, context)
  if (keymap.kind !== 'unmatched') return { ...common, route: keymap }
  return { ...common, route: { kind: 'passthrough' } }
}
