import type { SessionSummary, SkillEntry } from '../../runtime/session/contracts.ts'

export type SkillSessionId = SessionSummary['sessionId']

export interface SkillCatalogSource {
  list(sessionId: SkillSessionId, signal: AbortSignal): Promise<readonly SkillEntry[]>
}

export type SkillAuthoringScope = 'project' | 'user'

export interface SkillAuthoringTarget {
  scope: SkillAuthoringScope
  label: string
  root: string
}

export interface CreateLocalSkillRequest {
  target: SkillAuthoringTarget
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
}

export interface LocalSkillDocument {
  scope: SkillAuthoringScope
  root: string
  name: string
  path: string
}

export interface SkillValidationResult {
  ok: boolean
  errors: readonly string[]
}

export interface SkillAuthoringPort {
  targets(cwd: string): Promise<readonly SkillAuthoringTarget[]>
  create(request: CreateLocalSkillRequest): Promise<LocalSkillDocument>
  resolveEditable(cwd: string, name: string): Promise<LocalSkillDocument | undefined>
  validate(document: LocalSkillDocument): Promise<SkillValidationResult>
}

export interface LocalSkillEditorPort {
  open(document: LocalSkillDocument, created: boolean): Promise<void>
}
