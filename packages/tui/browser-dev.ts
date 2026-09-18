// Development-only browser entry, emitted as packages/tui/dist/browser.js.
// Cordis imports this module only when the effective plugin entry is enabled.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const require = createRequire(join(repositoryRoot, 'package.json'))
const pnpm = join(dirname(require.resolve('pnpm')), 'bin', 'pnpm.mjs')
const build = spawnSync(process.execPath, [pnpm, '--filter', '@vascent/deepseek-harness-browser', 'run', 'build'], {
  cwd: repositoryRoot,
  stdio: ['ignore', 2, 2],
})
if (build.error) throw build.error
if (build.status !== 0) throw new Error(`Browser development build failed (${build.signal ?? build.status}).`)

const browserEntry = new URL('../../browser/dist/index.js', import.meta.url)
const browser = await import(browserEntry.href)
export const { Config, BrowserService } = browser
export default browser.default
