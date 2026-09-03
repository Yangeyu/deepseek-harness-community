import type { RuntimeSessionSnapshot } from '../runtime/session/snapshot.ts'
import type { TerminalCommandDefinition } from '../runtime/commands.ts'

export interface LocalCommandActions {
  helpText(): string
  notice(message: string): void
  currentSession(): Readonly<RuntimeSessionSnapshot>
  clear(): Promise<void>
  create(): Promise<void>
  resume(argument?: string): Promise<void>
  selectModel(argument?: string): Promise<void>
  attach(path: string): Promise<void>
  pasteImage(): Promise<void>
  toggleDetails(): void
  openSkills(): void
  openConfiguration(route: string): void | Promise<void>
  openTask(): void
  openTrajectory(): void
  openMemory(): Promise<void>
  openRewind(): void
  exit(): Promise<void>
}

/** Static local command catalog; every handler delegates to one owning feature. */
export function createLocalCommands(actions: LocalCommandActions): TerminalCommandDefinition[] {
  return [{
    name: 'help',
    description: 'Show terminal and Harness commands',
    handler: () => { actions.notice(actions.helpText()) },
  }, {
    name: 'clear',
    description: 'Clear the conversation and start a new session',
    handler: () => actions.clear(),
  }, {
    name: 'new',
    description: 'Create a new session',
    handler: () => actions.create(),
  }, {
    name: 'resume',
    description: 'Switch to another session',
    argumentHint: '[session-id]',
    handler: argument => actions.resume(argument === '' ? undefined : argument),
  }, {
    name: 'model',
    description: 'Select model and provider',
    argumentHint: '[provider/model]',
    handler: argument => actions.selectModel(argument === '' ? undefined : argument),
  }, {
    name: 'attach',
    description: 'Attach an image file to the next message',
    argumentHint: '<path>',
    handler: async (argument) => {
      if (argument.trim() === '') throw new Error('Usage: /attach <path>')
      await actions.attach(argument.trim())
    },
  }, {
    name: 'paste-image',
    description: 'Attach the image currently on the clipboard',
    handler: () => actions.pasteImage(),
  }, {
    name: 'details',
    description: 'Toggle all Activity details',
    handler: () => { actions.toggleDetails() },
  }, {
    name: 'skills',
    description: 'Browse and author reusable Skills',
    handler: () => { actions.openSkills() },
  }, {
    name: 'config',
    description: 'Configure model, policy, and terminal preferences',
    argumentHint: '[model|reasoning|permission|plan|vision|web|interface]',
    handler: route => actions.openConfiguration(route),
  }, {
    name: 'vision',
    description: 'Configure image routing and the Vision proxy',
    handler: () => actions.openConfiguration('vision'),
  }, {
    name: 'web',
    description: 'Inspect Web search and page-reading providers',
    handler: () => actions.openConfiguration('web'),
  }, {
    name: 'task',
    description: 'Inspect and control the current task',
    handler: () => { actions.openTask() },
  }, {
    name: 'trajectory',
    aliases: ['trace'],
    description: 'Inspect the session execution chain',
    handler: () => { actions.openTrajectory() },
  }, {
    name: 'status',
    description: 'Show current session status',
    handler: () => {
      const state = actions.currentSession()
      actions.notice([
        `Session: ${state.sessionId === undefined ? 'none' : String(state.sessionId)}`,
        `Directory: ${state.cwd}`,
        `State: ${state.runState}`,
        `Event stream: ${state.connection.events}`,
        `Control stream: ${state.connection.control}`,
        `Queued: ${state.queue.length}`,
      ].join('\n'))
    },
  }, {
    name: 'memories',
    aliases: ['memory'],
    description: 'Manage project memory and session learning',
    handler: () => actions.openMemory(),
  }, {
    name: 'rewind',
    description: 'Open source-attributed Rewind history',
    handler: () => { actions.openRewind() },
  }, {
    name: 'exit',
    aliases: ['quit'],
    description: 'Exit the terminal client',
    handler: () => actions.exit(),
  }]
}
