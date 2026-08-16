/** Application-level configuration materialized before runtime construction. */
import z from '@deepseek-ai/schemastery'
import { KEYMAP_PRESET_IDS, type KeymapPreset } from '../input/keymap.ts'

/** User-configurable TUI presentation and history bounds. */
export interface Config {
  historyMessages?: number
  rewindHistory?: number
  maxToolOutputLines?: number
  thinkingMaxLines?: number
  showReasoning?: boolean
  showHardwareCursor?: boolean
  color?: boolean
  keymap?: KeymapPreset
  title?: string
  cwd?: string
  sessionId?: string
}

/** Loader schema for the public plugin configuration. */
export const Config: z<Config> = z.object({
  historyMessages: z.natural().min(10).max(2000).default(200),
  rewindHistory: z.natural().min(2).max(100).default(20),
  maxToolOutputLines: z.natural().min(2).max(200).default(12),
  thinkingMaxLines: z.natural().min(3).max(30).default(8),
  showReasoning: z.boolean().default(true),
  showHardwareCursor: z.boolean().default(false),
  color: z.boolean().default(true),
  keymap: z.union(KEYMAP_PRESET_IDS).default('standard'),
  title: z.string().default('DeepSeek Harness'),
  cwd: z.string(),
  sessionId: z.string(),
})

/** Fully materialized settings consumed by the application. */
export interface ResolvedConfig {
  historyMessages: number
  rewindHistory: number
  maxToolOutputLines: number
  thinkingMaxLines: number
  showReasoning: boolean
  showHardwareCursor: boolean
  color: boolean
  keymap: KeymapPreset
  title: string
  cwd: string
  sessionId?: string
}

/** Resolve optional loader fields once at application startup. */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    historyMessages: config.historyMessages ?? 200,
    rewindHistory: config.rewindHistory ?? 20,
    maxToolOutputLines: config.maxToolOutputLines ?? 12,
    thinkingMaxLines: config.thinkingMaxLines ?? 8,
    showReasoning: config.showReasoning ?? true,
    showHardwareCursor: config.showHardwareCursor ?? false,
    color: config.color ?? true,
    keymap: config.keymap ?? 'standard',
    title: config.title ?? 'DeepSeek Harness',
    cwd: config.cwd ?? process.cwd(),
    ...config.sessionId === undefined ? {} : { sessionId: config.sessionId },
  }
}
