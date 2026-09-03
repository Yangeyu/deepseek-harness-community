import { readFile } from 'node:fs/promises'
import type { DiffTextReader } from '../../modules/transcript/diff-location.ts'

/** Node filesystem adapter used by Transcript diff-location projection. */
export class NodeTextFileReader implements DiffTextReader {
  readText(path: string, signal?: AbortSignal): Promise<string> {
    return readFile(path, {
      encoding: 'utf8',
      ...signal === undefined ? {} : { signal },
    })
  }
}
