import { basename } from 'node:path'
import {
  truncateToWidth,
  visibleWidth,
  type Component,
} from '@earendil-works/pi-tui'
import { sanitizeTerminalText } from '../text.ts'
import type { TuiTheme } from './theme.ts'

export interface ComposerFooterSnapshot {
  model: string
  cwd: string
  branch?: string
  task: string
  stats: string
}

function clip(value: string, width: number): string {
  return width <= 0 ? '' : truncateToWidth(value, width, '…')
}

function directoryName(cwd: string): string {
  const name = basename(cwd)
  return sanitizeTerminalText(name === '' ? cwd : name)
}

function workspaceLabel(cwd: string, branch: string | undefined, width: number): string {
  const directory = directoryName(cwd)
  if (branch === undefined) return clip(directory, width)
  const safeBranch = sanitizeTerminalText(branch)
  const suffix = ` · ${safeBranch}`
  const suffixWidth = visibleWidth(suffix)
  if (suffixWidth >= width) return clip(safeBranch, width)
  return `${clip(directory, width - suffixWidth)}${suffix}`
}

/**
 * Keep model, directory, and branch on one stable row with the durable task
 * summary appended. When narrow, workspace context wins over the task
 * summary, and the model identity is preserved for as long as any fits.
 */
export function footerIdentity(
  model: string,
  cwd: string,
  branch: string | undefined,
  task: string,
  width: number,
): string {
  const safeWidth = Math.max(0, width)
  const safeModel = sanitizeTerminalText(model)
  const naturalWorkspace = workspaceLabel(cwd, branch, Number.MAX_SAFE_INTEGER)
  const taskSuffix = task === '' ? '' : ` · ${sanitizeTerminalText(task)}`
  const separator = ' │ '
  const natural = `${safeModel}${separator}${naturalWorkspace}${taskSuffix}`
  if (visibleWidth(natural) <= safeWidth) return natural
  if (safeWidth < 16) return clip(natural, safeWidth)

  const separatorWidth = visibleWidth(separator)
  const branchWidth = branch === undefined ? 0 : visibleWidth(sanitizeTerminalText(branch))
  const maxWorkspaceWidth = safeWidth - separatorWidth - 8
  const workspaceWidth = Math.min(
    visibleWidth(naturalWorkspace),
    maxWorkspaceWidth,
    Math.max(8, branchWidth, Math.floor(safeWidth * 0.45)),
  )
  const modelWidth = safeWidth - separatorWidth - workspaceWidth
  if (modelWidth < 8) return clip(natural, safeWidth)
  const identity = `${clip(safeModel, modelWidth)}${separator}${workspaceLabel(cwd, branch, workspaceWidth)}`
  if (taskSuffix === '') return identity
  const taskWidth = safeWidth - visibleWidth(identity)
  return taskWidth <= 0 ? identity : `${identity}${clip(taskSuffix, taskWidth)}`
}

/** Fixed-height Composer footer with persistent model, workspace, and task identity. */
export class ComposerFooter implements Component {
  private snapshot: ComposerFooterSnapshot = {
    model: 'model unavailable',
    cwd: '',
    task: '',
    stats: '',
  }

  constructor(private readonly theme: TuiTheme) {}

  setSnapshot(snapshot: ComposerFooterSnapshot): void {
    this.snapshot = snapshot
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(0, width)
    return [
      footerIdentity(
        this.snapshot.model,
        this.snapshot.cwd,
        this.snapshot.branch,
        this.snapshot.task,
        safeWidth,
      ),
      ...(this.snapshot.stats === ''
        ? []
        : [this.theme.secondary(clip(sanitizeTerminalText(this.snapshot.stats), safeWidth))]),
    ]
  }
}