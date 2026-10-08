import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import webConfig from '../web/vite.config.ts'

const demoRoot = fileURLToPath(new URL('./demo/', import.meta.url))

/**
 * The live demos on the website (spec 2026-10-08-landing-site-design § The
 * demos): small pages that run the app's real components from `web/src` on
 * demo data, each embedded by the Astro site in an iframe under `/demo/`.
 *
 * Only `web/`'s plugins are taken, so the components compile exactly as they
 * do in the app; its dev server and its `/api` proxy belong to the app, and a
 * demo never talks to a server. The output lands in the Astro site's
 * `public/`, which is why `npm run build` runs this first.
 */
export default defineConfig({
  plugins: webConfig.plugins,
  root: demoRoot,
  base: '/demo/',
  // `web/public` is the app's (favicons and the like); a demo has no files of
  // its own to publish.
  publicDir: false,
  build: {
    outDir: fileURLToPath(new URL('./public/demo/', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        map: `${demoRoot}map/index.html`,
        session: `${demoRoot}session/index.html`,
        phone: `${demoRoot}phone/index.html`,
      },
    },
  },
  server: {
    fs: {
      // The demos import `web/src` and `shared/` from outside their own root.
      allow: [fileURLToPath(new URL('../', import.meta.url))],
    },
  },
})
