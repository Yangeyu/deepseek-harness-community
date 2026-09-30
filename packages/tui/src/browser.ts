import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import { mountSessionMcp } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'

export const name = 'community-browser'
export const inject = ['agents', 'tools', 'systemPrompt']

/** Connect daily Chrome; the official runtime owns Session isolation and cleanup. */
export function apply(ctx: Context): void {
  ctx.plugin(BrowserUse)
  ctx.plugin({ name: 'chrome-devtools', inject: ['browserUse'], apply: mountBrowser })
}

function mountBrowser(ctx: Context): void {
  mountSessionMcp(ctx, {
    name: 'chrome-devtools-mcp',
    exclusive: true,
    command: process.execPath,
    args: [
      fileURLToPath(import.meta.resolve('chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js')),
      '--autoConnect',
      '--no-usage-statistics',
      '--no-performance-crux',
    ],
  })
}
