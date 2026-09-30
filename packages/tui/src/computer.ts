import type { Context } from '@deepseek-ai/cordis'
import ComputerUse from '@deepseek-ai/dsh-computer-use'
import * as CuaDriver from '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native'

export const name = 'community-computer'

/** Compose the official registry and native driver in the enabled capability's scope. */
export function apply(ctx: Context): void {
  ctx.plugin(ComputerUse)
  ctx.plugin(CuaDriver)
}
