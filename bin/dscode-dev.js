#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.DSH_TUI_PROFILE = 'tui-dev'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const pnpm = join(dirname(require.resolve('pnpm')), 'bin', 'pnpm.mjs')
for (const args of [
  ['--filter', '@vascent/deepseek-harness-tui...', '--filter', '!@vascent/deepseek-harness-browser', 'run', 'build'],
  ['exec', 'tsdown'],
]) {
  const build = spawnSync(process.execPath, [pnpm, ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, DSH_TUI_DEV_BUILD: '1' },
    stdio: 'inherit',
  })
  if (build.error) throw build.error
  if (build.status !== 0) process.exit(build.status ?? 1)
}

const { main } = await import('../dist/launcher.js')

process.exitCode = await main(process.argv.slice(2))
