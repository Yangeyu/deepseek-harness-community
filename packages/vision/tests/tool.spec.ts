import { describe, expect, it, vi } from 'vitest'
import type { ImageAttachmentLimits, ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import type { JsonValue, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  createInspectImageTool,
  INSPECT_IMAGE_TOOL_NAME,
  type InspectImageToolOptions,
} from '../src/tool.ts'
import type { VisionInspection } from '../src/types.ts'

const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
const storedAttachment: StoredImageAttachment = {
  data: png,
  ref: {
    attachmentId: 'sha256:image' as ImageAttachmentRef['attachmentId'],
    mediaType: 'image/png',
    bytes: png.byteLength,
    width: 320,
    height: 180,
    name: 'screen.png',
    originalDimensions: { width: 2_560, height: 1_440 },
  },
}
const limits: ImageAttachmentLimits = {
  maxImageBytes: 1_024,
  maxImagesPerMessage: 4,
  maxMessageImageBytes: 2_048,
  maxImagePixels: 1_000_000,
  maxImageDimension: 2_000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}
const filePath = '/Users/yinfinity/Downloads/rendered/slide-12.png'
const fileTarget = {
  targetKey: filePath as FsTarget['targetKey'],
  displayPath: filePath,
} satisfies FsTarget
const fileInfo = {
  version: 'file-v1' as FsInfo['version'],
  type: 'file',
  size: png.byteLength,
} satisfies FsInfo
const inspection: VisionInspection = {
  provider: 'bailian',
  model: 'qwen-vision',
  attachments: [{
    attachmentId: 'sha256:image' as ImageAttachmentRef['attachmentId'],
    mediaType: 'image/png',
    bytes: png.byteLength,
    width: 320,
    height: 180,
    name: 'screen.png',
    originalDimensions: { width: 2_560, height: 1_440 },
  }],
  observation: '<vision-observation trust="untrusted">visible UI</vision-observation>',
  durationMs: 42,
  truncated: false,
  finishReason: 'stop',
}

function runContext(options: { nested?: boolean } = {}): {
  exec: ToolRunContext
  deferContext: ReturnType<typeof vi.fn>
} {
  const deferContext = vi.fn()
  return {
    exec: {
      callId: 'call-1',
      rootCallId: 'call-1',
      name: INSPECT_IMAGE_TOOL_NAME,
      arguments: {},
      signal: new AbortController().signal,
      token: Symbol('tool'),
      agent: { session: { header: { cwd: '/workspace' } } },
      ...options.nested === true ? { parent: Symbol('parent') } : {},
      deferContext,
      concludeTurn: vi.fn(),
    } as unknown as ToolRunContext,
    deferContext,
  }
}

function fixture() {
  const resolve = vi.fn(async () => fileTarget)
  const stat = vi.fn(async () => fileInfo)
  const readBytes = vi.fn(async () => png)
  const readImage = vi.fn(async () => storedAttachment)
  const saveImage = vi.fn(async () => storedAttachment.ref)
  const validateImage = vi.fn(async () => undefined)
  const observe = vi.fn()
  const inspect = vi.fn(async () => inspection)
  const tool = createInspectImageTool({
    attachments: { imageLimits: limits, readImage, saveImage, validateImage },
    fs: { resolve, stat, readBytes },
    observe,
    inspect,
  } as InspectImageToolOptions)
  return { tool, resolve, stat, readBytes, readImage, saveImage, validateImage, observe, inspect }
}

describe('inspect_image', () => {
  it('reads an attachment and returns text-only proxy evidence', async () => {
    const current = fixture()
    const { exec, deferContext } = runContext({ nested: true })

    const value = await current.tool.execute({
      source: { kind: 'attachment', attachment_ref: storedAttachment.ref },
      question: 'Which control failed?',
    }, exec)

    expect(current.tool.name).toBe(INSPECT_IMAGE_TOOL_NAME)
    expect(current.readImage).toHaveBeenCalledWith(storedAttachment.ref, exec.signal)
    expect(current.validateImage).toHaveBeenCalledWith({
      data: png,
      mediaType: 'image/png',
      name: 'screen.png',
    })
    expect(current.saveImage).not.toHaveBeenCalled()
    expect(current.inspect).toHaveBeenCalledWith(storedAttachment.ref, 'Which control failed?', exec.signal)
    expect(value).toMatchObject({
      attachment_ref: storedAttachment.ref,
      provider: 'bailian',
      model: 'qwen-vision',
      observation: expect.stringContaining('trust="untrusted"'),
    })

    const rendered = current.tool.output.render({}, value as JsonValue)
    expect(rendered).toHaveLength(1)
    expect(rendered[0]).toMatchObject({ type: 'text', text: expect.stringContaining('sha256:image') })
    expect(rendered[0]).toHaveProperty('type', 'text')
    expect(deferContext).toHaveBeenCalledOnce()
    expect(deferContext.mock.calls[0]?.[0]).toMatchObject({
      source: { kind: 'plugin', plugin: 'community-vision' },
      content: [{ type: 'text', text: expect.stringContaining('<vision-observation') }],
    })
  })

  it('inspects a user-provided absolute file path through the filesystem seam', async () => {
    const current = fixture()
    const { exec } = runContext()

    const value = await current.tool.execute({
      source: { kind: 'file', path: filePath },
      question: 'What is shown on this slide?',
    }, exec)

    expect(current.resolve).toHaveBeenCalledWith(filePath, { cwd: '/workspace', signal: exec.signal })
    expect(current.stat).toHaveBeenCalledWith(fileTarget, exec.signal)
    expect(current.observe).toHaveBeenCalledWith(fileTarget, { kind: 'present', version: fileInfo.version }, exec)
    expect(current.readBytes).toHaveBeenCalledWith(fileTarget, exec.signal, 1_024)
    expect(current.saveImage).toHaveBeenCalledWith({ data: png, mediaType: 'image/png' })
    expect(current.readImage).not.toHaveBeenCalled()
    expect(current.validateImage).not.toHaveBeenCalled()
    expect(current.inspect).toHaveBeenCalledWith(storedAttachment.ref, 'What is shown on this slide?', exec.signal)
    expect(value).toMatchObject({ attachment_ref: storedAttachment.ref })
  })

  it('rejects an empty attachment identity before reading storage', async () => {
    const current = fixture()
    await expect(current.tool.execute({
      source: {
        kind: 'attachment',
        attachment_ref: { ...storedAttachment.ref, attachmentId: '   ' },
      },
    }, runContext().exec)).rejects.toThrow('attachment_ref.attachmentId must be a non-empty string')
    expect(current.readImage).not.toHaveBeenCalled()
    expect(current.validateImage).not.toHaveBeenCalled()
  })
})
