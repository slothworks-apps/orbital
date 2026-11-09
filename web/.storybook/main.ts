import type { StorybookConfig } from '@storybook/react-vite'

/**
 * The catalogue of the UI primitives (spec 2026-11-09-design-system-and-storybook-design).
 * Storybook builds with the app's own `vite.config.ts` — Tailwind, React and
 * the theme — so a story renders exactly what the app renders.
 */
const config: StorybookConfig = {
  stories: ['../src/**/*.stories.tsx'],
  addons: ['@storybook/addon-docs'],
  framework: { name: '@storybook/react-vite', options: {} },
  // The app's dev server pins a port and proxies `/api` to Orbital; the
  // catalogue talks to no server and must not fight the app for its port.
  viteFinal: (vite) => ({ ...vite, server: { ...vite.server, port: undefined, strictPort: false, proxy: undefined } }),
}
export default config
