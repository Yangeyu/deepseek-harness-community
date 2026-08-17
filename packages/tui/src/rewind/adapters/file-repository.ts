import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isJsonValue } from '@deepseek-ai/dsh-session'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {
  RewindEffectPayload,
  RewindEffectReference,
  RewindPromptInput,
  WorkspaceMutation,
} from '../contracts.ts'
import type { RewindPointSnapshot, RewindTimelineSnapshot } from '../domain/journal.ts'
import type {
  RewindRepository,
  RewindRepositoryEntry,
  StoredRewindParticipant,
  StoredRewindTimeline,
} from '../application/repository.ts'
import { RewindRepositoryConflictError } from '../application/repository.ts'

const SCHEMA_VERSION = 2
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024
const HASH_PATTERN = /^[a-f0-9]{64}$/u
const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 5_000

interface ObjectReference {
  readonly hash: string
  readonly bytes: number
}

type StoredWorkspaceMutation =
  | Omit<Extract<WorkspaceMutation, { readonly kind: 'reversible' }>, 'before' | 'after'> & {
    readonly before: ObjectReference | null
    readonly after: ObjectReference
  }
  | Extract<WorkspaceMutation, { readonly kind: 'unsupported' }>

interface StoredPoint extends Omit<RewindPointSnapshot, 'workspaceMutations' | 'effects'> {
  readonly workspaceMutations: readonly StoredWorkspaceMutation[]
  readonly effects: readonly RewindEffectReference[]
}

interface StoredParticipantEffect {
  readonly effectId: string
  readonly payload: ObjectReference
}

interface StoredParticipantManifest {
  readonly participantId: string
  readonly effects: readonly StoredParticipantEffect[]
}

interface TimelineManifest {
  readonly schema: 2
  readonly workspaceId: string
  readonly workspaceRoot: string
  readonly lineageId: string
  readonly ownerSessionId: string
  readonly cursor: number
  readonly updatedAt: number
  readonly nodes: readonly StoredPoint[]
  readonly participants: readonly StoredParticipantManifest[]
}

export interface FileRewindRepositoryOptions {
  readonly maxObjectBytes?: number
  readonly maxTimelineBytes?: number
  readonly maxGlobalBytes?: number
  readonly onWarning?: (message: string) => void
}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${label} must be a non-empty string`)
  return value
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`)
  return value
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

function objectReference(value: unknown, label: string): ObjectReference {
  const item = record(value, label)
  const objectHash = string(item.hash, `${label}.hash`)
  if (!HASH_PATTERN.test(objectHash)) throw new Error(`${label}.hash is invalid`)
  return { hash: objectHash, bytes: integer(item.bytes, `${label}.bytes`) }
}

function optionalPreviousTurnEndSeq(value: unknown): { readonly previousTurnEndSeq?: number } {
  return value === undefined ? {} : { previousTurnEndSeq: integer(value, 'point.previousTurnEndSeq') }
}

function attachmentRef(value: unknown): ImageAttachmentRef {
  const item = record(value, 'prompt attachment')
  const mediaType = string(item.mediaType, 'prompt attachment.mediaType')
  if (mediaType !== 'image/png'
    && mediaType !== 'image/jpeg'
    && mediaType !== 'image/webp'
    && mediaType !== 'image/gif') throw new Error('prompt attachment.mediaType is invalid')
  const bytes = integer(item.bytes, 'prompt attachment.bytes')
  const width = integer(item.width, 'prompt attachment.width')
  const height = integer(item.height, 'prompt attachment.height')
  if (bytes < 1 || width < 1 || height < 1) throw new Error('prompt attachment dimensions are invalid')
  const name = item.name === undefined ? undefined : string(item.name, 'prompt attachment.name')
  return {
    attachmentId: string(item.attachmentId, 'prompt attachment.attachmentId') as ImageAttachmentRef['attachmentId'],
    mediaType,
    bytes,
    width,
    height,
    ...name === undefined ? {} : { name },
  }
}

function promptInput(value: unknown): RewindPromptInput {
  const item = record(value, 'point.input')
  return {
    text: string(item.text, 'point.input.text'),
    attachments: array(item.attachments, 'point.input.attachments').map(attachmentRef),
  }
}

