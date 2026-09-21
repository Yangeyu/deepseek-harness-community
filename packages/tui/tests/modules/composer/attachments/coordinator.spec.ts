import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { PromptContentPart } from '../../../../src/runtime/session/contracts.ts'
import type {
  ResolvedImageRoute,
  ResolvedProxyImageRoute,
  VisionAnalysis,
  VisionRequest,
} from '@vascent/deepseek-harness-vision'
import { readVisionEvidence } from '../../../../src/runtime/session/input.ts'
import { AttachmentDraftStore } from '../../../../src/modules/composer/attachments/drafts.ts'
import {
  AttachmentCoordinator,
  type ImageInputGateway,
  type PreparedPromptSender,
} from '../../../../src/modules/composer/attachments/coordinator.ts'
import { imageDraftFromPath } from '../../../../src/modules/composer/attachments/files.ts'
import { imageDraftFromClipboard } from '../../../../src/modules/composer/attachments/clipboard.ts'

const nativeRoute = {
  strategy: 'native', provider: 'native', model: 'vision',
} satisfies ResolvedImageRoute
const proxyRoute = {
  strategy: 'proxy',
  provider: 'proxy',
  model: 'vision',
  maxObservationChars: 12_000,
  maxTokens: 2_048,
} satisfies ResolvedProxyImageRoute

function analysisFor(request: VisionRequest): VisionAnalysis {
  return {
    analysisId: request.analysisId,
    provider: 'proxy',
    model: 'vision',
    observation: 'visible evidence',
    references: request.images.map(image => image.reference),
    attachments: request.images.map((image, index) => ({
      attachmentId: String(index + 1).repeat(64) as ImageAttachmentRef['attachmentId'],
      mediaType: image.mediaType,
      bytes: image.data.byteLength,
      width: 1,
      height: 1,
      ...(image.name === undefined ? {} : { name: image.name }),
    })),
    durationMs: 4,
    truncated: false,
    finishReason: 'stop',
  }
}

