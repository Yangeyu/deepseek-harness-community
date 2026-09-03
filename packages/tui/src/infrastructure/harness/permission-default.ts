import {
  PERMISSION_SETTINGS_NAMESPACE,
  type PermissionSettings,
} from '@deepseek-ai/dsh-permission-presets'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { PermissionDefaultPort } from '../../modules/configuration/contracts.ts'

/** Write through the official Permission Settings namespace. */
export function settingsPermissionDefaultGateway(
  settings: Pick<SettingsProvider, 'update'>,
): PermissionDefaultPort {
  return {
    setDefaultPreset: preset => settings.update(
      PERMISSION_SETTINGS_NAMESPACE,
      { defaultPreset: preset } satisfies PermissionSettings,
    ),
  }
}
