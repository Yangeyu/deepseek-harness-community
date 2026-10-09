import { parse } from 'yaml'
import { defineConfig } from 'tsdown'
import { cp, copyFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export default defineConfig({
  entry: {
    index: 'src/index.ts', bailian: 'src/bailian.ts', memory: 'src/memory.ts',
    'browser-mcp': 'src/infrastructure/browser/mcp-entry.ts',
    'browser-native-host': 'src/infrastructure/browser/native-host.ts',
    vision: 'src/vision.ts', web: 'src/web.ts', browser: 'src/browser.ts', computer: 'src/computer.ts',
  },
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: true,
  clean: true,
  fixedExtension: false,
  hooks: {
    async 'build:done'({ options }) {
      await cp(new URL('../../extensions/browser', import.meta.url), join(options.outDir, 'browser-extension'), { recursive: true })
      const source = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
      const root = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
      const workspace = parse(await readFile(new URL('../../pnpm-workspace.yaml', import.meta.url), 'utf8'))
      const exports = Object.fromEntries(Object.entries(source.exports).map(([key, value]) => [
        key, Object.fromEntries(Object.entries(value as Record<string, string>).map(([condition, path]) => [condition, path.replace('./dist/', './')])),
      ]))
      await copyFile(new URL('./cordis.patch.yml', import.meta.url), join(options.outDir, 'cordis.patch.yml'))
      await writeFile(join(options.outDir, 'package.json'), JSON.stringify({
        name: source.name, version: root.version, private: true, type: 'module',
        main: './index.js', exports,
        dsh: source.dsh,
        peerDependencies: { '@deepseek-ai/dsh': workspace.catalogs.dsh['@deepseek-ai/dsh'] },
      }, null, 2) + '\n')
    },
  },
  deps: {
    onlyBundle: false,
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-experimental-browser-use-runtime',
      '@deepseek-ai/dsh-browser-use',
      '@deepseek-ai/dsh-computer-use',
      '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native',
      '@playwright/mcp', 'playwright', '@modelcontextprotocol/sdk',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-api-session-controller',
      '@deepseek-ai/dsh-attachment',
      '@deepseek-ai/dsh-credentials',
      '@deepseek-ai/dsh-file-reference',
      '@deepseek-ai/dsh-launch-environment',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-permission-presets',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-session-projection',
      '@deepseek-ai/dsh-settings',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-token-meter',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-web',
      '@deepseek-ai/dsh-web-search-deepseek',
      '@earendil-works/pi-tui',
    ],
  },
})
