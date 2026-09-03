import { basename, extname, resolve } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { NewAttachmentDraft } from './drafts.ts'

const IMAGE_MEDIA_TYPES: Readonly<Record<string, ImageMediaType>> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

/** Read one explicit path relative to the active session directory. */
export async function imageDraftFromPath(path: string, cwd: string): Promise<NewAttachmentDraft> {
  const absolute = resolve(cwd, path)
  const mediaType = IMAGE_MEDIA_TYPES[extname(absolute).toLowerCase()]
  if (mediaType === undefined) throw new Error('Supported image paths end in PNG, JPEG, GIF, or WebP.')
  const metadata = await stat(absolute)
  if (!metadata.isFile()) throw new Error(`Image path is not a regular file: ${absolute}`)
  const data = await readFile(absolute)
  return { name: basename(absolute), mediaType, data, source: 'file' }
}
