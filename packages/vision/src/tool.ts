import { basename } from 'node:path'
import type { ImageAttachmentLimits, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { FileSystem, FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { detectImageMediaType } from './image.ts'
import type { VisionInspection, VisionInspectionRequest } from './types.ts'

export const INSPECT_IMAGE_TOOL_NAME = 'inspect_image'
const PLUGIN_NAME = 'community-vision'

type VisionFileSystem = Pick<FileSystem, 'resolve' | 'contains' | 'stat' | 'readBytes'>

export interface InspectImageToolOptions {
  fs: VisionFileSystem
  imageLimits: ImageAttachmentLimits
  inspect(request: VisionInspectionRequest, signal?: AbortSignal): Promise<VisionInspection>
  observe?(target: FsTarget, version: FsVersion, exec: ToolRunContext): void
}

interface InspectImageOutput {
  path: string
  image: {
    mediaType: ImageMediaType
    bytes: number
    width: number
    height: number
    name?: string
  }
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
  return [{
    type: 'text',
    text: [
      `<path>${escapeElement(value.path)}</path>`,
      `<image>${value.image.mediaType}, ${String(value.image.width)}x${String(value.image.height)} px, ${String(value.image.bytes)} bytes</image>`,
      value.observation,
    ].join('\n'),
  }]
}

function quotedPath(path: string): string {
  return JSON.stringify(path)
}

/** Build the proxy-backed image tool independently from terminal composition. */
export function createInspectImageTool(options: InspectImageToolOptions): ToolDefinition {
  return defineTool({
    name: INSPECT_IMAGE_TOOL_NAME,
    description: 'Inspect a PNG/JPEG/WebP/GIF workspace image through the configured Vision proxy and return text-only visual evidence. Use this for @-referenced image paths when the active model cannot use read_image; prefer read_image when the active model natively accepts images.',
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: 'Image path relative to the active workspace, without the leading @ reference marker. The resolved file must remain inside that workspace.',
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
          path: { type: 'string', required: true },
          image: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              mediaType: {
                type: 'string',
                required: true,
                enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
              },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' },
            },
          },
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
      const requestedPath = args.file_path.trim()
      if (requestedPath === '') throw new Error('file_path must be a non-empty string')
      const cwd = exec.agent?.session.header.cwd
      if (cwd === undefined) throw new Error('inspect_image requires an agent working directory')

      const [workspace, target] = await Promise.all([
        options.fs.resolve('.', { cwd, signal: exec.signal }),
        options.fs.resolve(requestedPath, { cwd, signal: exec.signal }),
      ])
      exec.signal.throwIfAborted()
      if (!options.fs.contains(workspace, target)) {
        throw new Error(`cannot inspect ${quotedPath(requestedPath)}: the resolved image is outside the active workspace`)
      }
      const info = await options.fs.stat(target, exec.signal)
      if (info === undefined) throw new Error(`cannot inspect ${quotedPath(requestedPath)}: the image does not exist`)
      if (info.type !== 'file') throw new Error(`cannot inspect ${quotedPath(requestedPath)}: the path is not a regular file`)

      const byteCap = Math.min(options.imageLimits.maxImageBytes, options.imageLimits.maxMessageImageBytes)
      if (info.size !== undefined && info.size > byteCap) {
        throw new Error(`cannot inspect ${quotedPath(requestedPath)}: the image exceeds the ${String(byteCap)} byte limit`)
      }
      const data = await options.fs.readBytes(target, exec.signal, byteCap)
      const mediaType = detectImageMediaType(data)
      if (mediaType === undefined) {
        throw new Error(`cannot inspect ${quotedPath(requestedPath)}: supported image formats are PNG, JPEG, GIF, and WebP`)
      }
      if (!options.imageLimits.mediaTypes.includes(mediaType)) {
        throw new Error(`cannot inspect ${quotedPath(requestedPath)}: ${mediaType} images are not accepted by this deployment`)
      }

      const name = basename(target.displayPath)
      const result = await options.inspect({
        userText: args.question?.trim() ?? '',
        images: [{ data, mediaType, ...name === '' ? {} : { name } }],
      }, exec.signal)
      const attachment = result.attachments[0]
      if (attachment === undefined) throw new Error('Vision inspection returned no image metadata')
      const value: InspectImageOutput = {
        path: target.displayPath,
        image: {
          mediaType: attachment.mediaType,
          bytes: attachment.bytes,
          width: attachment.width,
          height: attachment.height,
          ...attachment.name === undefined ? {} : { name: attachment.name },
        },
        provider: result.provider,
        model: result.model,
        observation: result.observation,
        durationMs: result.durationMs,
        truncated: result.truncated,
        finishReason: result.finishReason,
      }
      options.observe?.(target, info.version, exec)
      if (exec.parent !== undefined) {
        exec.deferContext(createUserMessage({
          content: inspectionContent(value),
          source: { kind: 'plugin', plugin: PLUGIN_NAME },
        }))
      }
      return value
    },
    presentCall: args => ({
      card: 'generic',
      title: `Inspect image ${args.file_path}`,
      kind: 'read',
      locations: [{ path: args.file_path }],
    }),
  })
}
