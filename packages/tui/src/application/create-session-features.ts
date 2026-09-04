import type {
  AutocompleteItem,
  SlashCommand,
  Terminal,
  TUI,
} from '@earendil-works/pi-tui'
import type { TuiRuntime } from './contracts.ts'
import type { BoundSession, SessionFeatureSet } from './session-features.ts'
import { NodeTextFileReader } from '../infrastructure/filesystem/text-file-reader.ts'
import { LocalSkillAuthoring } from '../infrastructure/filesystem/local-skill-authoring.ts'
import { InlineReferenceEditor } from '../infrastructure/terminal/inline-reference-editor.ts'
import { TerminalSkillDocumentEditor } from '../infrastructure/terminal/skill-document-editor.ts'
import type { ClipboardImageLoader } from '../modules/composer/attachments/clipboard.ts'
import type { VisionGateway } from '../modules/composer/attachments/coordinator.ts'
import type { FileReferenceSource } from '../modules/composer/autocomplete.ts'
import { ComposerHost } from '../modules/composer/host.ts'
import { ComposerProcess } from '../modules/composer/process.ts'
import { composerDraftForSession } from '../modules/composer/session-draft.ts'
import { InteractionProcess } from '../modules/interaction/process.ts'
import { SkillsProcess } from '../modules/skills/process.ts'
import type { SkillCatalogSource } from '../modules/skills/contracts.ts'
import type { GoalPort, GoalSessionSource } from '../modules/task/contracts.ts'
import { TaskProcess } from '../modules/task/process.ts'
import { TrajectoryProcess } from '../modules/trajectory/process.ts'
import { TranscriptHost } from '../modules/transcript/host.ts'
import { TranscriptProcess } from '../modules/transcript/process.ts'
import type { TuiTheme } from '../presentation/primitives/theme.ts'
import type { SurfaceHost } from '../presentation/shell/surfaces/surface-host.ts'
import type { TerminalCommandDirectory } from '../runtime/commands.ts'
import type { LifecycleScope } from '../runtime/lifecycle/scope.ts'
import type { SessionManager } from '../runtime/session/manager.ts'

export interface SessionFeatureSetOptions {
  readonly skills: SkillCatalogSource
  readonly goals: (session: GoalSessionSource) => GoalPort
  readonly runtime: TuiRuntime
  readonly terminal: Terminal
  readonly tui: TUI
  readonly theme: TuiTheme
  readonly commands: TerminalCommandDirectory
  readonly composer: ComposerHost
  readonly transcript: TranscriptHost
  readonly surfaces: SurfaceHost
  readonly fileReferences: FileReferenceSource
  readonly clipboardImage: ClipboardImageLoader
  readonly showReasoning: boolean
  readonly maxToolOutputLines: number
  readonly thinkingMaxLines: number
  readonly vision?: VisionGateway
  readonly dispatchCommand: (text: string) => Promise<boolean>
  readonly autocompleteItems: () => readonly (AutocompleteItem | SlashCommand)[]
  readonly followTranscript: () => void
  readonly openRewind: () => void
  readonly onInteractionChange: () => void
  readonly invalidate: () => void
}

/** Construct all modules whose mutable state belongs to one Session epoch. */
export function createSessionFeatureSet(
  options: SessionFeatureSetOptions,
  scope: LifecycleScope,
  session: SessionManager | BoundSession,
  identity?: SessionFeatureSet['identity'],
  previous?: SessionFeatureSet,
): SessionFeatureSet {
  const composerScope = scope.fork('composer')
  const transcriptScope = scope.fork('transcript')
  const trajectoryScope = scope.fork('trajectory')
  const taskScope = scope.fork('task')
  const skillsScope = scope.fork('skills')
  const interactionScope = scope.fork('interaction')

  const composer = new ComposerProcess({
    focus: options.composer.focusPort(component => { options.tui.setFocus(component) }),
    theme: options.theme,
    session,
    commands: {
      dispatch: options.dispatchCommand,
      autocompleteItems: options.autocompleteItems,
    },
    fileReferences: options.fileReferences,
    clipboardImage: options.clipboardImage,
    createEditor: references => new InlineReferenceEditor(
      options.tui,
      options.theme.editor,
      references,
      options.theme.imageReference,
      { paddingX: 1, autocompleteMaxVisible: 10 },
    ),
    ...options.vision === undefined ? {} : { vision: options.vision },
    followTranscript: options.followTranscript,
    openRewind: options.openRewind,
    scope: composerScope,
  })
  const transcript = new TranscriptProcess({
    session,
    files: new NodeTextFileReader(),
    theme: options.theme,
    showReasoning: options.showReasoning,
    maxToolOutputLines: options.maxToolOutputLines,
    thinkingMaxLines: options.thinkingMaxLines,
    invalidate: () => {
      options.transcript.touch()
      options.invalidate()
    },
    scope: transcriptScope,
  })
  const trajectory = new TrajectoryProcess({
    session,
    surfaces: options.surfaces,
    visibleRows: () => options.terminal.rows,
    theme: options.theme,
    invalidate: options.invalidate,
    scope: trajectoryScope,
  })
  const task = new TaskProcess({
    session,
    goals: options.goals(session),
    surfaces: options.surfaces,
    tui: options.tui,
    theme: options.theme,
    visibleRows: () => options.terminal.rows,
    invalidate: options.invalidate,
    scope: taskScope,
  })
  const skills = new SkillsProcess({
    session,
    source: options.skills,
    authoring: new LocalSkillAuthoring(),
    editor: new TerminalSkillDocumentEditor(
      session,
      options.tui,
      options.terminal,
      options.runtime,
      skillsScope,
      options.invalidate,
    ),
    commands: options.commands,
    composer: {
      setText: text => { options.composer.editor.setText(text) },
      refreshAutocomplete: () => { options.composer.refreshAutocomplete() },
    },
    surfaces: options.surfaces,
    tui: options.tui,
    theme: options.theme,
    visibleRows: () => options.terminal.rows,
    invalidate: options.invalidate,
    scope: skillsScope,
  })
  const interaction = new InteractionProcess(
    session,
    { open: component => options.surfaces.open({ placement: 'readable', component }) },
    options.tui,
    options.theme,
    () => options.terminal.rows,
    options.onInteractionChange,
    interactionScope,
  )

  composer.start()
  const previousDraft = previous?.composer.draft
  if (previousDraft !== undefined) {
    const transferred = composerDraftForSession(previousDraft, previous?.identity === undefined)
    if (transferred.text !== '' || transferred.attachments.length > 0) {
      composer.restoreDraft(transferred)
    }
  }

  return {
    scope,
    composer,
    interaction,
    skills,
    task,
    trajectory,
    transcript,
    ...identity === undefined ? {} : { identity },
  }
}
