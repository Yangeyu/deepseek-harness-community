import { basename, resolve } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import {
  detectImageMediaType,
  imageDimensions,
} from '@vascent/deepseek-harness-vision'
import type { NewAttachmentDraft } from './drafts.ts'

export { detectImageMediaType, imageDimensions }

/** Read one explicit path relative to the active session directory. */
export async function imageDraftFromPath(path: string, cwd: string): Promise<NewAttachmentDraft> {
  const absolute = resolve(cwd, path)
  const metadata = await stat(absolute)
  if (!metadata.isFile()) throw new Error(`Image path is not a regular file: ${absolute}`)
  const data = await readFile(absolute)
  const mediaType = detectImageMediaType(data)
  if (mediaType === undefined) throw new Error('Supported image formats are PNG, JPEG, GIF, and WebP.')
  return { name: basename(absolute), mediaType, data, source: 'file', ...imageDimensions(data, mediaType) }
}
