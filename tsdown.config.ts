import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/launcher.ts'],
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: false,
  sourcemap: true,
  clean: true,
  fixedExtension: false,
})
