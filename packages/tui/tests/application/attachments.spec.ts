import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import type { PromptContentPart } from '@deepseek-ai/dsh-host-apiproxy'
import type {
  VisionCapability,
  VisionConfig,
  VisionRequest,
  VisionStatus,
} from '@vascent/deepseek-harness-vision'
import { AttachmentDraftStore } from '../../src/application/attachments/drafts.ts'
import {
  AttachmentCoordinator,
  type PreparedPromptSender,
  type VisionGateway,
} from '../../src/application/attachments/coordinator.ts'
import {
  detectImageMediaType,
  imageDraftFromPath,
} from '../../src/application/attachments/files.ts'
import { imageDraftFromClipboard } from '../../src/application/attachments/clipboard.ts'

const config: VisionConfig = {
  mode: 'auto',
  proxyProvider: 'proxy',
  proxyModel: 'vision',
  maxObservationChars: 12_000,
  maxTokens: 2_048,
}

function gateway(route: VisionCapability): VisionGateway & { analyze: ReturnType<typeof vi.fn> } {
  const analyze = vi.fn(async (request: VisionRequest) => ({
    analysisId: request.analysisId,
    provider: 'proxy',
    model: 'vision',
    marker: `marker:${request.analysisId}`,
    observation: 'visible evidence',
    attachments: [],
    durationMs: 4,
    truncated: false,
    finishReason: 'stop',
  }))
  return {
    config,
    newAnalysisId: () => 'analysis-id',
    supportsNativeImages: vi.fn(async () => route.strategy === 'native'),
    capability: vi.fn(async () => route),
    status: vi.fn(async (): Promise<VisionStatus> => ({
      config,
      proxyRegistered: true,
      proxySupportsImages: true,
    })),
    setMode: vi.fn(async () => {}),
    configureRecommendedDashScope: vi.fn(async () => {}),
    analyze,
    discard: vi.fn(),
  }
}

function addPng(store: AttachmentDraftStore): void {
  store.add({
    name: 'screen.png',
    mediaType: 'image/png',
    data: Uint8Array.from([0x89, 0x50, 0x4E, 0x47]),
    source: 'file',
  })
}

function preparedSender(
  onContent?: (content: PromptContentPart[]) => void,
  onActivity?: (activity: { kind: 'vision'; imageCount: number } | undefined) => void,
) {
  return vi.fn<PreparedPromptSender>(async (_text, _mode, prepareContent) => {
    const content = await prepareContent({ setActivity: activity => { onActivity?.(activity) } })
    onContent?.(content)
  })
}

