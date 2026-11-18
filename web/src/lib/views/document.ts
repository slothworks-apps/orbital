import * as ReactNS from 'react'
import * as ReactDOMNS from 'react-dom'
import * as ReactDOMClientNS from 'react-dom/client'
import * as JsxRuntimeNS from 'react/jsx-runtime'
import { viewCsp, type ViewPayload } from '@orbital/shared/views'
import { TOKENS, type Token } from '../palette'
import { BRIDGE_SOURCE, DATA_ELEMENT_ID } from './bridge'
import type { ReactRuntime } from './runtime'

/**
 * A view's page as the frame's `srcdoc` (spec 2026-11-18-generated-views-design
 * § Isolation and network, § Theme, § React and Tailwind). Pure: the caller
 * hands in the theme, the fonts and — for a React view — the runtime
 * strings, so a test can build a document without a browser.
 *
 * In this order, each for a reason:
 *
 * 1. the CSP `<meta>`, first, so nothing before it runs unpoliced;
 * 2. the theme's variables, the fonts and the base stylesheet, so a plain
 *    page already looks like Orbital;
 * 3. the data, as JSON in an inert `<script type="application/json">`;
 * 4. the bridge, before anything of the page's own can run;
 * 5. for a React view: React, the Tailwind runtime and its theme, the import
 *    map, and the module that mounts the component into `#root`;
 * 6. the content: the plain page's HTML, or `#root`.
 *
 * The frame has an opaque origin, so everything Orbital provides is inline:
 * a view without imports draws offline.
 */

/** Where any package the component imports by name comes from. */
export const ESM_CDN = 'https://esm.sh'
/** Built against the page's own React, which the import map provides. */
const ESM_EXTERNAL = 'external=react,react-dom'

/** The name the component's module is imported under, through the import map. */
export const VIEW_MODULE = '@orbital/view'

/** The packages the page's React answers to; `globalThis.__orbitalReact` holds each. */
const REACT_PACKAGES: Record<string, object> = {
  react: ReactNS,
  'react/jsx-runtime': JsxRuntimeNS,
  'react-dom': ReactDOMNS,
  'react-dom/client': ReactDOMClientNS,
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/**
 * A module over one of the page's React packages: its default and every
 * named export, read off the app's own copy of the same version (the page's
 * is the same files, `web/viewRuntime.ts`).
 */
export function reactShim(name: string): string {
  const names = Object.keys(REACT_PACKAGES[name] ?? {}).filter((key) => key !== 'default' && key !== '__esModule' && IDENTIFIER.test(key))
  const body =
    `const m=globalThis.__orbitalReact[${JSON.stringify(name)}];export default m;` +
    (names.length > 0 ? `export const {${names.join(',')}}=m;` : '')
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(body)}`
}

/** An `import`/`export … from` statement: at the start of a line or after a `;` or `}`, never inside a string. */
const IMPORT_FROM = /(?:^|[;}])[ \t]*(?:import|export)\s*(?:[\w$*{}\s,]*?\bfrom\s*)?(['"])([^'"\n]+)\1/gm
const DYNAMIC_IMPORT = /(?:^|[^\w$.])import\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g

/** Every specifier the module imports, static or dynamic, each once, in order. */
export function moduleImports(script: string): string[] {
  const found = new Set<string>()
  for (const re of [IMPORT_FROM, DYNAMIC_IMPORT]) {
    re.lastIndex = 0
    for (let m = re.exec(script); m; m = re.exec(script)) found.add(m[2])
  }
  return [...found]
}

/** A bare specifier: neither relative, absolute nor a URL. */
function isBare(specifier: string): boolean {
  return !/^[./]/.test(specifier) && !/^[a-z][a-z0-9+.-]*:/i.test(specifier)
}

/** A package the component imports, on esm.sh, built against the page's React. */
export function esmUrl(specifier: string): string {
  return `${ESM_CDN}/${specifier}${specifier.includes('?') ? '&' : '?'}${ESM_EXTERNAL}`
}

/** The bare specifiers the component imports that are not the page's React: what comes from esm.sh. */
export function esmPackages(script: string): string[] {
  return moduleImports(script).filter((specifier) => isBare(specifier) && !(specifier in REACT_PACKAGES) && specifier !== VIEW_MODULE)
}

/**
 * The import map: the page's React under its package names (always — a
 * package from esm.sh imports them too), the component under
 * `VIEW_MODULE`, and every other bare specifier the component imports on
 * esm.sh.
 */
export function viewImportMap(script: string): Record<string, string> {
  const imports: Record<string, string> = {}
  for (const name of Object.keys(REACT_PACKAGES)) imports[name] = reactShim(name)
  for (const specifier of esmPackages(script)) imports[specifier] = esmUrl(specifier)
  imports[VIEW_MODULE] = `data:text/javascript;charset=utf-8,${encodeURIComponent(script)}`
  return imports
}

/**
 * JavaScript put inside a `<script>`: the HTML parser would end the element
 * at `</script` and open a comment state at `<!--`. Escaped so the
 * JavaScript means the same (`<\/` is `</` in a string, a template and a
 * regular expression alike).
 */
export function inlineScript(source: string): string {
  return source.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--')
}

/** JSON put inside a `<script type="application/json">`: every `<` escaped, which `JSON.parse` reads back as `<`. */
export function inlineJson(value: unknown): string {
  return (JSON.stringify(value === undefined ? null : value) ?? 'null').replace(/</g, '\\u003c')
}

/** A value inside a CSS declaration or an attribute: no way out of it. */
function cssValue(value: string): string {
  return value.replace(/[<>{};"\\]/g, '')
}

/** Every theme variable a page gets: the tokens, the fonts and the text scale. */
export interface ViewTheme {
  /** Each token's colour as CSS, as the root sets it. */
  colours: Record<Token, string>
  /** The transcript's text step (`--transcript-text-scale`). */
  textScale: number
}

export const FONT_SANS = "'Manrope', system-ui, sans-serif"
export const FONT_MONO = "'JetBrains Mono', ui-monospace, monospace"

/**
 * The variables as the page carries them: `--color-*` for the page's own CSS
 * (what the tool's description promises), `--orbital-*` behind the Tailwind
 * theme (Tailwind writes its own `--color-*` from it, which would otherwise
 * point at itself).
 */
export function viewThemeVars(theme: ViewTheme): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const token of TOKENS) {
    const value = cssValue(theme.colours[token] ?? '')
    vars[`--color-${token}`] = value
    vars[`--orbital-${token}`] = value
  }
  vars['--font-sans'] = FONT_SANS
  vars['--font-mono'] = FONT_MONO
  vars['--orbital-font-sans'] = FONT_SANS
  vars['--orbital-font-mono'] = FONT_MONO
  vars['--text-scale'] = String(Number.isFinite(theme.textScale) && theme.textScale > 0 ? theme.textScale : 1)
  return vars
}

const mix = (token: Token, share: number) => `color-mix(in srgb, var(--color-${token}) ${share}%, transparent)`

/**
 * What a plain page looks like before it styles anything (spec § Theme): the
 * space floor and Orbital's text, links, tables, buttons and inputs. Values
 * from 69b/69c where the canvas draws them (the view's own table, its Send
 * button, the frame's Reload); the rest is marked.
 *
 * It sits in a cascade layer of its own, ordered after Tailwind's preflight
 * (`base`) and before its `utilities`: unlayered, it would beat every utility,
 * so `bg-accent` on a `<button>` would draw nothing. A page's own unlayered
 * CSS beats it too, as it should.
 */
function baseStylesheet(kind: ViewPayload['kind']): string {
  return `@layer theme,base,orbital,components,utilities;
