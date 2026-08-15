#!/usr/bin/env node

process.env.DSH_TUI_PROFILE = 'tui-dev'

const { main } = await import('../src/launcher.js')

process.exitCode = await main(process.argv.slice(2))
