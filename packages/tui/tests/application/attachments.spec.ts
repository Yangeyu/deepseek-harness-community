import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import type { PromptContentPart, RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import type {
  VisionCapability,
  VisionConfig,
  VisionStatus,
} from '@vascent/deepseek-harness-vision'
import { AttachmentDraftStore } from '../../src/application/attachments/drafts.ts'
import {
  AttachmentCoordinator,
  type ComposerVisionRequest,
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

function gateway(route: VisionCapability): VisionGateway & {
  analyze: ReturnType<typeof vi.fn>
  admit: ReturnType<typeof vi.fn>
} {
  const analyze = vi.fn(async (request: ComposerVisionRequest) => ({
    analysisId: request.analysisId,
    provider: 'proxy',
    model: 'vision',
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
    analyze,
    admit: vi.fn(async () => {}),
    discard: vi.fn(),
  }
}

function addPng(store: AttachmentDraftStore, name = 'screen.png') {
  const draft = store.complete(store.reserve(), {
    name,
    mediaType: 'image/png',
    data: Uint8Array.from([0x89, 0x50, 0x4E, 0x47]),
    source: 'file',
  })
  if (draft === undefined) throw new Error('test attachment reservation expired')
  return draft
}

function preparedSender(
  onContent?: (content: PromptContentPart[]) => void,
  onActivity?: (activity: { kind: 'vision'; analysisId: string; imageCount: number }) => void,
) {
  return vi.fn<PreparedPromptSender>(async (_text, _mode, prepareContent) => {
    const prepared = await prepareContent({ setActivity: activity => { onActivity?.(activity) } })
    if (prepared.kind === 'content') onContent?.(prepared.content)
    else await prepared.commit({ rpcId: 'rpc-test' as RpcId })
  })
}

describe('AttachmentDraftStore', () => {
  it('replaces a Composer attachment set without changing stable draft state', () => {
    const store = new AttachmentDraftStore()
    addPng(store)
    const id = store.snapshot[0]!.id
    store.setError([id], 'retry later')
    const retained = store.snapshot[0]!

    store.clear()
    store.replaceAll([retained])

    expect(store.snapshot).toEqual([retained])
    expect(store.snapshot[0]).toBe(retained)
    expect(store.snapshot[0]?.error).toBe('retry later')
  })
})

describe('AttachmentCoordinator', () => {
  it('submits bytes directly when the active model supports images', async () => {
    const store = new AttachmentDraftStore()
    const image = addPng(store)
    let submittedContent: PromptContentPart[] = []
    const activities: Array<{ kind: 'vision'; analysisId: string; imageCount: number }> = []
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
      `inspect this ${image.placeholder}`,
      'queue',
      undefined,
      send,
    )).resolves.toBe('native')

    expect(submittedContent).toEqual([
      { type: 'text', text: 'inspect this [Image #1]' },
      expect.objectContaining({ type: 'image', mediaType: 'image/png', name: 'screen.png' }),
    ])
    expect(activities).toEqual([])
    expect(store.snapshot).toHaveLength(0)
  })

  it('uses the visible image placeholder in image-only Host content', async () => {
    const store = new AttachmentDraftStore()
    const image = addPng(store)
    let displayText = ''
    let submittedContent: PromptContentPart[] = []
    const send = vi.fn<PreparedPromptSender>(async (display, _mode, prepareContent) => {
      displayText = display
      const prepared = await prepareContent({ setActivity: () => {} })
      if (prepared.kind !== 'content') throw new Error('expected native content')
      submittedContent = prepared.content
    })

    await new AttachmentCoordinator(store, gateway({
      strategy: 'native', provider: 'native', model: 'vision',
    })).submit(
      'session',
      { provider: 'native', model: 'vision' },
      image.placeholder,
      'queue',
      undefined,
      send,
    )

    expect(displayText).toBe('[Image #1]')
    expect(submittedContent).toEqual([
      { type: 'text', text: '[Image #1]' },
      expect.objectContaining({ type: 'image', name: 'screen.png' }),
    ])
  })

  it('serializes native images in inline marker order rather than attachment order', async () => {
    const store = new AttachmentDraftStore()
    const first = addPng(store, 'first.png')
    const second = addPng(store, 'second.png')
    let submittedContent: PromptContentPart[] = []

    await new AttachmentCoordinator(store, gateway({
      strategy: 'native', provider: 'native', model: 'vision',
    })).submit(
      'session',
      { provider: 'native', model: 'vision' },
      `before ${second.placeholder} between ${first.placeholder} after`,
      'queue',
      undefined,
      preparedSender(content => { submittedContent = content }),
    )

    expect(submittedContent).toEqual([
      { type: 'text', text: `before ${second.placeholder}` },
      expect.objectContaining({ type: 'image', name: 'second.png' }),
      { type: 'text', text: ` between ${first.placeholder}` },
      expect.objectContaining({ type: 'image', name: 'first.png' }),
      { type: 'text', text: ' after' },
    ])
  })

  it('passes the same ordered references to the Vision proxy', async () => {
    const store = new AttachmentDraftStore()
    const first = addPng(store, 'first.png')
    const second = addPng(store, 'second.png')
    const vision = gateway({ strategy: 'proxy', provider: 'proxy', model: 'vision' })

    await new AttachmentCoordinator(store, vision).submit(
      'session',
      { provider: 'deepseek', model: 'chat' },
      `before ${second.placeholder} between ${first.placeholder} after`,
      'queue',
      undefined,
      preparedSender(),
    )

    const request = vision.analyze.mock.calls[0]?.[0] as ComposerVisionRequest
    expect(request.userText).toBe('before [Image #2] between [Image #1] after')
    expect(request.images.map(image => ({ reference: image.reference, name: image.name }))).toEqual([
      { reference: '[Image #2]', name: 'second.png' },
      { reference: '[Image #1]', name: 'first.png' },
    ])
  })

  it('does not fabricate a position when an attachment has no inline reference', async () => {
    const store = new AttachmentDraftStore()
    addPng(store)
    const send = preparedSender()

    await expect(new AttachmentCoordinator(store, gateway({
      strategy: 'native', provider: 'native', model: 'vision',
    })).submit(
      'session',
      { provider: 'native', model: 'vision' },
      'inspect this',
      'queue',
      undefined,
      send,
    )).rejects.toThrow('Attached image is missing its inline reference: [Image #1]')
    expect(send).not.toHaveBeenCalled()
  })

  it('commits proxy evidence through the durable Vision admission path', async () => {
    const store = new AttachmentDraftStore()
    const image = addPng(store)
    const vision = gateway({ strategy: 'proxy', provider: 'proxy', model: 'vision' })
    const activities: Array<{ kind: 'vision'; analysisId: string; imageCount: number }> = []
    const send = preparedSender(
      undefined,
      activity => { activities.push(activity) },
    )

    await new AttachmentCoordinator(store, vision).submit(
      'session',
      { provider: 'deepseek', model: 'chat' },
      `inspect this ${image.placeholder}`,
      'queue',
      undefined,
      send,
    )

    expect(vision.analyze).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session',
      userText: 'inspect this [Image #1]',
      images: [expect.objectContaining({ reference: '[Image #1]' })],
    }), expect.any(AbortSignal))
    expect(vision.admit).toHaveBeenCalledWith({
      analysisId: 'analysis-id',
      sessionId: 'session',
      promptText: 'inspect this [Image #1]',
      mode: 'queue',
      rpcId: 'rpc-test',
    })
    expect(activities).toEqual([{ kind: 'vision', analysisId: 'analysis-id', imageCount: 1 }])
  })

  it('transfers images out of the Composer while proxy analysis is still running', async () => {
    const store = new AttachmentDraftStore()
    const image = addPng(store)
    const vision = gateway({ strategy: 'proxy', provider: 'proxy', model: 'vision' })
    let releaseAnalysis!: () => void
    vision.analyze.mockImplementation(async (request: ComposerVisionRequest) => {
      await new Promise<void>(resolve => { releaseAnalysis = resolve })
      return {
        analysisId: request.analysisId,
        provider: 'proxy',
        model: 'vision',
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
      `inspect this ${image.placeholder}`,
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

  it('restores drafts when durable proxy admission fails after analysis', async () => {
    const store = new AttachmentDraftStore()
    const image = addPng(store)
    const vision = gateway({ strategy: 'proxy', provider: 'proxy', model: 'vision' })
    vision.admit.mockRejectedValueOnce(new Error('Session changed before admission.'))

    await expect(new AttachmentCoordinator(store, vision).submit(
      'session',
      { provider: 'deepseek', model: 'chat' },
      `inspect this ${image.placeholder}`,
      'queue',
      undefined,
      preparedSender(),
    )).rejects.toThrow('Session changed before admission.')

    expect(vision.discard).toHaveBeenCalledWith('analysis-id')
    expect(store.snapshot).toHaveLength(1)
    expect(store.snapshot[0]?.error).toBe('Session changed before admission.')
  })

  it('does not restore drafts after durable proxy admission has committed', async () => {
    const store = new AttachmentDraftStore()
    const image = addPng(store)
    const vision = gateway({ strategy: 'proxy', provider: 'proxy', model: 'vision' })
    const send = vi.fn<PreparedPromptSender>(async (_text, _mode, prepareContent) => {
      const prepared = await prepareContent({ setActivity: () => {} })
      if (prepared.kind !== 'admission') throw new Error('expected Vision admission')
      await prepared.commit({ rpcId: 'rpc-test' as RpcId })
      throw new Error('presentation failed after admission')
    })

    await expect(new AttachmentCoordinator(store, vision).submit(
      'session',
      { provider: 'deepseek', model: 'chat' },
      `inspect this ${image.placeholder}`,
      'queue',
      undefined,
      send,
    )).rejects.toThrow('presentation failed after admission')

    expect(vision.admit).toHaveBeenCalledOnce()
    expect(vision.discard).not.toHaveBeenCalled()
    expect(store.snapshot).toEqual([])
  })

  it('retains failed drafts with an actionable error', async () => {
    const store = new AttachmentDraftStore()
    const image = addPng(store)
    const vision = gateway({
      strategy: 'disabled', reason: 'proxy-unavailable', message: 'Configure Vision first.',
    })

    await expect(new AttachmentCoordinator(store, vision).submit(
      'session',
      { provider: 'deepseek', model: 'chat' },
      `inspect this ${image.placeholder}`,
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
