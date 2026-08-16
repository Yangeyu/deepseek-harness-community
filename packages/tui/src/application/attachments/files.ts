import { basename, resolve } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { NewAttachmentDraft } from './drafts.ts'

function startsWith(data: Uint8Array, bytes: readonly number[]): boolean {
  return bytes.every((byte, index) => data[index] === byte)
}

/** Detect the format from bytes so an extension cannot bypass Host validation. */
export function detectImageMediaType(data: Uint8Array): ImageMediaType | undefined {
  if (startsWith(data, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'image/png'
  if (startsWith(data, [0xFF, 0xD8, 0xFF])) return 'image/jpeg'
  const signature = new TextDecoder('ascii').decode(data.slice(0, 6))
  if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif'
  const riff = new TextDecoder('ascii').decode(data.slice(0, 4))
  const webp = new TextDecoder('ascii').decode(data.slice(8, 12))
  return riff === 'RIFF' && webp === 'WEBP' ? 'image/webp' : undefined
}

function uint16(data: Uint8Array, offset: number, littleEndian: boolean): number {
  return littleEndian
    ? (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8)
    : ((data[offset] ?? 0) << 8) | (data[offset + 1] ?? 0)
}

function uint32(data: Uint8Array, offset: number): number {
  return ((data[offset] ?? 0) * 0x1000000)
    + ((data[offset + 1] ?? 0) << 16)
    + ((data[offset + 2] ?? 0) << 8)
    + (data[offset + 3] ?? 0)
}

/** Read inexpensive header dimensions for draft feedback; Host decoding remains authoritative. */
export function imageDimensions(
  data: Uint8Array,
  mediaType: ImageMediaType,
): { width: number; height: number } | undefined {
  if (mediaType === 'image/png' && data.length >= 24) {
    return { width: uint32(data, 16), height: uint32(data, 20) }
  }
  if (mediaType === 'image/gif' && data.length >= 10) {
    return { width: uint16(data, 6, true), height: uint16(data, 8, true) }
  }
  if (mediaType === 'image/webp') {
    const chunk = new TextDecoder('ascii').decode(data.slice(12, 16))
    if (chunk === 'VP8X' && data.length >= 30) {
      const width = 1 + (data[24] ?? 0) + ((data[25] ?? 0) << 8) + ((data[26] ?? 0) << 16)
      const height = 1 + (data[27] ?? 0) + ((data[28] ?? 0) << 8) + ((data[29] ?? 0) << 16)
      return { width, height }
    }
    if (chunk === 'VP8L' && data.length >= 25 && data[20] === 0x2F) {
      const width = 1 + (data[21] ?? 0) + (((data[22] ?? 0) & 0x3F) << 8)
      const height = 1 + ((data[22] ?? 0) >> 6) + ((data[23] ?? 0) << 2) + (((data[24] ?? 0) & 0x0F) << 10)
      return { width, height }
    }
    if (chunk === 'VP8 ' && data.length >= 30
      && data[23] === 0x9D && data[24] === 0x01 && data[25] === 0x2A) {
      return {
        width: uint16(data, 26, true) & 0x3FFF,
        height: uint16(data, 28, true) & 0x3FFF,
      }
    }
    return undefined
  }
  if (mediaType !== 'image/jpeg') return undefined
  let offset = 2
  while (offset + 8 < data.length) {
    if (data[offset] !== 0xFF) {
      offset += 1
      continue
    }
    const marker = data[offset + 1] ?? 0
    const length = uint16(data, offset + 2, false)
    if (length < 2) return undefined
    if (marker >= 0xC0 && marker <= 0xC3) {
      return { height: uint16(data, offset + 5, false), width: uint16(data, offset + 7, false) }
    }
    offset += length + 2
  }
  return undefined
}

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
