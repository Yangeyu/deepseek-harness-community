import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/memory.ts', 'src/vision.ts'],
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
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-attachment',
      '@deepseek-ai/dsh-credentials',
      '@deepseek-ai/dsh-host-apiproxy',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-session-projection',
      '@deepseek-ai/dsh-settings',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-token-meter',
      '@deepseek-ai/dsh-tools',
      '@earendil-works/pi-tui',
    ],
  },
})