@layer orbital{
*,*::before,*::after{box-sizing:border-box}
html{color-scheme:light dark;scrollbar-width:thin;scrollbar-color:${mix('line', 30)} transparent}
/* 69b: the page draws on the bare space floor. */
html,body{margin:0;background:var(--color-space);color:var(--color-ink-100)}
/* Not on the canvas: the transcript's body size, 13px, at the transcript's text step. */
body{font-family:var(--font-sans);font-size:calc(13px * var(--text-scale,1));line-height:1.5;-webkit-font-smoothing:antialiased${kind === 'html' ? ';padding:14px 16px' : ''}}
#root{min-height:100%}
h1,h2,h3{margin:0 0 8px;font-weight:700;line-height:1.3}
h1{font-size:calc(15px * var(--text-scale,1))}
h2,h3{font-size:calc(13px * var(--text-scale,1))}
p{margin:0 0 8px}
a{color:var(--color-sky)}
code,pre,kbd{font-family:var(--font-mono);font-size:.92em}
small{color:${mix('ink-900', 60)}}
/* 69b: the view's table — mono header at ink-900/60 over a line/16 rule, rows on line/8. */
table{border-collapse:collapse;width:100%}
th{padding:5px 8px 5px 0;text-align:left;font-family:var(--font-mono);font-size:calc(10px * var(--text-scale,1));font-weight:400;letter-spacing:.04em;color:${mix('ink-900', 60)};border-bottom:1px solid ${mix('line', 16)}}
td{padding:6px 8px 6px 0;border-bottom:1px solid ${mix('line', 8)}}
/* 69c: Reload's quiet button; 69b: Send, the primary one. */
button{appearance:none;margin:0;cursor:pointer;font:inherit;font-size:calc(12.5px * var(--text-scale,1));font-weight:600;border-radius:8px;padding:7px 13px;border:1px solid ${mix('line', 16)};background:transparent;color:var(--color-ink-100)}
button:hover{border-color:${mix('line', 30)}}
button[type=submit],button.primary{border:0;border-radius:7px;padding:7px 14px;font-weight:700;background:var(--color-accent);color:var(--color-space-deep)}
button:disabled{cursor:default;opacity:.45}
/* Not on the canvas: fields take the composer's well (space/60, line/16), at the button's radius. */
input,select,textarea{font:inherit;color:var(--color-ink-100);background:${mix('space', 60)};border:1px solid ${mix('line', 16)};border-radius:7px;padding:6px 9px}
input:focus,select:focus,textarea:focus{outline:none;border-color:${mix('accent', 55)}}
input[type=checkbox],input[type=radio]{accent-color:var(--color-accent)}
::selection{background:${mix('accent', 30)}}
}
`
}

/** Tailwind's theme in a view: Orbital's tokens under Orbital's names, and the `fs-*` text step. */
function tailwindTheme(): string {
  const colours = TOKENS.map((token) => `--color-${token}: var(--orbital-${token});`).join('\n')
  return `@theme inline {
${colours}
--font-sans: var(--orbital-font-sans);
--font-mono: var(--orbital-font-mono);
}
@utility fs-* {
  font-size: calc(--value(number) * 1px * var(--text-scale, 1));
}`
}

/**
 * Mounts the component: its default export, with the data as `data`; any
 * failure to the bridge. The packages from esm.sh are imported one by one
 * first, so one that does not load is named — imported only through the
 * component, Chromium names the component's own data: URL instead.
 */
function mountScript(packages: readonly string[]): string {
  return `const R = globalThis.__orbitalReact;
