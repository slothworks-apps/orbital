import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { defineConfig } from 'vitest/config'
import viteConfig from './vite.config.ts'

/**
 * The push plugin (`@capacitor-firebase/messaging`) as the phone's build sees
 * it: its ES module, whose web side imports `firebase/messaging`, which the
 * stub stands in for (vite.mobile.config.ts). Left to itself, Vitest takes the
 * package's CommonJS `main`, which requires the uninstalled SDK at load.
 */
const pushPluginCjs = pathToFileURL(createRequire(import.meta.url).resolve('@capacitor-firebase/messaging'))

export default defineConfig({
  ...viteConfig,
  resolve: {
    ...viteConfig.resolve,
    alias: {
      '@capacitor-firebase/messaging': fileURLToPath(new URL('esm/index.js', pushPluginCjs)),
      'firebase/messaging': fileURLToPath(new URL('./src/mobile/platform/firebaseWebStub.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
})
