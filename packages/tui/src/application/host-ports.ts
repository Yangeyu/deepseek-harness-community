import type { FileReferenceSource } from '../modules/composer/autocomplete.ts'
import type { SkillCatalogSource } from '../modules/skills/contracts.ts'
import type { GoalPort, GoalSessionSource } from '../modules/task/contracts.ts'
import type { SessionInteractionSource } from '../runtime/session/interactions.ts'
import type { SessionTransport } from '../runtime/session/transport.ts'

/** Consumer-owned Host capabilities required by the terminal application. */
export interface TuiHostPorts {
  readonly sessions: SessionTransport
  readonly interactions: SessionInteractionSource
  readonly fileReferences: FileReferenceSource
  readonly skills: SkillCatalogSource
  readonly goals: (session: GoalSessionSource) => GoalPort
}
