import { basename, extname } from 'node:path'
import {
  AttachmentId,
  type AttachmentStore,
  type ImageAttachmentRef,
  type ImageMediaType,
} from '@deepseek-ai/dsh-attachment'
import type { FileSystem, FsObservation, FsTarget } from '@deepseek-ai/dsh-fs'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

const IMAGE_MEDIA_TYPES: Readonly<Record<string, ImageMediaType>> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

type VisionAttachmentStore = Pick<AttachmentStore, 'imageLimits' | 'readImage' | 'saveImage'>
type VisionFileSystem = Pick<FileSystem, 'readBytes' | 'resolve' | 'stat'>

export interface AttachmentRefValue {
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

export type InspectImageSource =
  | { kind: 'file'; path: string }
  | { kind: 'attachment'; attachment_ref: AttachmentRefValue }

export interface InspectionSourceOptions {
  attachments: VisionAttachmentStore
  fs: VisionFileSystem
  observe(target: FsTarget, observation: FsObservation, actor: object | undefined): void
}

function declaredMediaType(path: string): ImageMediaType | undefined {
  return IMAGE_MEDIA_TYPES[extname(path).toLowerCase()]
}

function attachmentRef(value: AttachmentRefValue): ImageAttachmentRef {
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

/** Resolve one explicit source through official filesystem and attachment services. */
export async function materializeInspectionSource(
  source: InspectImageSource,
  exec: ToolRunContext,
  options: InspectionSourceOptions,
): Promise<ImageAttachmentRef> {
  if (source.kind === 'attachment') {
    const stored = await options.attachments.readImage(attachmentRef(source.attachment_ref), exec.signal)
    exec.signal.throwIfAborted()
    return stored.ref
  }

  const mediaType = declaredMediaType(source.path)
  if (mediaType === undefined) {
    throw new Error(`cannot inspect ${quotedPath(source.path)}: inspect_image only accepts PNG/JPEG/WebP/GIF paths`)
  }
  if (!options.attachments.imageLimits.mediaTypes.includes(mediaType)) {
    throw new Error(`cannot inspect ${quotedPath(source.path)}: ${mediaType} images are not accepted by this deployment`)
  }
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined) throw new Error('inspect_image requires an agent working directory for file sources')
  const target = await options.fs.resolve(source.path, { cwd, signal: exec.signal })
  const info = await options.fs.stat(target, exec.signal)
  if (info === undefined) {
    options.observe(target, { kind: 'absent' }, exec)
    throw new Error(`cannot inspect ${quotedPath(target.displayPath)}: file does not exist`)
  }
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
  const stored = await options.attachments.saveImage({
    data,
    mediaType,
    name: basename(target.displayPath),
  })
  exec.signal.throwIfAborted()
  options.observe(target, { kind: 'present', version: info.version }, exec)
  return stored
}
