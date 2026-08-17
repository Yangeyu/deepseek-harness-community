import {
  PERMISSION_SETTINGS_NAMESPACE,
  type PermissionSettings,
} from '@deepseek-ai/dsh-permission-presets'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'

/** Durable default applied by the Host when it creates a new session. */
export interface PermissionDefaultGateway {
  setDefaultPreset(preset: string): Promise<void>
}

/** Write through the official Permission Settings namespace. */
export function settingsPermissionDefaultGateway(
  settings: Pick<SettingsProvider, 'update'>,
): PermissionDefaultGateway {
  return {
    setDefaultPreset: preset => settings.update(
      PERMISSION_SETTINGS_NAMESPACE,
      { defaultPreset: preset } satisfies PermissionSettings,
    ),
  }
}
