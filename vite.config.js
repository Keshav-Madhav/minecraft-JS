import { defineConfig } from 'vite'

/**
 * @type {import('vite').UserConfig}
 */
export default defineConfig({
  base: '/minecraft-JS/',
  build: {
    sourcemap: true,
    outDir: 'dist'
  }
})