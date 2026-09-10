import { defineConfig } from 'tsdown'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export default defineConfig({
  entry: ['src/index.ts', 'src/bailian.ts', 'src/memory.ts', 'src/vision.ts', 'src/web.ts'],
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: true,
  clean: true,
  fixedExtension: false,
  hooks: {
    async 'build:done'({ options }) {
      const source = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
      const root = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
      const exports = Object.fromEntries(Object.entries(source.exports).map(([key, value]) => [
        key, Object.fromEntries(Object.entries(value as Record<string, string>).map(([condition, path]) => [condition, path.replace('./dist/', './')])),
      ]))
      await copyFile(new URL('./cordis.patch.yml', import.meta.url), join(options.outDir, 'cordis.patch.yml'))
      await writeFile(join(options.outDir, 'package.json'), JSON.stringify({
        name: source.name, version: root.version, private: true, type: 'module',
        main: './index.js', exports,
        dsh: source.dsh,
      }, null, 2) + '\n')
    },
  },
  deps: {
    onlyBundle: false,
    neverBundle: [
      '@deepseek-ai/cordis',
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
