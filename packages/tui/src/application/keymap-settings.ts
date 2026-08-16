import z from '@deepseek-ai/schemastery'
import {
  settingsNamespace,
  type SettingsScope,
} from '@deepseek-ai/dsh-settings'
import { KEYMAP_PRESET_IDS, type KeymapPreset } from '../input/keymap.ts'

export interface TuiSettings {
  keymap: KeymapPreset
}

export const TUI_SETTINGS_NAMESPACE = settingsNamespace('community-tui')

export const TuiSettingsSchema: z<TuiSettings> = z.object({
  keymap: z.union(KEYMAP_PRESET_IDS).default('standard'),
})

/** Narrow application boundary over Host-owned, durable TUI settings. */
export interface KeymapSettingsGateway {
  current(): TuiSettings
  setPreset(preset: KeymapPreset): Promise<void>
  subscribe(listener: (settings: TuiSettings) => void): () => void
}

export function settingsKeymapGateway(scope: SettingsScope<TuiSettings>): KeymapSettingsGateway {
  return {
    current: () => scope.get(),
    setPreset: preset => scope.update({ keymap: preset }),
    subscribe: listener => scope.watch(next => listener(next)),
  }
}

export function memoryKeymapGateway(initial: TuiSettings): KeymapSettingsGateway {
  let current = initial
  const listeners = new Set<(settings: TuiSettings) => void>()
  return {
    current: () => current,
    setPreset: async (keymap) => {
      if (keymap === current.keymap) return
      current = { keymap }
      for (const listener of listeners) listener(current)
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
