import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * The phone's build (spec 2026-10-02-mobile-app-design § 1): its own HTML
 * entry, written out as the `index.html` Capacitor loads; no dev proxy,
 * since the phone never talks to a local server; and every chunk's module
 * list beside the manifest, for the bundle guard (`src/mobile/bundleGuard.ts`).
 */
/** `orbital mobile <version>` in 9f's footer and the `hello` app string: the shell's version. */
const mobileVersion = (
  JSON.parse(readFileSync(new URL('../mobile/package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version

/**
 * Whether each native project carries its Firebase config, git-ignored and
 * the owner's: Android's `google-services.json`, iOS's
 * `GoogleService-Info.plist` (runbooks build-the-android-app and
 * build-the-ios-app, "Push"). One web build serves both projects, so the
 * phone looks up its own platform; without the file it must not ask Firebase
 * for a push token.
 */
const pushConfigured = {
  android: existsSync(new URL('../mobile/android/app/google-services.json', import.meta.url)),
  ios: existsSync(new URL('../mobile/ios/App/App/GoogleService-Info.plist', import.meta.url)),
}

const ENTRY = 'index.mobile.html'

function mobileEntry(): Plugin {
  return {
    name: 'orbital-mobile-entry',
    enforce: 'post',
    // `npm run dev:mobile` serves the phone's page at `/`, not the desktop's.
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/' || req.url === '/index.html') req.url = `/${ENTRY}`
        next()
      })
    },
    generateBundle(_options, bundle) {
      const html = bundle[ENTRY]
      if (html?.type !== 'asset') return
      delete bundle[ENTRY]
      this.emitFile({ type: 'asset', fileName: 'index.html', source: html.source })
    },
  }
}

function chunkModules(): Plugin {
  return {
    name: 'orbital-chunk-modules',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const modules: Record<string, string[]> = {}
      for (const item of Object.values(bundle)) {
        if (item.type === 'chunk') modules[item.fileName] = item.moduleIds
      }
      this.emitFile({
        type: 'asset',
        fileName: '.vite/chunk-modules.json',
        source: JSON.stringify(modules, null, 2),
      })
    },
  }
}

export default defineConfig({
  plugins: [tailwindcss(), react(), mobileEntry(), chunkModules()],
  define: {
    __MOBILE_DEV__: JSON.stringify(process.env.ORBITAL_MOBILE_DEV === '1'),
    __MOBILE_VERSION__: JSON.stringify(mobileVersion),
    __MOBILE_PUSH__: JSON.stringify(pushConfigured),
  },
  resolve: {
    // The push plugin's web implementation wants the Firebase web SDK, which the shell never uses.
    alias: { 'firebase/messaging': fileURLToPath(new URL('./src/mobile/platform/firebaseWebStub.ts', import.meta.url)) },
  },
  build: {
    outDir: 'dist-mobile',
    emptyOutDir: true,
    manifest: true,
    rolldownOptions: { input: fileURLToPath(new URL(`./${ENTRY}`, import.meta.url)) },
  },
  // Beside the desktop's dev port; the relay's local port is the one below.
  server: { port: 4841, strictPort: true },
})
