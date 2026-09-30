import type { SettingsForms } from '@deepseek-ai/dsh-settings'
import type { PermissionPresetService } from '@deepseek-ai/dsh-permission-presets'
import type { PermissionDefaultPort } from '../../modules/configuration/contracts.ts'

/** Save configured presets; process contributions such as auto only apply to this Session. */
export function settingsPermissionDefaultGateway(
  settings: Pick<SettingsForms, 'update'>,
  permissions: Pick<PermissionPresetService, 'catalog'>,
): PermissionDefaultPort {
  return {
    async setDefaultPreset(preset) {
      if (!permissions.catalog().defaultOptions.some(option => option.value === preset)) return
      await settings.update('permission', { defaultPreset: preset })
    },
  }
}
