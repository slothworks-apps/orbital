import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Plugin } from 'vite'

/**
 * What Orbital puts into a generated view's page (spec
 * 2026-11-18-generated-views-design § React and Tailwind, § Theme), as
 * strings the web app imports lazily — `web/src/lib/views/runtime.ts` — so
 * none of it weighs on the main bundle:
 *
 * - `virtual:orbital-view/react`: React, ReactDOM and the JSX runtime, the
 *   packages' own production CommonJS files wrapped in a few lines of
 *   `require`, setting `globalThis.__orbitalReact`. React 19 ships no UMD
 *   build, and the page's opaque origin cannot load one from the app.
 * - `virtual:orbital-view/tailwind`: the Tailwind v4 browser runtime.
 * - `virtual:orbital-view/fonts`: Manrope and JetBrains Mono as `@font-face`
 *   rules with the woff2 files inline: the page cannot read the app's.
 *
 * The files are read from whatever version of each package is installed, so
 * the page's React is always the app's own.
 */

const require = createRequire(import.meta.url)

/** A package's own directory, past its `exports` (which do not list the `cjs/` files). */
function packageDir(name: string): string {
  return dirname(require.resolve(`${name}/package.json`))
}

function read(name: string, file: string): string {
  return readFileSync(join(packageDir(name), file), 'utf8')
}

/** The CommonJS modules the page's React is made of, by the name they `require` each other under. */
const REACT_MODULES: Record<string, [string, string]> = {
  react: ['react', 'cjs/react.production.js'],
  'react/jsx-runtime': ['react', 'cjs/react-jsx-runtime.production.js'],
  scheduler: ['scheduler', 'cjs/scheduler.production.js'],
  'react-dom': ['react-dom', 'cjs/react-dom.production.js'],
  'react-dom/client': ['react-dom', 'cjs/react-dom-client.production.js'],
}

/** The names the page imports React under; the import map points each at a shim over `__orbitalReact`. */
const REACT_EXPORTED = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']

function reactSource(): string {
  const defs = Object.entries(REACT_MODULES)
    .map(([name, [pkg, file]]) => `defs[${JSON.stringify(name)}]=function(module,exports,require){${read(pkg, file)}\n};`)
    .join('\n')
  const exported = REACT_EXPORTED.map((name) => `${JSON.stringify(name)}:req(${JSON.stringify(name)})`).join(',')
  return (
    `(function(){var defs={};\n${defs}\nvar cache={};` +
    'function req(n){var c=cache[n];if(c)return c.exports;var m={exports:{}};cache[n]=m;defs[n].call(m.exports,m,m.exports,req);return m.exports}' +
    `globalThis.__orbitalReact={${exported}};})();`
  )
}

/** The weights a view's page may ask for, of the two families Orbital draws with. */
const FONTS: { family: string; pkg: string; file: (weight: number) => string; weights: number[] }[] = [
  { family: 'Manrope', pkg: '@fontsource/manrope', file: (w) => `files/manrope-latin-${w}-normal.woff2`, weights: [400, 600, 700] },
  {
    family: 'JetBrains Mono',
    pkg: '@fontsource/jetbrains-mono',
    file: (w) => `files/jetbrains-mono-latin-${w}-normal.woff2`,
    weights: [400, 500],
  },
]

function fontsSource(): string {
  return FONTS.flatMap(({ family, pkg, file, weights }) =>
    weights.map((weight) => {
      const bytes = readFileSync(join(packageDir(pkg), file(weight))).toString('base64')
      return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${bytes}) format('woff2')}`
    }),
  ).join('\n')
}

const SOURCES: Record<string, () => string> = {
  'virtual:orbital-view/react': reactSource,
  'virtual:orbital-view/tailwind': () => read('@tailwindcss/browser', 'dist/index.global.js'),
  'virtual:orbital-view/fonts': fontsSource,
}

export function viewRuntime(): Plugin {
  return {
    name: 'orbital-view-runtime',
    resolveId(id) {
      return id in SOURCES ? `\0${id}` : null
    },
    load(id) {
      if (!id.startsWith('\0virtual:orbital-view/')) return null
      const source = SOURCES[id.slice(1)]
      return source ? `export default ${JSON.stringify(source())}` : null
    },
  }
}