function effectReference(value: unknown): RewindEffectReference {
  const item = record(value, 'effect')
  return {
    participantId: string(item.participantId, 'effect.participantId'),
    effectId: string(item.effectId, 'effect.effectId'),
    sourceSessionId: string(item.sourceSessionId, 'effect.sourceSessionId'),
    sourceTurn: integer(item.sourceTurn, 'effect.sourceTurn'),
  }
}

function storedMutation(value: unknown): StoredWorkspaceMutation {
  const item = record(value, 'workspace mutation')
  const common = {
    id: string(item.id, 'mutation.id'),
    sourceSessionId: string(item.sourceSessionId, 'mutation.sourceSessionId'),
    sourceTurn: integer(item.sourceTurn, 'mutation.sourceTurn'),
    callId: string(item.callId, 'mutation.callId'),
    rootCallId: string(item.rootCallId, 'mutation.rootCallId'),
    order: integer(item.order, 'mutation.order'),
    path: string(item.path, 'mutation.path'),
    createdAt: integer(item.createdAt, 'mutation.createdAt'),
  }
  if (item.kind === 'unsupported') {
    return { ...common, kind: 'unsupported', reason: string(item.reason, 'mutation.reason') }
  }
  if (item.kind !== 'reversible') throw new Error('mutation.kind is invalid')
  return {
    ...common,
    kind: 'reversible',
    before: item.before === null ? null : objectReference(item.before, 'mutation.before'),
    after: objectReference(item.after, 'mutation.after'),
    bytes: integer(item.bytes, 'mutation.bytes'),
  }
}

function storedPoint(value: unknown, workspaceRoot: string): StoredPoint {
  const item = record(value, 'point')
  const pointRoot = string(item.workspaceRoot, 'point.workspaceRoot')
  if (pointRoot !== workspaceRoot) throw new Error('point belongs to a different workspace')
  return {
    id: string(item.id, 'point.id'),
    sessionId: string(item.sessionId, 'point.sessionId'),
    turn: integer(item.turn, 'point.turn'),
    workspaceRoot: pointRoot,
    input: promptInput(item.input),
    promptSeq: integer(item.promptSeq, 'point.promptSeq'),
    createdAt: integer(item.createdAt, 'point.createdAt'),
    ...optionalPreviousTurnEndSeq(item.previousTurnEndSeq),
    workspaceMutations: array(item.workspaceMutations, 'point.workspaceMutations').map(storedMutation),
    effects: array(item.effects, 'point.effects').map(effectReference),
  }
}

function participantManifest(value: unknown): StoredParticipantManifest {
  const item = record(value, 'participant')
  return {
    participantId: string(item.participantId, 'participant.participantId'),
    effects: array(item.effects, 'participant.effects').map((effect) => {
      const stored = record(effect, 'participant effect')
      return {
        effectId: string(stored.effectId, 'participant effect.effectId'),
        payload: objectReference(stored.payload, 'participant effect.payload'),
      }
    }),
  }
}

function effectKey(participantId: string, effectId: string): string {
  return `${participantId}\0${effectId}`
}

