import type {
  SurfaceInputAction,
  SurfaceInputContext,
} from '../../primitives/surface-input.ts'
import type { TerminalGesture, TerminalKey } from './gesture.ts'

/** Semantic actions emitted by the fixed terminal keymap. */
export type KeymapAction =
  | SurfaceInputAction
  | 'app.cancel-or-exit'
  | 'interaction.cancel'
  | 'turn.queue'
  | 'vision.paste'
  | 'attachments.focus'
  | 'attachments.leave'
  | 'attachments.next'
  | 'attachments.previous'
  | 'attachments.remove-last'
  | 'attachments.remove-selected'
  | 'details.toggle'
  | 'reasoning.cycle'
  | 'history.page-up'
  | 'history.page-down'
  | 'draft.previous'
  | 'draft.next'
  | 'run.interrupt'
  | 'composer.escape'

export interface KeymapContext {
  working: boolean
  imageSubmissionBusy: boolean
  hasAttachments: boolean
  composerEmpty: boolean
  autocompleteVisible: boolean
  interactionActive: boolean
  surfaceActive: boolean
  surfaceInput?: SurfaceInputContext
  attachmentRailFocused: boolean
}

export type KeymapResolution =
  | { kind: 'action'; action: KeymapAction }
  | { kind: 'suppressed' }
  | { kind: 'unmatched' }

interface KeymapBinding {
  readonly action: KeymapAction
  readonly key: TerminalKey
  readonly priority: number
  available(context: KeymapContext): boolean
}

const BASE_PRIORITY = 100
const SURFACE_PRIORITY = 200
const MODAL_PRIORITY = 300

const IN_BASE_SURFACE = (context: KeymapContext): boolean => (
  !context.interactionActive && !context.surfaceActive && !context.attachmentRailFocused
)
const WHEN_WORKING = (context: KeymapContext): boolean => IN_BASE_SURFACE(context) && context.working
const WITH_ATTACHMENTS = (context: KeymapContext): boolean => IN_BASE_SURFACE(context) && context.hasAttachments
const WHEN_INTERACTING = (context: KeymapContext): boolean => context.interactionActive
const IN_ATTACHMENT_RAIL = (context: KeymapContext): boolean => context.attachmentRailFocused
const WITH_EMPTY_COMPOSER = (context: KeymapContext): boolean => IN_BASE_SURFACE(context) && context.composerEmpty
const WHEN_INTERRUPTIBLE = (context: KeymapContext): boolean => (
  IN_BASE_SURFACE(context) && (context.working || context.imageSubmissionBusy)
)
const WHEN_COMPOSER_ESCAPE = (context: KeymapContext): boolean => (
  IN_BASE_SURFACE(context)
  && !context.working
  && !context.imageSubmissionBusy
  && !context.autocompleteVisible
)
const onSurface = (...contexts: readonly SurfaceInputContext[]) => (context: KeymapContext): boolean => (
  context.surfaceInput !== undefined && contexts.includes(context.surfaceInput)
)

function binding(
  action: KeymapAction,
  key: TerminalKey,
  available: KeymapBinding['available'],
  priority = BASE_PRIORITY,
): KeymapBinding {
  return { action, key, available, priority }
}

function surfaceBindings(
  context: SurfaceInputContext,
  entries: ReadonlyArray<readonly [TerminalKey, SurfaceInputAction]>,
): KeymapBinding[] {
  return entries.map(([key, action]) => binding(action, key, onSurface(context), SURFACE_PRIORITY))
}

const MENU_BINDINGS = (context: SurfaceInputContext): KeymapBinding[] => surfaceBindings(context, [
  ['escape', 'surface.back'],
  ['ctrl-c', 'surface.back'],
  ['up', 'surface.previous'],
  ['k', 'surface.previous'],
  ['down', 'surface.next'],
  ['j', 'surface.next'],
  ['g', 'surface.first'],
  ['G', 'surface.last'],
  ['enter', 'surface.confirm'],
  ['space', 'surface.confirm'],
])