const LOAD_FAILED = /(?:Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed)[:.]?\\s*(\\S+)?/;
Promise.all(${JSON.stringify(packages)}.map((name) => import(name)))
  .then(() => import(${JSON.stringify(VIEW_MODULE)}))
  .then((m) => {
    const View = m.default;
    if (typeof View !== 'function' && (typeof View !== 'object' || View === null)) {
      throw new Error('The view has no default export to draw');
    }
    const fail = (error) => orbital.__fail('page', (error && error.message) || String(error));
    const root = R['react-dom/client'].createRoot(document.getElementById('root'), { onUncaughtError: fail });
    root.render(R.react.createElement(View, { data: orbital.data }));
    requestAnimationFrame(() => requestAnimationFrame(() => orbital.__ready()));
  })
  .catch((error) => {
    const message = (error && error.message) || String(error);
    const failed = LOAD_FAILED.exec(message);
    if (failed && !/^data:/.test(failed[1] || '')) orbital.__fail('script', 'did not load', failed[1]);
    else orbital.__fail('page', failed ? 'One of its imports could not be loaded' : message);
  });`
}

/** A plain page is ready once it has loaded. */
const READY_ON_LOAD = `window.addEventListener('load', function () { orbital.__ready(); });`

export interface ViewDocumentInput {
  payload: Pick<ViewPayload, 'kind' | 'script' | 'html' | 'cdnHosts' | 'approvedDomains' | 'title'>
  /** The data as the page reads it: JSON parsed, a CSV as text, null for none. */
  data: unknown
  theme: ViewTheme
  /** `@font-face` rules (`loadViewFonts`). */
  fonts: string
  /** React and Tailwind; needed for a `react` view. */
  runtime?: ReactRuntime
}

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function text(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
}

export function buildViewDocument(input: ViewDocumentInput): string {
  const { payload, data, theme, fonts, runtime } = input
  const react = payload.kind === 'react'
  if (react && !runtime) throw new Error('A React view needs the React runtime')
  const vars = Object.entries(viewThemeVars(theme))
    .map(([name, value]) => `${name}:${value}`)
    .join(';')
  const head = [
    `<meta http-equiv="Content-Security-Policy" content="${attr(viewCsp({ cdnHosts: payload.cdnHosts, connect: payload.approvedDomains }))}">`,
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${text(payload.title)}</title>`,
    `<style>:root{${vars}}</style>`,
    `<style>${fonts.replace(/<\//g, '<\\/')}</style>`,
    `<style>${baseStylesheet(payload.kind)}</style>`,
    `<script type="application/json" id="${DATA_ELEMENT_ID}">${inlineJson(data)}</script>`,
    `<script>${inlineScript(BRIDGE_SOURCE)}</script>`,
  ]
  if (react && runtime) {
    const script = payload.script ?? ''
    head.push(
      `<script>${inlineScript(runtime.react)}</script>`,
      `<script>${inlineScript(runtime.tailwind)}</script>`,
      `<style type="text/tailwindcss">${tailwindTheme()}</style>`,
      `<script type="importmap">${inlineJson({ imports: viewImportMap(script) })}</script>`,
      `<script type="module">${inlineScript(mountScript(esmPackages(script)))}</script>`,
    )
  } else {
    head.push(`<script>${READY_ON_LOAD}</script>`)
  }
  const body = react ? '<div id="root"></div>' : (payload.html ?? '')
  return `<!doctype html><html lang="en"><head>${head.join('')}</head><body>${body}</body></html>`
}
