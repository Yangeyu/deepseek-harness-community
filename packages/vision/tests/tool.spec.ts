import { describe, expect, it, vi } from 'vitest'
import type { ImageAttachmentLimits, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import type { JsonValue, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  createInspectImageTool,
  INSPECT_IMAGE_TOOL_NAME,
  type InspectImageToolOptions,
} from '../src/tool.ts'
import type { VisionInspection } from '../src/types.ts'

const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
const version = 'version-1' as FsVersion
const workspace = { targetKey: 'workspace', displayPath: '/workspace' } as FsTarget
const target = { targetKey: 'image', displayPath: '/workspace/screen.png' } as FsTarget
const limits: ImageAttachmentLimits = {
  maxImageBytes: 1_024,
  maxImagesPerMessage: 4,
  maxMessageImageBytes: 2_048,
  maxImagePixels: 1_000_000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}
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
  }],
  observation: '<vision-observation trust="untrusted">visible UI</vision-observation>',
  durationMs: 42,
  truncated: false,
  finishReason: 'stop',
}

function runContext(options: { cwd?: string | undefined; nested?: boolean } = {}): {
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
      agent: options.cwd === undefined && 'cwd' in options
        ? undefined
        : { session: { header: { cwd: options.cwd ?? '/workspace' } } },
      ...options.nested === true ? { parent: Symbol('parent') } : {},
      deferContext,
      concludeTurn: vi.fn(),
    } as unknown as ToolRunContext,
    deferContext,
  }
}

function fixture(overrides: {
  contained?: boolean
  fileType?: 'file' | 'directory' | 'other'
  bytes?: Uint8Array
  size?: number
} = {}) {
  const resolve = vi.fn(async (path: string) => path === '.' ? workspace : target)
  const contains = vi.fn(() => overrides.contained ?? true)
  const stat = vi.fn(async () => ({
    version,
    type: overrides.fileType ?? 'file',
    size: overrides.size ?? (overrides.bytes ?? png).byteLength,
  }))
  const readBytes = vi.fn(async () => overrides.bytes ?? png)
  const inspect = vi.fn(async () => inspection)
  const observe = vi.fn()
  const tool = createInspectImageTool({
    fs: { resolve, contains, stat, readBytes } as unknown as InspectImageToolOptions['fs'],
    imageLimits: limits,
    inspect,
    observe,
  })
  return { tool, resolve, contains, stat, readBytes, inspect, observe }
}

describe('inspect_image', () => {
  it('reads one contained image and returns text-only proxy evidence', async () => {
    const current = fixture()
    const { exec, deferContext } = runContext({ nested: true })

    const value = await current.tool.execute({
      file_path: 'screen.png',
      question: 'Which control failed?',
    }, exec)

    expect(current.tool.name).toBe(INSPECT_IMAGE_TOOL_NAME)
    expect(current.tool.description).toContain('@-referenced image paths')
    expect(current.resolve).toHaveBeenCalledWith('.', { cwd: '/workspace', signal: exec.signal })
    expect(current.resolve).toHaveBeenCalledWith('screen.png', { cwd: '/workspace', signal: exec.signal })
    expect(current.readBytes).toHaveBeenCalledWith(target, exec.signal, 1_024)
    expect(current.inspect).toHaveBeenCalledWith({
      userText: 'Which control failed?',
      images: [{ data: png, mediaType: 'image/png', name: 'screen.png' }],
    }, exec.signal)
    expect(current.observe).toHaveBeenCalledWith(target, version, exec)
    expect(value).toMatchObject({
      path: '/workspace/screen.png',
      provider: 'bailian',
      model: 'qwen-vision',
      image: { mediaType: 'image/png', width: 320, height: 180 },
      observation: expect.stringContaining('trust="untrusted"'),
    })

    const rendered = current.tool.output.render({}, value as JsonValue)
    expect(rendered).toHaveLength(1)
    expect(rendered[0]).toMatchObject({ type: 'text', text: expect.stringContaining('/workspace/screen.png') })
    expect(rendered).not.toContainEqual(expect.objectContaining({ type: 'image' }))
    expect(deferContext).toHaveBeenCalledOnce()
    expect(deferContext.mock.calls[0]?.[0]).toMatchObject({
      source: { kind: 'plugin', plugin: 'community-vision' },
      content: [{ type: 'text', text: expect.stringContaining('<vision-observation') }],
    })
  })

  it('rejects a path that resolves outside the active workspace before reading it', async () => {
    const current = fixture({ contained: false })
    const { exec } = runContext()

    await expect(current.tool.execute({ file_path: '../secret.png' }, exec))
      .rejects.toThrow('outside the active workspace')
    expect(current.stat).not.toHaveBeenCalled()
    expect(current.readBytes).not.toHaveBeenCalled()
    expect(current.inspect).not.toHaveBeenCalled()
  })

  it('rejects non-files and unsupported bytes before invoking the proxy', async () => {
    const directory = fixture({ fileType: 'directory' })
    await expect(directory.tool.execute({ file_path: 'screens' }, runContext().exec))
      .rejects.toThrow('not a regular file')
    expect(directory.readBytes).not.toHaveBeenCalled()

    const malformed = fixture({ bytes: new Uint8Array([1, 2, 3]) })
    await expect(malformed.tool.execute({ file_path: 'fake.png' }, runContext().exec))
      .rejects.toThrow('supported image formats are PNG, JPEG, GIF, and WebP')
    expect(malformed.inspect).not.toHaveBeenCalled()
  })

  it('requires an Agent-owned working directory', async () => {
    const current = fixture()
    const { exec } = runContext({ cwd: undefined })

    await expect(current.tool.execute({ file_path: 'screen.png' }, exec))
      .rejects.toThrow('requires an agent working directory')
    expect(current.resolve).not.toHaveBeenCalled()
  })
})
