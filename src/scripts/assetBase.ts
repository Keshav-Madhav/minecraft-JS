// Resolve a public/ asset path against vite's BASE_URL instead of the PAGE URL.
//
// The asset tables use bare-relative paths ('textures/dirt.png'), which resolve
// against wherever the page happens to be open. That breaks the moment the page
// is at any non-root path — e.g. a stale http://localhost:5173/minecraft-JS/
// bookmark on the dev server: every texture 404s (→ the magenta fallback fills
// the whole world purple) and the .glb fetch gets the SPA index.html fallback.
//
// BASE_URL is '/' in dev (root-absolute → page-path-independent) and './' in
// the production build (relative to index.html — which is exactly what lets the
// same dist/ work at a domain root AND a sub-path, per vite.config base './').
//
// (import.meta.env needs src/vite-env.d.ts referencing vite/client for tsc —
// it was dropped once before for that error; the d.ts is the right fix.)
export const assetUrl = (path: string) => import.meta.env.BASE_URL + path;