const KEYMAP_BINDINGS: readonly KeymapBinding[] = [
  binding('interaction.cancel', 'escape', WHEN_INTERACTING, MODAL_PRIORITY),
  binding('attachments.leave', 'escape', IN_ATTACHMENT_RAIL, MODAL_PRIORITY),
  binding('attachments.leave', 'ctrl-c', IN_ATTACHMENT_RAIL, MODAL_PRIORITY),
  binding('app.cancel-or-exit', 'ctrl-c', context => (
    WHEN_INTERACTING(context) || IN_BASE_SURFACE(context)
  ), MODAL_PRIORITY),
  binding('vision.paste', 'ctrl-v', IN_BASE_SURFACE),
  binding('attachments.focus', 'alt-a', WITH_ATTACHMENTS),
  binding('attachments.remove-last', 'alt-backspace', WITH_ATTACHMENTS),
  binding('details.toggle', 'ctrl-o', IN_BASE_SURFACE),
  binding('reasoning.cycle', 'shift-tab', IN_BASE_SURFACE),
  binding('turn.queue', 'tab', WHEN_WORKING),
  binding('history.page-up', 'page-up', WITH_EMPTY_COMPOSER),
  binding('history.page-down', 'page-down', WITH_EMPTY_COMPOSER),
  binding('draft.previous', 'up', IN_BASE_SURFACE),
  binding('draft.next', 'down', IN_BASE_SURFACE),
  binding('run.interrupt', 'escape', WHEN_INTERRUPTIBLE),
  binding('composer.escape', 'escape', WHEN_COMPOSER_ESCAPE),

  binding('attachments.previous', 'left', IN_ATTACHMENT_RAIL, SURFACE_PRIORITY),
  binding('attachments.previous', 'h', IN_ATTACHMENT_RAIL, SURFACE_PRIORITY),
  binding('attachments.next', 'right', IN_ATTACHMENT_RAIL, SURFACE_PRIORITY),
  binding('attachments.next', 'l', IN_ATTACHMENT_RAIL, SURFACE_PRIORITY),
  binding('attachments.remove-selected', 'delete', IN_ATTACHMENT_RAIL, SURFACE_PRIORITY),
  binding('attachments.remove-selected', 'backspace', IN_ATTACHMENT_RAIL, SURFACE_PRIORITY),

  ...surfaceBindings('choice', [
    ['escape', 'surface.back'],
    ['ctrl-c', 'surface.back'],
    ['up', 'surface.previous'],
    ['k', 'surface.previous'],
    ['down', 'surface.next'],
    ['j', 'surface.next'],
    ['enter', 'surface.confirm'],
  ]),
  ...surfaceBindings('text-input', [
    ['escape', 'surface.back'],
  ]),
  ...surfaceBindings('approval', [
    ['up', 'surface.previous'],
    ['k', 'surface.previous'],
    ['down', 'surface.next'],
    ['j', 'surface.next'],
    ['tab', 'surface.next'],
    ['1', 'surface.select-1'],
    ['2', 'surface.select-2'],
    ['enter', 'surface.confirm'],
  ]),
  ...surfaceBindings('multi-select', [
    ['up', 'surface.previous'],
    ['down', 'surface.next'],
    ['page-up', 'surface.page-previous'],
    ['page-down', 'surface.page-next'],
    ['space', 'surface.toggle'],
    ['enter', 'surface.confirm'],
  ]),
  ...MENU_BINDINGS('menu'),
  ...surfaceBindings('memory', [
    ['escape', 'surface.back'],
    ['ctrl-c', 'surface.back'],
    ['up', 'surface.previous'],
    ['down', 'surface.next'],
    ['page-up', 'surface.page-previous'],
    ['page-down', 'surface.page-next'],
    ['enter', 'surface.confirm'],
    ['space', 'surface.confirm'],
  ]),
  ...surfaceBindings('model-menu', [
    ['escape', 'surface.back'],
    ['ctrl-c', 'surface.back'],
    ['up', 'surface.previous'],
    ['down', 'surface.next'],
    ['page-up', 'surface.page-previous'],
    ['page-down', 'surface.page-next'],
    ['1', 'surface.select-1'],
    ['2', 'surface.select-2'],
    ['3', 'surface.select-3'],
    ['4', 'surface.select-4'],
    ['5', 'surface.select-5'],
    ['6', 'surface.select-6'],
    ['7', 'surface.select-7'],
    ['8', 'surface.select-8'],
    ['9', 'surface.select-9'],
    ['enter', 'surface.confirm'],
  ]),
  ...surfaceBindings('web-menu', [
    ['escape', 'surface.back'],
    ['ctrl-c', 'surface.back'],
    ['up', 'surface.previous'],
    ['k', 'surface.previous'],
    ['down', 'surface.next'],
    ['j', 'surface.next'],
    ['g', 'surface.first'],
    ['G', 'surface.last'],
    ['r', 'surface.refresh'],
    ['R', 'surface.refresh'],
    ['enter', 'surface.confirm'],
    ['space', 'surface.confirm'],
  ]),
  ...surfaceBindings('rewind-point', [
    ['escape', 'surface.back'],
    ['ctrl-c', 'surface.back'],
    ['up', 'surface.previous'],
    ['down', 'surface.next'],
    ['page-up', 'surface.page-previous'],
    ['page-down', 'surface.page-next'],
    ['enter', 'surface.confirm'],
  ]),
  ...surfaceBindings('rewind-confirm', [
    ['escape', 'surface.back'],
    ['ctrl-c', 'surface.back'],
    ['up', 'surface.previous'],
    ['down', 'surface.next'],
    ['tab', 'surface.next'],
    ['page-up', 'surface.page-previous'],
    ['page-down', 'surface.page-next'],
    ['1', 'surface.select-1'],
    ['2', 'surface.select-2'],
    ['3', 'surface.select-3'],
    ['4', 'surface.select-4'],
    ['enter', 'surface.confirm'],
  ]),
  ...surfaceBindings('skills', [
    ['escape', 'surface.back'],
    ['ctrl-c', 'surface.back'],
    ['h', 'surface.back'],
    ['up', 'surface.previous'],
    ['k', 'surface.previous'],
    ['down', 'surface.next'],
    ['j', 'surface.next'],
    ['g', 'surface.first'],
    ['G', 'surface.last'],
    ['/', 'surface.search'],
    ['s', 'surface.search'],
    ['n', 'surface.create'],
    ['e', 'surface.edit'],
    ['r', 'surface.refresh'],
    ['l', 'surface.expand'],
    ['right', 'surface.expand'],
    ['enter', 'surface.confirm'],
  ]),
  ...surfaceBindings('trajectory', [
    ['ctrl-c', 'surface.interrupt-or-cancel'],
    ['escape', 'surface.back'],
    ['tab', 'surface.tab-next'],
    ['shift-tab', 'surface.tab-previous'],
    ['left', 'surface.tab-previous'],
    ['right', 'surface.tab-next'],
    ['up', 'surface.previous'],
    ['k', 'surface.previous'],
    ['down', 'surface.next'],
    ['j', 'surface.next'],
    ['K', 'surface.detail-previous'],
    ['J', 'surface.detail-next'],
    ['page-up', 'surface.page-previous'],
    ['page-down', 'surface.page-next'],
    ['h', 'surface.collapse'],
    ['l', 'surface.expand'],
    ['g', 'surface.first'],
    ['G', 'surface.last'],
    ['ctrl-u', 'surface.half-page-previous'],
    ['ctrl-d', 'surface.half-page-next'],
    ['enter', 'surface.confirm'],
  ]),
]

/** Resolve one normalized gesture with explicit priority and conflict detection. */
export function resolveKeymapInput(
  gesture: TerminalGesture,
  context: KeymapContext,
): KeymapResolution {
  if (gesture.kind !== 'key') return { kind: 'unmatched' }
  const candidates = KEYMAP_BINDINGS.filter(candidate => (
    candidate.key === gesture.key && candidate.available(context)
  ))
  if (candidates.length === 0) return { kind: 'unmatched' }
  const priority = Math.max(...candidates.map(candidate => candidate.priority))
  const winners = candidates.filter(candidate => candidate.priority === priority)
  if (winners.length !== 1) {
    throw new Error(`Conflicting terminal bindings for ${gesture.key} at priority ${String(priority)}.`)
  }
  if (gesture.phase !== 'press') return { kind: 'suppressed' }
  return { kind: 'action', action: winners[0]!.action }
}
