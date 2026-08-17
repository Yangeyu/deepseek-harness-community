import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { describe, expect, it, vi } from 'vitest'
import { PERMISSION_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-permission-presets'
import { settingsPermissionDefaultGateway } from '../../src/application/permission-defaults.ts'

describe('permission default gateway', () => {
  it('writes the official default for newly created sessions', async () => {
    const update = vi.fn(async () => {})
    const gateway = settingsPermissionDefaultGateway({ update } as Pick<SettingsProvider, 'update'>)

    await gateway.setDefaultPreset('workspace-write')

    expect(update).toHaveBeenCalledWith(
      PERMISSION_SETTINGS_NAMESPACE,
      { defaultPreset: 'workspace-write' },
    )
  })
})
