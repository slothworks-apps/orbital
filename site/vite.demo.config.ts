import { readFileSync } from 'node:fs'
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
/** The phone shell's version, which the phone screens print as `vite.mobile.config.ts` has them do. */
const mobileVersion = (
  JSON.parse(readFileSync(new URL('../mobile/package.json', import.meta.url), 'utf8')) as { version: string }
).version

export default defineConfig({
  plugins: webConfig.plugins,
  // The phone demo runs `web/src/mobile`, which reads the globals the phone's
  // build defines (`web/src/mobile/env.d.ts`). A demo is no dev build and
  // never registers for push.
  define: {
    __MOBILE_DEV__: 'false',
    __MOBILE_VERSION__: JSON.stringify(mobileVersion),
    __MOBILE_PUSH__: JSON.stringify({ android: false, ios: false }),
  },
  resolve: {
    // As in `vite.mobile.config.ts`: the push plugin's web half imports the
    // Firebase web SDK, which nothing installs and nothing here calls.
    alias: {
      'firebase/messaging': fileURLToPath(new URL('../web/src/mobile/platform/firebaseWebStub.ts', import.meta.url)),
    },
  },
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