function validateManifestIntegrity(manifest: TimelineManifest): void {
  const pointIds = new Set<string>()
  const mutationIds = new Set<string>()
  const referencesByHash = new Map<string, number>()
  const referencedEffects = new Set<string>()
  for (const point of manifest.nodes) {
    if (pointIds.has(point.id)) throw new Error('rewind manifest contains a duplicate point')
    pointIds.add(point.id)
    const attachmentIds = new Set<string>()
    for (const attachment of point.input.attachments) {
      const id = String(attachment.attachmentId)
      if (attachmentIds.has(id)) throw new Error('rewind point contains a duplicate prompt attachment')
      attachmentIds.add(id)
    }
    if (point.previousTurnEndSeq !== undefined && point.previousTurnEndSeq >= point.promptSeq) {
      throw new Error('rewind point conversation boundary does not precede its Prompt')
    }
    for (const mutation of point.workspaceMutations) {
      if (mutationIds.has(mutation.id)) throw new Error('rewind manifest contains a duplicate workspace mutation')
      mutationIds.add(mutation.id)
      if (mutation.sourceSessionId !== point.sessionId || mutation.sourceTurn !== point.turn) {
        throw new Error('rewind workspace mutation attribution does not match its point')
      }
      if (mutation.kind === 'reversible') {
        const expectedBytes = (mutation.before?.bytes ?? 0) + mutation.after.bytes
        if (mutation.bytes !== expectedBytes) throw new Error('rewind workspace mutation byte count is invalid')
      }
    }
    for (const effect of point.effects) {
      if (effect.sourceSessionId !== point.sessionId || effect.sourceTurn !== point.turn) {
        throw new Error('rewind participant effect attribution does not match its point')
      }
      const key = effectKey(effect.participantId, effect.effectId)
      if (referencedEffects.has(key)) throw new Error('rewind manifest contains a duplicate participant effect')
      referencedEffects.add(key)
    }
  }

  const participantIds = new Set<string>()
  const payloadEffects = new Set<string>()
  for (const participant of manifest.participants) {
    if (participantIds.has(participant.participantId)) throw new Error('rewind manifest contains a duplicate participant')
    participantIds.add(participant.participantId)
    for (const effect of participant.effects) {
      const key = effectKey(participant.participantId, effect.effectId)
      if (payloadEffects.has(key)) throw new Error('rewind manifest contains a duplicate participant payload')
      payloadEffects.add(key)
    }
  }
  if (referencedEffects.size !== payloadEffects.size
    || [...referencedEffects].some(key => !payloadEffects.has(key))) {
    throw new Error('rewind participant references and payloads do not match')
  }

  for (const reference of references(manifest)) {
    const bytes = referencesByHash.get(reference.hash)
    if (bytes !== undefined && bytes !== reference.bytes) {
      throw new Error('rewind object reference has inconsistent byte counts')
    }
    referencesByHash.set(reference.hash, reference.bytes)
  }
}

function parseManifest(value: unknown, expectedRoot?: string): TimelineManifest {
  const item = record(value, 'rewind manifest')
  if (item.schema !== SCHEMA_VERSION) throw new Error(`unsupported Rewind manifest schema: ${String(item.schema)}`)
  const workspaceRoot = string(item.workspaceRoot, 'manifest.workspaceRoot')
  if (expectedRoot !== undefined && workspaceRoot !== expectedRoot) throw new Error('rewind manifest workspace root does not match its key')
  const workspaceId = string(item.workspaceId, 'manifest.workspaceId')
  if (workspaceId !== hash(workspaceRoot)) throw new Error('rewind manifest workspace identity is invalid')
  const nodes = array(item.nodes, 'manifest.nodes').map(node => storedPoint(node, workspaceRoot))
  const cursor = integer(item.cursor, 'manifest.cursor')
  if (cursor > nodes.length) throw new Error('rewind manifest cursor is outside its timeline')
  const manifest: TimelineManifest = {
    schema: SCHEMA_VERSION,
    workspaceId,
    workspaceRoot,
    lineageId: string(item.lineageId, 'manifest.lineageId'),
    ownerSessionId: string(item.ownerSessionId, 'manifest.ownerSessionId'),
    cursor,
    updatedAt: integer(item.updatedAt, 'manifest.updatedAt'),
    nodes,
    participants: array(item.participants, 'manifest.participants').map(participantManifest),
  }
  validateManifestIntegrity(manifest)
  return manifest
}

function references(manifest: TimelineManifest): ObjectReference[] {
  return [
    ...manifest.nodes.flatMap(point => point.workspaceMutations.flatMap((mutation) => {
      if (mutation.kind === 'unsupported') return []
      return [...mutation.before === null ? [] : [mutation.before], mutation.after]
    })),
    ...manifest.participants.flatMap(participant => participant.effects.map(effect => effect.payload)),
  ]
}

