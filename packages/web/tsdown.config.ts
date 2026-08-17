import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: true,
  clean: true,
  fixedExtension: false,
  deps: {
    onlyBundle: false,
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-credentials',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-settings',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-web',
    ],
  },
})
