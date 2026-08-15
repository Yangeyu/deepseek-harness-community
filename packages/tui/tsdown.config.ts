import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/memory.ts'],
  outDir: 'lib',
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
      '@deepseek-ai/dsh-host-apiproxy',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-session-projection',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-token-meter',
      '@deepseek-ai/dsh-tools',
      '@earendil-works/pi-tui',
    ],
  },
})