function uniqueReferences(manifest: TimelineManifest): Map<string, ObjectReference> {
  return new Map(references(manifest).map(reference => [reference.hash, reference]))
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function positiveLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`)
  return value
}

/** Versioned, content-addressed durable Rewind storage under the Harness home. */
export class FileRewindRepository implements RewindRepository {
  private readonly timelinesDirectory: string
  private readonly objectsDirectory: string
  private readonly corruptDirectory: string
  private readonly lockPath: string
  private readonly maxObjectBytes: number
  private readonly maxTimelineBytes: number
  private readonly maxGlobalBytes: number
  private closed = false

  constructor(
    private readonly root: string,
    private readonly options: FileRewindRepositoryOptions = {},
  ) {
    this.timelinesDirectory = join(root, 'timelines')
    this.objectsDirectory = join(root, 'objects')
    this.corruptDirectory = join(root, 'corrupt')
    this.lockPath = join(root, 'repository.lock')
    this.maxObjectBytes = positiveLimit(options.maxObjectBytes ?? 16 * 1024 * 1024, 'Rewind object byte limit')
    this.maxTimelineBytes = positiveLimit(options.maxTimelineBytes ?? 64 * 1024 * 1024, 'Rewind timeline byte limit')
    this.maxGlobalBytes = positiveLimit(options.maxGlobalBytes ?? 512 * 1024 * 1024, 'Rewind global byte limit')
    if (this.maxObjectBytes > this.maxTimelineBytes) {
      throw new Error('Rewind object byte limit cannot exceed the timeline byte limit')
    }
    if (this.maxTimelineBytes > this.maxGlobalBytes) {
      throw new Error('Rewind timeline byte limit cannot exceed the global byte limit')
    }
  }

  async load(workspaceRoot: string): Promise<RewindRepositoryEntry | undefined> {
    this.assertOpen()
    return this.withLock(async () => {
      const path = this.manifestPath(workspaceRoot)
      let source: string
      try {
        source = await this.readBounded(path, MAX_MANIFEST_BYTES)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
      try {
        const manifest = parseManifest(JSON.parse(source), workspaceRoot)
        return { value: await this.materialize(manifest), revision: hash(source) }
      } catch (error: unknown) {
        await this.quarantineLocked(path, error)
        return undefined
      }
    })
  }

  async save(value: StoredRewindTimeline, expectedRevision: string | null): Promise<string> {
    this.assertOpen()
    return this.withLock(async () => {
      await this.ensureDirectories()
      const path = this.manifestPath(value.timeline.workspaceRoot)
      const currentRevision = await this.currentRevision(path)
      if (currentRevision !== expectedRevision) throw new RewindRepositoryConflictError()
      const manifest = await this.store(value)
      const bytes = [...uniqueReferences(manifest).values()].reduce((total, reference) => total + reference.bytes, 0)
      if (bytes > this.maxTimelineBytes) {
        throw new Error(`durable Rewind timeline exceeds the ${String(this.maxTimelineBytes)} byte limit`)
      }
      const source = `${JSON.stringify(manifest, null, 2)}\n`
      if (Buffer.byteLength(source) > MAX_MANIFEST_BYTES) {
        throw new Error(`durable Rewind manifest exceeds the ${String(MAX_MANIFEST_BYTES)} byte limit`)
      }
      await this.writeAtomic(path, source)
      await this.compactLocked()
      return hash(source)
    })
  }

  async remove(workspaceRoot: string, expectedRevision: string | null): Promise<boolean> {
    this.assertOpen()
    return this.withLock(async () => {
      await this.ensureDirectories()
      const path = this.manifestPath(workspaceRoot)
      if (await this.currentRevision(path) !== expectedRevision) return false
      if (expectedRevision === null) return true
      await rm(path, { force: true })
      await this.compactLocked()
      return true
    })
  }

  async compact(): Promise<void> {
    this.assertOpen()
    await this.withLock(async () => {
      await this.ensureDirectories()
      await this.compactLocked()
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    await this.compact()
    this.closed = true
  }

  private async store(value: StoredRewindTimeline): Promise<TimelineManifest> {
    const nodes: StoredPoint[] = []
    for (const point of value.timeline.nodes) {
      const workspaceMutations: StoredWorkspaceMutation[] = []
      for (const mutation of point.workspaceMutations) {
        if (mutation.kind === 'unsupported') {
          workspaceMutations.push({ ...mutation })
          continue
        }
        workspaceMutations.push({
          ...mutation,
          before: mutation.before === null ? null : await this.writeObject(mutation.before),
          after: await this.writeObject(mutation.after),
        })
      }
      nodes.push({
        ...point,
        workspaceMutations,
        effects: point.effects.map(effect => ({ ...effect })),
      })
    }
    const participants: StoredParticipantManifest[] = []
    for (const participant of value.participants) {
      const effects: StoredParticipantEffect[] = []
      for (const effect of participant.effects) {
        if (!isJsonValue(effect.payload)) throw new Error(`Rewind participant "${participant.participantId}" returned a non-JSON payload`)
        effects.push({ effectId: effect.effectId, payload: await this.writeObject(JSON.stringify(effect.payload)) })
      }
      participants.push({ participantId: participant.participantId, effects })
    }
    return {
      schema: SCHEMA_VERSION,
      workspaceId: hash(value.timeline.workspaceRoot),
      workspaceRoot: value.timeline.workspaceRoot,
      lineageId: value.timeline.lineageId,
      ownerSessionId: value.timeline.ownerSessionId,
      cursor: value.timeline.cursor,
      updatedAt: value.timeline.updatedAt,
      nodes,
      participants,
    }
  }

  private async materialize(manifest: TimelineManifest): Promise<StoredRewindTimeline> {
    const cache = new Map<string, string>()
    const readObject = async (reference: ObjectReference): Promise<string> => {
      const cached = cache.get(reference.hash)
      if (cached !== undefined) return cached
      if (reference.bytes > this.maxObjectBytes) throw new Error('durable Rewind object exceeds its byte limit')
      const content = await this.readBounded(this.objectPath(reference.hash), this.maxObjectBytes)
      const bytes = Buffer.byteLength(content)
      if (bytes !== reference.bytes || hash(content) !== reference.hash) throw new Error('durable Rewind object failed integrity validation')
      cache.set(reference.hash, content)
      return content
    }
    const referenceBytes = [...uniqueReferences(manifest).values()].reduce((total, reference) => total + reference.bytes, 0)
    if (referenceBytes > this.maxTimelineBytes) throw new Error('durable Rewind timeline exceeds its byte limit')
    const nodes: RewindPointSnapshot[] = []
    for (const point of manifest.nodes) {
      const workspaceMutations: WorkspaceMutation[] = []
      for (const mutation of point.workspaceMutations) {
        if (mutation.kind === 'unsupported') {
          workspaceMutations.push({ ...mutation })
          continue
        }
        const before = mutation.before === null ? null : await readObject(mutation.before)
        const after = await readObject(mutation.after)
        if (Buffer.byteLength(before ?? '') + Buffer.byteLength(after) !== mutation.bytes) {
          throw new Error('durable Rewind mutation byte count is invalid')
        }
        workspaceMutations.push({ ...mutation, before, after })
      }
      nodes.push({ ...point, workspaceMutations, effects: point.effects.map(effect => ({ ...effect })) })
    }
    const participants: StoredRewindParticipant[] = []
    for (const participant of manifest.participants) {
      const effects: RewindEffectPayload[] = []
      for (const effect of participant.effects) {
        const payload: unknown = JSON.parse(await readObject(effect.payload))
        if (!isJsonValue(payload)) throw new Error('durable Rewind participant payload is not JSON')
        effects.push({ effectId: effect.effectId, payload })
      }
      participants.push({ participantId: participant.participantId, effects })
    }
    const timeline: RewindTimelineSnapshot = {
      lineageId: manifest.lineageId,
      workspaceRoot: manifest.workspaceRoot,
      ownerSessionId: manifest.ownerSessionId,
      cursor: manifest.cursor,
      updatedAt: manifest.updatedAt,
      nodes,
    }
    return { timeline, participants }
  }

  private async writeObject(content: string): Promise<ObjectReference> {
    const bytes = Buffer.byteLength(content)
    if (bytes > this.maxObjectBytes) throw new Error(`durable Rewind object exceeds the ${String(this.maxObjectBytes)} byte limit`)
    const objectHash = hash(content)
    const path = this.objectPath(objectHash)
    try {
      await access(path, constants.F_OK)
      return { hash: objectHash, bytes }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await this.writeAtomic(path, content)
    return { hash: objectHash, bytes }
  }

  private async compactLocked(): Promise<void> {
    const names = await readdir(this.timelinesDirectory).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    })
    const manifests: Array<{ readonly path: string; readonly manifest: TimelineManifest }> = []
    let invalidManifest = false
    for (const name of names.filter(candidate => candidate.endsWith('.json'))) {
      const path = join(this.timelinesDirectory, name)
      try {
        manifests.push({ path, manifest: parseManifest(JSON.parse(await this.readBounded(path, MAX_MANIFEST_BYTES))) })
      } catch {
        // A corrupt manifest is quarantined when its workspace is explicitly loaded.
        invalidManifest = true
      }
    }
    if (invalidManifest) return
    const counts = new Map<string, { reference: ObjectReference; count: number }>()
    for (const { manifest } of manifests) {
      for (const reference of uniqueReferences(manifest).values()) {
        const existing = counts.get(reference.hash)
        counts.set(reference.hash, { reference, count: (existing?.count ?? 0) + 1 })
      }
    }
    let total = [...counts.values()].reduce((sum, entry) => sum + entry.reference.bytes, 0)
    for (const item of manifests.sort((left, right) => left.manifest.updatedAt - right.manifest.updatedAt)) {
      if (total <= this.maxGlobalBytes) break
      await rm(item.path, { force: true })
      for (const reference of uniqueReferences(item.manifest).values()) {
        const entry = counts.get(reference.hash)
        if (entry === undefined) continue
        if (entry.count === 1) {
          counts.delete(reference.hash)
          total -= entry.reference.bytes
        } else {
          counts.set(reference.hash, { reference: entry.reference, count: entry.count - 1 })
        }
      }
    }
    const shards = await readdir(this.objectsDirectory).catch(() => [])
    for (const shard of shards) {
      const directory = join(this.objectsDirectory, shard)
      const objects = await readdir(directory).catch(() => [])
      for (const name of objects) {
        if (!HASH_PATTERN.test(name) || !counts.has(name)) await rm(join(directory, name), { force: true })
      }
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const token = randomUUID()
    const deadline = Date.now() + LOCK_WAIT_MS
    while (true) {
      let created = false
      try {
        const handle = await open(this.lockPath, 'wx', 0o600)
        created = true
        try {
          await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }), 'utf8')
        } finally {
          await handle.close()
        }
        break
      } catch (error: unknown) {
        if (created) await rm(this.lockPath, { force: true }).catch(() => {})
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        await this.removeStaleLock()
        if (Date.now() >= deadline) throw new Error('timed out waiting for the durable Rewind repository lock')
        await delay(25)
      }
    }
    try {
      return await operation()
    } finally {
      try {
        const lock = JSON.parse(await readFile(this.lockPath, 'utf8')) as { token?: unknown }
        if (lock.token === token) await rm(this.lockPath, { force: true })
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.options.onWarning?.(`Could not release Rewind storage lock: ${String(error)}`)
      }
    }
  }

  private async removeStaleLock(): Promise<void> {
    try {
      const info = await stat(this.lockPath)
      if (Date.now() - info.mtimeMs < LOCK_STALE_MS) return
      const value = JSON.parse(await readFile(this.lockPath, 'utf8')) as { pid?: unknown }
      if (typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && processExists(value.pid)) return
      await rm(this.lockPath, { force: true })
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.options.onWarning?.(`Could not inspect Rewind storage lock: ${String(error)}`)
    }
  }

  private async quarantineLocked(path: string, error: unknown): Promise<void> {
    await mkdir(this.corruptDirectory, { recursive: true, mode: 0o700 })
    const target = join(this.corruptDirectory, `${basename(path, '.json')}-${Date.now()}-${randomUUID()}.json`)
    try {
      await rename(path, target)
    } catch (renameError: unknown) {
      if ((renameError as NodeJS.ErrnoException).code !== 'ENOENT') throw renameError
    }
    this.options.onWarning?.(`Quarantined invalid Rewind history: ${String(error)}`)
  }

  private async ensureDirectories(): Promise<void> {
    await Promise.all([
      mkdir(this.timelinesDirectory, { recursive: true, mode: 0o700 }),
      mkdir(this.objectsDirectory, { recursive: true, mode: 0o700 }),
      mkdir(this.corruptDirectory, { recursive: true, mode: 0o700 }),
    ])
  }

  private manifestPath(workspaceRoot: string): string {
    return join(this.timelinesDirectory, `${hash(workspaceRoot)}.json`)
  }

  private objectPath(objectHash: string): string {
    return join(this.objectsDirectory, objectHash.slice(0, 2), objectHash)
  }

  private async readBounded(path: string, limit: number): Promise<string> {
    const info = await stat(path)
    if (!info.isFile() || info.size > limit) throw new Error(`Rewind storage entry exceeds the ${String(limit)} byte read limit`)
    const content = await readFile(path, 'utf8')
    if (Buffer.byteLength(content) > limit) throw new Error(`Rewind storage entry exceeds the ${String(limit)} byte read limit`)
    return content
  }

  private async currentRevision(path: string): Promise<string | null> {
    try {
      return hash(await this.readBounded(path, MAX_MANIFEST_BYTES))
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private async writeAtomic(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      try {
        await handle.writeFile(content, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('durable Rewind repository is closed')
  }
}
