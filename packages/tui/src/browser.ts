import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import { mountSessionMcp } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import { mountBrowserTasks } from './infrastructure/browser/task.ts'

export const name = 'community-browser'
export const inject = ['agents', 'tools', 'systemPrompt']

/** Each Session owns its MCP client; each task releases its extension attachment. */
export async function apply(ctx: Context): Promise<void> {
  await ctx.plugin(BrowserUse)
  await ctx.plugin({ name: 'playwright', inject: ['browserUse'], apply: mountBrowser })
}

async function mountBrowser(ctx: Context): Promise<void> {
  mountSessionMcp(ctx, {
    name: 'playwright',
    exclusive: false,
    command: process.execPath,
    args: [
      fileURLToPath(new URL('./browser-mcp.js', import.meta.url)),
    ],
  })
  mountBrowserTasks(ctx)
}
