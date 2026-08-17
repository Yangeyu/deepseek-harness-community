import { describe, expect, it } from 'vitest'
import { detectImageMediaType, imageDimensions } from '../src/image.ts'

describe('image metadata', () => {
  it('detects supported formats from bytes rather than path extensions', () => {
    expect(detectImageMediaType(Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))).toBe('image/png')
    expect(detectImageMediaType(Uint8Array.from([0xFF, 0xD8, 0xFF]))).toBe('image/jpeg')
    expect(detectImageMediaType(new TextEncoder().encode('GIF89a'))).toBe('image/gif')
    expect(detectImageMediaType(new TextEncoder().encode('RIFF0000WEBP'))).toBe('image/webp')
    expect(detectImageMediaType(new TextEncoder().encode('not an image'))).toBeUndefined()
  })

  it('reads PNG dimensions from the bounded header', () => {
    const data = new Uint8Array(24)
    data.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    data.set([0, 0, 1, 64], 16)
    data.set([0, 0, 0, 180], 20)

    expect(imageDimensions(data, 'image/png')).toEqual({ width: 320, height: 180 })
  })
})