describe('AttachmentCoordinator', () => {
  it('submits bytes directly when the active model supports images', async () => {
    const store = new AttachmentDraftStore()
    addPng(store)
    let submittedContent: PromptContentPart[] = []
    const activities: Array<{ kind: 'vision'; imageCount: number } | undefined> = []
    const send = preparedSender(
      content => { submittedContent = content },
      activity => { activities.push(activity) },
    )
    const coordinator = new AttachmentCoordinator(store, gateway({
      strategy: 'native', provider: 'native', model: 'vision',
    }))

    await expect(coordinator.submit(
      'session',
      { provider: 'native', model: 'vision' },
      'inspect this',
      'queue',
      undefined,
      send,
    )).resolves.toBe('native')

    expect(submittedContent).toEqual([
      { type: 'text', text: 'inspect this' },
      expect.objectContaining({ type: 'image', mediaType: 'image/png', name: 'screen.png' }),
    ])
    expect(activities).toEqual([])
    expect(store.snapshot).toHaveLength(0)
  })

  it('uses the visible image placeholder in image-only Host content', async () => {
    const store = new AttachmentDraftStore()
    addPng(store)
    let displayText = ''
    let submittedContent: PromptContentPart[] = []
    const send = vi.fn<PreparedPromptSender>(async (display, _mode, prepareContent) => {
      displayText = display
      submittedContent = await prepareContent({ setActivity: () => {} })
    })

    await new AttachmentCoordinator(store, gateway({
      strategy: 'native', provider: 'native', model: 'vision',
    })).submit(
      'session',
      { provider: 'native', model: 'vision' },
      '   ',
      'queue',
      undefined,
      send,
    )

    expect(displayText).toBe('[Image]')
    expect(submittedContent[0]).toEqual({ type: 'text', text: '[Image]' })
  })

  it('stages proxy evidence before submitting the exact user text', async () => {
    const store = new AttachmentDraftStore()
    addPng(store)
    const vision = gateway({ strategy: 'proxy', provider: 'proxy', model: 'vision' })
    let submittedContent: PromptContentPart[] = []
    const activities: Array<{ kind: 'vision'; imageCount: number } | undefined> = []
    const send = preparedSender(
      content => { submittedContent = content },
      activity => { activities.push(activity) },
    )

    await new AttachmentCoordinator(store, vision).submit(
      'session',
      { provider: 'deepseek', model: 'chat' },
      'inspect this',
      'queue',
      undefined,
      send,
    )

    expect(vision.analyze).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session',
      userText: 'inspect this',
    }), expect.any(AbortSignal))
    expect(submittedContent).toEqual([
      { type: 'text', text: 'marker:analysis-id' },
      { type: 'text', text: 'inspect this' },
    ])
    expect(activities).toEqual([{ kind: 'vision', imageCount: 1 }])
  })

  it('transfers images out of the Composer while proxy analysis is still running', async () => {
    const store = new AttachmentDraftStore()
    addPng(store)
    const vision = gateway({ strategy: 'proxy', provider: 'proxy', model: 'vision' })
    let releaseAnalysis!: () => void
    vision.analyze.mockImplementation(async (request: VisionRequest) => {
      await new Promise<void>(resolve => { releaseAnalysis = resolve })
      return {
        analysisId: request.analysisId,
        provider: 'proxy',
        model: 'vision',
        marker: `marker:${request.analysisId}`,
        observation: 'visible evidence',
        attachments: [],
        durationMs: 4,
        truncated: false,
        finishReason: 'stop',
      }
    })
    const coordinator = new AttachmentCoordinator(store, vision)

    const submission = coordinator.submit(
      'session',
      { provider: 'deepseek', model: 'chat' },
      'inspect this',
      'queue',
      undefined,
      preparedSender(),
    )

    await vi.waitFor(() => { expect(vision.analyze).toHaveBeenCalledOnce() })
    expect(store.snapshot).toEqual([])
    expect(coordinator.busy).toBe(true)
    releaseAnalysis()
    await submission
    expect(coordinator.busy).toBe(false)
  })

  it('retains failed drafts with an actionable error', async () => {
    const store = new AttachmentDraftStore()
    addPng(store)
    const vision = gateway({
      strategy: 'disabled', reason: 'proxy-unavailable', message: 'Configure Vision first.',
    })

    await expect(new AttachmentCoordinator(store, vision).submit(
      'session',
      { provider: 'deepseek', model: 'chat' },
      'inspect this',
      'queue',
      undefined,
      preparedSender(),
    )).rejects.toThrow('Configure Vision first.')
    expect(store.snapshot[0]?.error).toBe('Configure Vision first.')
  })
})

describe('image intake', () => {
  it('detects supported formats from magic bytes', () => {
    expect(detectImageMediaType(Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))).toBe('image/png')
    expect(detectImageMediaType(Uint8Array.from([0xFF, 0xD8, 0xFF]))).toBe('image/jpeg')
    expect(detectImageMediaType(new TextEncoder().encode('not an image'))).toBeUndefined()
  })

  it('loads explicit relative paths into validated in-memory drafts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-tui-image-'))
    try {
      await writeFile(join(cwd, 'screen.png'), Uint8Array.from([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      ]))

      await expect(imageDraftFromPath('screen.png', cwd)).resolves.toMatchObject({
        name: 'screen.png',
        mediaType: 'image/png',
        source: 'file',
      })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('cleans the clipboard temporary directory after reading', async () => {
    let temporaryFile = ''
    const draft = await imageDraftFromClipboard(async (file) => {
      temporaryFile = file
      await writeFile(file, Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
    })

    expect(draft).toMatchObject({ mediaType: 'image/png', source: 'clipboard' })
    await expect(access(dirname(temporaryFile))).rejects.toThrow()
  })
})
