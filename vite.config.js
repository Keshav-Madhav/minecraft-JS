import { defineConfig } from 'vite'

/**
 * @type {import('vite').UserConfig}
 */
export default defineConfig({
  // Relative base ('./') makes the built asset URLs relative, so the same `dist/`
  // works whether it's served from a DOMAIN ROOT (Vercel / Netlify free hosting)
  // or a sub-path (GitHub Pages project site, /minecraft-JS/). Was hardcoded to
  // '/minecraft-JS/', which 404'd every asset when served at the root.
  base: './',
  build: {
    sourcemap: true,
    outDir: 'dist'
  }
})