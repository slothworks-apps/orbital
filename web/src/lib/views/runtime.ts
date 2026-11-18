/**
 * The strings Orbital puts into a view's page, loaded on first use (spec
 * 2026-11-18-generated-views-design § React and Tailwind): the fonts for
 * every view, React and the Tailwind runtime for a React one. Each is its
 * own chunk (`web/viewRuntime.ts` makes them), so a session without views
 * never downloads them and the main bundle carries none of it. Loaded once
 * and kept: every frame on screen shares the same strings.
 */

export interface ReactRuntime {
  /** Sets `globalThis.__orbitalReact` to React, ReactDOM and the JSX runtime. */
  react: string
  /** The Tailwind v4 browser runtime. */
  tailwind: string
}

let fonts: Promise<string> | null = null
let react: Promise<ReactRuntime> | null = null

/** `@font-face` rules for Manrope and JetBrains Mono, the files inline. */
export function loadViewFonts(): Promise<string> {
  fonts ??= import('virtual:orbital-view/fonts').then((m) => m.default).catch((err: unknown) => {
    fonts = null
    throw err
  })
  return fonts
}

export function loadReactRuntime(): Promise<ReactRuntime> {
  react ??= Promise.all([import('virtual:orbital-view/react'), import('virtual:orbital-view/tailwind')])
    .then(([r, t]) => ({ react: r.default, tailwind: t.default }))
    .catch((err: unknown) => {
      react = null
      throw err
    })
  return react
}
