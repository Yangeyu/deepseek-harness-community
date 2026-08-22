import { AttachmentId, type AttachmentStore, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { FileSystem, FsObservation, FsTarget } from '@deepseek-ai/dsh-fs'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { detectImageMediaType } from './image.ts'
import type { VisionInspection } from './types.ts'

export const INSPECT_IMAGE_TOOL_NAME = 'inspect_image'
const PLUGIN_NAME = 'community-vision'

type VisionAttachmentStore = Pick<AttachmentStore, 'imageLimits' | 'readImage' | 'saveImage' | 'validateImage'>
type VisionFileSystem = Pick<FileSystem, 'readBytes' | 'resolve' | 'stat'>

export interface InspectImageToolOptions {
  attachments: VisionAttachmentStore
  fs: VisionFileSystem
  observe(target: FsTarget, observation: FsObservation, actor: object | undefined): void
  inspect(attachment: ImageAttachmentRef, userText: string, signal?: AbortSignal): Promise<VisionInspection>
}

interface AttachmentRefValue {
  attachmentId: string
  mediaType: ImageAttachmentRef['mediaType']
  bytes: number
  width: number
  height: number
  name?: string
  originalDimensions?: {
    width: number
    height: number
  }
}

interface InspectImageOutput {
  attachment_ref: AttachmentRefValue
  provider: string
  model: string
  observation: string
  durationMs: number
  truncated: boolean
  finishReason: string
}

function escapeElement(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll(/\p{Cc}/gu, character => character === '\n' || character === '\t' ? character : '')
}

function inspectionContent(value: InspectImageOutput): ContentBlock[] {
  const attachment = value.attachment_ref
  const serialized = JSON.stringify(attachment)
  if (serialized === undefined) throw new Error('attachment reference is not serializable')
  return [{
    type: 'text',
    text: [
      `<attachment_ref>${escapeElement(serialized)}</attachment_ref>`,
      `<image>${attachment.mediaType}, ${String(attachment.width)}x${String(attachment.height)} px, ${String(attachment.bytes)} bytes</image>`,
      value.observation,
    ].join('\n'),
  }]
}

const ATTACHMENT_REF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: {
      type: 'string',
      required: true,
      enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
    originalDimensions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
      },
    },
  },
} as const

const IMAGE_SOURCE_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'file', required: true },
        path: {
          type: 'string',
          required: true,
          description: 'Absolute or agent-working-directory-relative path supplied by the user or discovered in the workspace.',
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'attachment', required: true },
        attachment_ref: { ...ATTACHMENT_REF_SCHEMA, required: true },
      },
    },
  ],
} as const

function imageAttachmentRef(value: AttachmentRefValue): ImageAttachmentRef {
  if (value.attachmentId.trim() === '') {
    throw new Error('attachment_ref.attachmentId must be a non-empty string')
  }
  return {
    attachmentId: AttachmentId(value.attachmentId),
    mediaType: value.mediaType,
    bytes: value.bytes,
    width: value.width,
    height: value.height,
    ...value.name === undefined ? {} : { name: value.name },
    ...value.originalDimensions === undefined ? {} : { originalDimensions: value.originalDimensions },
  }
}

function quotedPath(path: string): string {
  return JSON.stringify(path)
}

/** Build the proxy-backed image tool independently from terminal composition. */
export function createInspectImageTool(options: InspectImageToolOptions): ToolDefinition {
  return defineTool({
    name: INSPECT_IMAGE_TOOL_NAME,
    description: 'Inspect a PNG/JPEG/WebP/GIF through the configured Vision proxy and return text-only visual evidence. Use this instead of read_image when the active model cannot consume images directly. For a user-provided or workspace path, use source.kind "file" directly. For an image from a Vision observation, use source.kind "attachment" with its exact attachment_ref. Never manufacture an attachment ID from a path or hash.',
    parameters: {
      source: {
        ...IMAGE_SOURCE_SCHEMA,
        required: true,
        description: 'Explicit image provenance. File paths and durable attachments are separate supported sources; the tool never falls back from one to the other.',
      },
      question: {
        type: 'string',
        description: 'Optional question that focuses the visual inspection on details needed for the current task.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attachment_ref: { ...ATTACHMENT_REF_SCHEMA, required: true },
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
          observation: { type: 'string', required: true },
          durationMs: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          finishReason: { type: 'string', required: true },
        },
      },
      render: (_args, value) => inspectionContent(value),
    },
    async execute(args, exec) {
      let attachment: ImageAttachmentRef
      if (args.source.kind === 'file') {
        const cwd = exec.agent?.session.header.cwd
        if (cwd === undefined) throw new Error('inspect_image requires an agent working directory for file sources')
        const target = await options.fs.resolve(args.source.path, { cwd, signal: exec.signal })
        const info = await options.fs.stat(target, exec.signal)
        if (info === undefined) {
          options.observe(target, { kind: 'absent' }, exec)
          throw new Error(`cannot inspect ${quotedPath(target.displayPath)}: file does not exist`)
        }
        options.observe(target, { kind: 'present', version: info.version }, exec)
        if (info.type !== 'file') {
          throw new Error(`cannot inspect ${quotedPath(target.displayPath)}: path is not a regular file`)
        }
        const byteCap = Math.min(
          options.attachments.imageLimits.maxImageBytes,
          options.attachments.imageLimits.maxMessageImageBytes,
        )
        if (info.size !== undefined && info.size > byteCap) {
          throw new Error(`cannot inspect ${quotedPath(target.displayPath)}: image exceeds the ${String(byteCap)} byte limit`)
        }
        const data = await options.fs.readBytes(target, exec.signal, byteCap)
        exec.signal.throwIfAborted()
        const mediaType = detectImageMediaType(data)
        if (mediaType === undefined) {
          throw new Error(`cannot inspect ${quotedPath(target.displayPath)}: file is not a supported PNG, JPEG, WebP, or GIF image`)
        }
        attachment = await options.attachments.saveImage({ data, mediaType })
      }
      else {
        const requestedRef = imageAttachmentRef(args.source.attachment_ref)
        const stored = await options.attachments.readImage(requestedRef, exec.signal)
        exec.signal.throwIfAborted()
        const name = stored.ref.name
        await options.attachments.validateImage({
          data: stored.data,
          mediaType: stored.ref.mediaType,
          ...name === undefined ? {} : { name },
        })
        attachment = stored.ref
      }
      exec.signal.throwIfAborted()
      const result = await options.inspect(attachment, args.question?.trim() ?? '', exec.signal)
      const value: InspectImageOutput = {
        attachment_ref: attachment,
        provider: result.provider,
        model: result.model,
        observation: result.observation,
        durationMs: result.durationMs,
        truncated: result.truncated,
        finishReason: result.finishReason,
      }
      if (exec.parent !== undefined) {
        exec.deferContext(createUserMessage({
          content: inspectionContent(value),
          source: { kind: 'plugin', plugin: PLUGIN_NAME },
        }))
      }
      return value
    },
    presentCall: args => args.source.kind === 'file'
      ? {
          card: 'generic',
          title: `Inspect image ${args.source.path}`,
          kind: 'read',
          locations: [{ path: args.source.path }],
        }
      : {
          card: 'generic',
          title: `Inspect image ${args.source.attachment_ref.attachmentId}`,
          kind: 'read',
          rawInput: args.source.attachment_ref,
        },
  })
}
