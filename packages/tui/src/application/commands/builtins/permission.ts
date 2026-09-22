import type { TerminalCommandDecoration } from '../contracts.ts'
import type { PermissionDefaultPort } from '../../../modules/configuration/contracts.ts'

/** Bare invocation opens the UI; arguments remain Host-owned and persist only after success. */
export function createPermissionDecoration(
  configuration: { openPermission(): void },
  permissionDefault?: PermissionDefaultPort,
): TerminalCommandDecoration {
  return {
    name: 'permission',
    onBare: () => configuration.openPermission(),
    ...permissionDefault === undefined ? {} : {
      async afterHostSuccess(preset: string) {
        try {
          await permissionDefault.setDefaultPreset(preset)
        } catch (error: unknown) {
          const reason = error instanceof Error ? error.message : String(error)
          throw new Error(`Permission changed for this session, but its default could not be saved: ${reason}`)
        }
      },
    },
  }
}
