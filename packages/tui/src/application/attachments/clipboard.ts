import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { detectImageMediaType, imageDimensions } from './files.ts'
import type { NewAttachmentDraft } from './drafts.ts'

const execFile = promisify(execFileCallback)

const COPY_PNG_SCRIPT = [
  'on run argv',
  'set destination to POSIX file (item 1 of argv)',
  'set imageData to the clipboard as «class PNGf»',
  'set fileHandle to open for access destination with write permission',
  'set eof fileHandle to 0',
  'write imageData to fileHandle',
  'close access fileHandle',
  'end run',
].join('\n')

export type ClipboardCommand = (file: string) => Promise<void>
export type ClipboardImageLoader = () => Promise<NewAttachmentDraft>

async function copyMacClipboard(file: string): Promise<void> {
  await execFile('osascript', ['-e', COPY_PNG_SCRIPT, file])
}

/** Copy a macOS clipboard image through a private temporary file and clean it immediately. */
export async function imageDraftFromClipboard(
  command: ClipboardCommand = copyMacClipboard,
): Promise<NewAttachmentDraft> {
  if (process.platform !== 'darwin' && command === copyMacClipboard) {
    throw new Error('Clipboard image input is currently available on macOS. Use /attach <path> instead.')
  }
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tui-vision-'))
  const file = join(directory, 'clipboard.png')
  try {
    await command(file)
    const data = await readFile(file)
    const mediaType = detectImageMediaType(data)
    if (mediaType === undefined) throw new Error('The clipboard does not contain a supported image.')
    return { name: 'clipboard.png', mediaType, data, source: 'clipboard', ...imageDimensions(data, mediaType) }
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('supported image')) throw error
    throw new Error('The clipboard does not contain a readable image.', { cause: error })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