function gateway(route: ResolvedImageRoute) {
  return {
    resolveImageRoute: vi.fn<ImageInputGateway['resolveImageRoute']>(async () => route),
    analyze: vi.fn<ImageInputGateway['analyze']>(async (_route, request) => analysisFor(request)),
  } satisfies ImageInputGateway
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
    onContent?.(prepared.content)
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
  it.each([nativeRoute, proxyRoute])('submits $strategy content through the same sender', async (route) => {
    const store = new AttachmentDraftStore()
    const image = addPng(store)
    const text = `inspect this ${image.placeholder}`
    let submittedContent: PromptContentPart[] = []
    const activities: Array<{ kind: 'vision'; analysisId: string; imageCount: number }> = []
    const send = preparedSender(
      content => { submittedContent = content },
      activity => { activities.push(activity) },
    )
    const vision = gateway(route)
    const coordinator = new AttachmentCoordinator(store, vision)
    const selection = { provider: 'active', model: 'model' }

    await expect(coordinator.submit(selection, text, 'steer', send)).resolves.toBeUndefined()

    expect(send).toHaveBeenCalledExactlyOnceWith(text, 'steer', expect.any(Function))
    expect(vision.resolveImageRoute).toHaveBeenCalledExactlyOnceWith('active', 'model', expect.any(AbortSignal))
    expect(submittedContent[0]).toEqual({ type: 'text', text })
    if (route.strategy === 'native') {
      expect(submittedContent).toEqual([
        { type: 'text', text },
        { type: 'image', mediaType: 'image/png', name: 'screen.png', data: Buffer.from(image.data).toString('base64') },
      ])
      expect(activities).toEqual([])
      expect(vision.analyze).not.toHaveBeenCalled()
    } else {
      const request = vision.analyze.mock.calls[0]![1]
      expect(request.analysisId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
      expect(vision.analyze).toHaveBeenCalledExactlyOnceWith(proxyRoute, {
        analysisId: request.analysisId,
        userText: text,
        images: [{ reference: image.placeholder, data: image.data, mediaType: image.mediaType, name: image.name }],
      }, expect.any(AbortSignal))
      expect(submittedContent).toHaveLength(2)
      expect(readVisionEvidence(submittedContent[1])).toEqual(analysisFor(request))
      expect(activities).toEqual([{ kind: 'vision', analysisId: request.analysisId, imageCount: 1 }])
    }
    expect(store.snapshot).toEqual([])
    expect(coordinator.busy).toBe(false)
  })

  it('uses the visible image placeholder in image-only Host content', async () => {
    const store = new AttachmentDraftStore()
    const image = addPng(store)
    let submittedContent: PromptContentPart[] = []
    const send = preparedSender(content => { submittedContent = content })

    await new AttachmentCoordinator(store, gateway(nativeRoute)).submit(
      { provider: 'native', model: 'vision' },
      image.placeholder,
      'queue',
      send,
    )

    expect(send).toHaveBeenCalledExactlyOnceWith('[Image #1]', 'queue', expect.any(Function))
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

    await new AttachmentCoordinator(store, gateway(nativeRoute)).submit(
      { provider: 'native', model: 'vision' },
      `before ${second.placeholder} between ${first.placeholder} after`,
      'queue',
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

  it('preserves inline image order and attachment references in proxy evidence', async () => {
    const store = new AttachmentDraftStore()
    const first = addPng(store, 'first.png')
    const second = addPng(store, 'second.png')
    const vision = gateway(proxyRoute)
    let submittedContent: PromptContentPart[] = []

    await new AttachmentCoordinator(store, vision).submit(
      { provider: 'deepseek', model: 'chat' },
      `before ${second.placeholder} between ${first.placeholder} after`,
      'queue',
      preparedSender(content => { submittedContent = content }),
    )

    const request = vision.analyze.mock.calls[0]![1]
    expect(request.userText).toBe('before [Image #2] between [Image #1] after')
    expect(request.images.map(image => ({ reference: image.reference, name: image.name }))).toEqual([
      { reference: '[Image #2]', name: 'second.png' },
      { reference: '[Image #1]', name: 'first.png' },
    ])
    expect(submittedContent[0]).toEqual({ type: 'text', text: request.userText })
    const evidence = readVisionEvidence(submittedContent[1])
    expect(evidence).toEqual(analysisFor(request))
    expect(evidence?.references).toEqual(['[Image #2]', '[Image #1]'])
    expect(evidence?.attachments.map(attachment => attachment.name)).toEqual(['second.png', 'first.png'])
  })

  it('does not fabricate a position when an attachment has no inline reference', async () => {
    const store = new AttachmentDraftStore()
    addPng(store)
    const send = preparedSender()

    await expect(new AttachmentCoordinator(store, gateway(nativeRoute)).submit(
      { provider: 'native', model: 'vision' },
      'inspect this',
      'queue',
      send,
    )).rejects.toThrow('Attached image is missing its inline reference: [Image #1]')
    expect(send).not.toHaveBeenCalled()
  })

  it('transfers images during proxy analysis without consuming the next draft', async () => {
    const store = new AttachmentDraftStore()
    const image = addPng(store)
    const vision = gateway(proxyRoute)
    let releaseAnalysis!: () => void
    vision.analyze.mockImplementation(async (_route, request) => {
      await new Promise<void>(resolve => { releaseAnalysis = resolve })
      return analysisFor(request)
    })
    const coordinator = new AttachmentCoordinator(store, vision)

    const submission = coordinator.submit(
      { provider: 'deepseek', model: 'chat' },
      `inspect this ${image.placeholder}`,
      'queue',
      preparedSender(),
    )

    await vi.waitFor(() => { expect(vision.analyze).toHaveBeenCalledOnce() })
    expect(store.snapshot).toEqual([])
    expect(coordinator.busy).toBe(true)
    const nextDraft = addPng(store, 'next.png')
    releaseAnalysis()
    await submission
    expect(store.snapshot).toEqual([nextDraft])
    expect(coordinator.busy).toBe(false)
  })

  it.each([nativeRoute, proxyRoute])('restores $strategy drafts when sending prepared content fails', async (route) => {
    const store = new AttachmentDraftStore()
    const image = addPng(store)
    const send = vi.fn<PreparedPromptSender>(async (_text, _mode, prepareContent) => {
      await prepareContent({ setActivity: () => {} })
      expect(store.snapshot).toEqual([])
      throw new Error('Session changed before sending.')
    })
    const coordinator = new AttachmentCoordinator(store, gateway(route))

    await expect(coordinator.submit(
      { provider: 'active', model: 'model' },
      image.placeholder,
      'queue',
      send,
    )).rejects.toThrow('Session changed before sending.')

    expect(store.snapshot).toEqual([{ ...image, error: 'Session changed before sending.' }])
    expect(coordinator.busy).toBe(false)
  })

  it.each(['resolveImageRoute', 'analyze'] as const)('restores drafts when %s fails during preparation', async (stage) => {
    const store = new AttachmentDraftStore()
    const image = addPng(store)
    const vision = gateway(proxyRoute)
    vision[stage].mockRejectedValueOnce(new Error('Vision unavailable.'))
    const onContent = vi.fn()
    const coordinator = new AttachmentCoordinator(store, vision)

    await expect(coordinator.submit(
      { provider: 'deepseek', model: 'chat' },
      image.placeholder,
      'queue',
      preparedSender(onContent),
    )).rejects.toThrow('Vision unavailable.')

    expect(onContent).not.toHaveBeenCalled()
    expect(store.snapshot).toEqual([{ ...image, error: 'Vision unavailable.' }])
    expect(coordinator.busy).toBe(false)
  })

  it.each([true, false])('cancels proxy preparation with restoreDrafts=%s', async (restoreDrafts) => {
    const store = new AttachmentDraftStore()
    const image = addPng(store)
    const vision = gateway(proxyRoute)
    let releaseAnalysis!: () => void
    vision.analyze.mockImplementation(async (_route, request) => {
      await new Promise<void>(resolve => { releaseAnalysis = resolve })
      return analysisFor(request)
    })
    const onContent = vi.fn()
    const coordinator = new AttachmentCoordinator(store, vision)
    const submission = coordinator.submit(
      { provider: 'deepseek', model: 'chat' },
      image.placeholder,
      'queue',
      preparedSender(onContent),
    )
    const rejection = expect(submission).rejects.toThrow('Image preparation cancelled.')

    await vi.waitFor(() => { expect(vision.analyze).toHaveBeenCalledOnce() })
    coordinator.cancel(restoreDrafts)
    expect(vision.analyze.mock.calls[0]![2]?.aborted).toBe(true)
    releaseAnalysis()
    await rejection

    expect(onContent).not.toHaveBeenCalled()
    expect(store.snapshot).toEqual(restoreDrafts ? [{ ...image, error: undefined }] : [])
    expect(coordinator.busy).toBe(false)
  })

  it('retains failed drafts with an actionable error', async () => {
    const store = new AttachmentDraftStore()
    const image = addPng(store)
    const vision = gateway({
      strategy: 'disabled', reason: 'proxy-unavailable', message: 'Configure Vision first.',
    })

    await expect(new AttachmentCoordinator(store, vision).submit(
      { provider: 'deepseek', model: 'chat' },
      `inspect this ${image.placeholder}`,
      'queue',
      preparedSender(),
    )).rejects.toThrow('Configure Vision first.')
    expect(store.snapshot[0]?.error).toBe('Configure Vision first.')
  })
})

describe('image intake', () => {
  it('loads explicit relative image paths as local drafts for Host admission', async () => {
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
