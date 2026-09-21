import { type TUI } from '@earendil-works/pi-tui'
import type { PromptContentPart } from '../../../src/runtime/session/contracts.ts'
import type { ResolvedProxyImageRoute, VisionRequest } from '@vascent/deepseek-harness-vision'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComposerProcess, type ComposerSessionPort } from '../../../src/modules/composer/process.ts'
import { composerDraftForSession } from '../../../src/modules/composer/session-draft.ts'
import type { NewAttachmentDraft } from '../../../src/modules/composer/attachments/drafts.ts'
import type { ImageInputGateway } from '../../../src/modules/composer/attachments/coordinator.ts'
import { createTheme } from '../../../src/presentation/primitives/theme.ts'
import { buildExecutionSnapshot } from '../../../src/runtime/execution/projection/index.ts'
import { LifecycleScope } from '../../../src/runtime/lifecycle/scope.ts'
import type { RuntimeSessionSnapshot } from '../../../src/runtime/session/snapshot.ts'
import { InlineReferenceEditor } from '../../../src/infrastructure/terminal/inline-reference-editor.ts'

function sessionSnapshot(sessionId = 'session-1'): RuntimeSessionSnapshot {
  return {
    binding: { phase: 'active', sessionId: sessionId as RuntimeSessionSnapshot['sessionId'] & string, epoch: 1 },
    sessionId: sessionId as RuntimeSessionSnapshot['sessionId'],
    cwd: '/workspace',
    runState: 'idle',
    connection: { events: 'online', control: 'online' },
    events: [],
    historyHasMore: false,
    queue: [],
    pendingSubmissions: [],
    execution: buildExecutionSnapshot({
      sessionId,
      epoch: 1,
      entries: [],
      sessionRunning: false,
    }),
    modelCatalog: {
      default: { provider: 'provider', model: 'model' },
      routableProviders: ['provider'],
      groups: [],
      failures: [],
    },
    projections: {},
    notice: undefined,
    error: undefined,
  }
}

function png(): NewAttachmentDraft {
  return {
    name: 'clipboard.png',
    mediaType: 'image/png',
    data: Uint8Array.from([0x89, 0x50, 0x4E, 0x47]),
    source: 'clipboard',
  }
}

function nativeImages(): ImageInputGateway {
  return {
    resolveImageRoute: vi.fn(async () => ({
      strategy: 'native' as const,
      provider: 'provider',
      model: 'model',
    })),

    analyze: vi.fn(async (_route: ResolvedProxyImageRoute, _request: VisionRequest) => {
      throw new Error('native route must not invoke proxy analysis')
    }),
  }
}

function fixture(options: {
  color?: boolean
  clipboardImage?: () => Promise<NewAttachmentDraft>
  images?: ImageInputGateway
} = {}) {
  const current = sessionSnapshot()
  const submittedContent: PromptContentPart[][] = []
  const promptWithPreparation = vi.fn<ComposerSessionPort['promptWithPreparation']>(
    async (_text, _mode, prepareContent) => {
      const prepared = await prepareContent({ setActivity: () => {} })
      submittedContent.push(prepared.content)
    },
  )
  const session: ComposerSessionPort = {
    get current() { return current },
    prompt: vi.fn(async () => {}),
    promptWithPreparation,
    notice: vi.fn(),
  }
  const scope = new LifecycleScope('composer-test')
  const tui = {
    terminal: { rows: 24 },
    requestRender: vi.fn(),
    setFocus: vi.fn(),
  } as unknown as TUI
  let process!: ComposerProcess
  process = new ComposerProcess({
    focus: {
      editor: () => { tui.setFocus(process.editor) },
      attachments: () => { tui.setFocus(process.attachmentRail) },
    },
    theme: createTheme(options.color ?? false),
    session,
    commands: {
      dispatch: vi.fn(async () => false),
      autocompleteItems: () => [],
    },
    fileReferences: { list: vi.fn(async () => []) },
    clipboardImage: options.clipboardImage ?? (async () => png()),
    createEditor: references => new InlineReferenceEditor(
      tui,
      createTheme(false).editor,
      references,
      createTheme(false).imageReference,
      { paddingX: 0, autocompleteMaxVisible: 10 },
    ),
    images: options.images ?? nativeImages(),
    followTranscript: vi.fn(),
    openRewind: vi.fn(),
    requestRender: vi.fn(),
    scope,
  })
  process.start()
  return {
    process,
    scope,
    promptWithPreparation,
    submittedContent,
    current,
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('ComposerProcess', () => {
  it('keeps the starfield through typing, clearing, and running or historical sessions', async () => {
    vi.useFakeTimers()
    const test = fixture({ color: true })
    test.process.editor.focused = true
    test.process.editor.handleInput('中文 👋')
    expect(test.process.editorFrame.render(100).join('\n')).toMatch(/[⠁⠂⠄⠈⠐⠠⡀⢀]/u)
    expect(test.process.editor.getExpandedText()).toBe('中文 👋')
    test.process.clearDraft()
    Object.assign(test.current, { runState: 'running', historyHasMore: true })
    vi.advanceTimersByTime(30_000)
    expect(test.process.editorFrame.render(100).join('\n')).toMatch(/[⠁⠂⠄⠈⠐⠠⡀⢀]/u)
    test.process.editor.focused = false
    expect(test.process.editorFrame.render(100).join('\n')).not.toMatch(/[⠁⠂⠄⠈⠐⠠⡀⢀]/u)
    expect(vi.getTimerCount()).toBe(0)
    await test.scope.dispose()
  })

  it('decodes raw Editor references before preparing one image submission', async () => {
    const test = fixture()
    await test.process.pasteImage()
    test.process.editor.handleInput('what is this')

    // pi-tui clears the visible value before invoking onSubmit with its raw lines.
    test.process.editor.onChange?.('')
    test.process.editor.onSubmit?.('[Image\u2800#1] what is this')

    await vi.waitFor(() => {
      expect(test.promptWithPreparation).toHaveBeenCalledOnce()
      expect(test.submittedContent).toHaveLength(1)
    })
    expect(test.promptWithPreparation).toHaveBeenCalledWith(
      '[Image #1] what is this',
      'queue',
      expect.any(Function),
    )
    expect(test.submittedContent).toEqual([[
      { type: 'text', text: '[Image #1]' },
      expect.objectContaining({ type: 'image', name: 'clipboard.png' }),
      { type: 'text', text: ' what is this' },
    ]])
    expect(test.process.current.attachments).toEqual([])
    await test.scope.dispose()
  })

  it('prepares a cross-Session draft without image reservations or their markers', async () => {
    const test = fixture()
    await test.process.pasteImage()
    test.process.editor.handleInput('keep this')

    const transferred = composerDraftForSession(test.process.draft, false)

    expect(transferred.text).toBe('keep this')
    expect(transferred.attachments).toEqual([])
    await test.scope.dispose()
  })

  it('discards an in-flight clipboard reservation after its owning scope retires', async () => {
    let resolveClipboard!: (draft: NewAttachmentDraft) => void
    const test = fixture({
      clipboardImage: () => new Promise(resolve => { resolveClipboard = resolve }),
    })

    const paste = test.process.pasteImage()
    expect(test.process.editor.getExpandedText()).toBe('[Image #1] ')
    await test.scope.dispose()
    resolveClipboard(png())
    await paste

    expect(test.process.editor.getExpandedText()).toBe('')
    expect(test.process.current.attachments).toEqual([])
  })
})
