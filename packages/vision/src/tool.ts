import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  materializeInspectionSource,
  type AttachmentRefValue,
  type InspectionSourceOptions,
} from './source.ts'
import type {
  ResolvedImageRoute,
  ResolvedProxyImageRoute,
  VisionInspection,
} from './types.ts'

export const INSPECT_IMAGE_TOOL_NAME = 'inspect_image'
const PLUGIN_NAME = 'community-vision'

export interface InspectImageToolOptions extends InspectionSourceOptions {
  resolveRoute(exec: ToolRunContext): Promise<ResolvedImageRoute>
  inspect(
    attachment: ImageAttachmentRef,
    userText: string,
    route: ResolvedProxyImageRoute,
    signal?: AbortSignal,
  ): Promise<VisionInspection>
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

/** Build the proxy-backed image tool independently from terminal composition. */
export function createInspectImageTool(options: InspectImageToolOptions): ToolDefinition {
  return defineTool({
    name: INSPECT_IMAGE_TOOL_NAME,
    description: 'Inspect a PNG/JPEG/WebP/GIF through the configured Vision proxy and return text-only visual evidence. This is a fallback for a text-only current model or an explicitly forced proxy route. Never call it for an image already included in the current prompt: that image is already visible to an image-capable model. For a user-provided or workspace path, use source.kind "file". For an image from prior Vision evidence, use source.kind "attachment" with its exact attachment_ref. Never manufacture an attachment ID from a path or hash.',
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
      const route = await options.resolveRoute(exec)
      exec.signal.throwIfAborted()
      if (route.strategy === 'disabled') throw new Error(route.message)
      if (route.strategy === 'native') {
        throw new Error(
          `inspect_image is unavailable because ${route.provider}/${route.model} accepts image input; use the inline image directly or read_image for a file`,
        )
      }
      const attachment = await materializeInspectionSource(args.source, exec, options)
      const result = await options.inspect(attachment, args.question?.trim() ?? '', route, exec.signal)
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
