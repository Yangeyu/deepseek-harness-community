import { defineConfig } from 'tsdown'
import { cp } from 'node:fs/promises'
import { join } from 'node:path'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: true,
  clean: true,
  fixedExtension: false,
  hooks: {
    async 'build:done'({ options }) {
      await cp(new URL('./python', import.meta.url), join(options.outDir, 'python'), {
        recursive: true,
        filter: source => !source.includes('__pycache__') && !source.endsWith('.pyc'),
      })
    },
  },
  deps: {
    onlyBundle: false,
    neverBundle: [
      '@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-settings', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-attachment', '@deepseek-ai/dsh-user-approval',
    ],
  },
})
