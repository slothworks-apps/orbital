import { describe, expect, it } from 'vitest'
import { VIEW_BUILTIN_CDN_HOSTS } from '@orbital/shared/views'
import {
  VIEW_MODULE,
  buildViewDocument,
  documentCsp,
  esmUrl,
  inlineScript,
  moduleImports,
  viewImportMap,
  type ViewTheme,
} from '../lib/views/document'
import { DATA_ELEMENT_ID } from '../lib/views/bridge'
import { TOKENS, type Token } from '../lib/palette'

const theme: ViewTheme = {
  colours: Object.fromEntries(TOKENS.map((t) => [t, 'rgb(1, 2, 3)'])) as Record<Token, string>,
  textScale: 1,
}
const runtime = { react: 'globalThis.__orbitalReact = {}', tailwind: '/* tailwind */' }
const base = { cdnHosts: [...VIEW_BUILTIN_CDN_HOSTS], approvedDomains: [], title: 'Release latency' }

function html(page: string, data: unknown = null) {
  return buildViewDocument({ payload: { ...base, kind: 'html', html: page }, data, theme, fonts: '' })
}

/** The document as Chromium's parser would read it. */
function parse(doc: string): Document {
  return new DOMParser().parseFromString(doc, 'text/html')
}

describe('buildViewDocument', () => {
  it('puts the CSP first in the head', () => {
    const head = parse(html('<p>hi</p>')).head
    const first = head.firstElementChild
    expect(first?.getAttribute('http-equiv')).toBe('Content-Security-Policy')
    expect(first?.getAttribute('content')).toContain("connect-src 'none'")
  })

  it('runs the bridge before anything of the page', () => {
    const doc = parse(html('<script>window.mine = 1</script><p>hi</p>'))
    const scripts = [...doc.querySelectorAll('script')]
    const bridge = scripts.findIndex((s) => s.textContent?.includes('window.orbital'))
    const page = scripts.findIndex((s) => s.textContent?.includes('window.mine'))
    expect(bridge).toBeGreaterThanOrEqual(0)
    expect(bridge).toBeLessThan(page)
  })

  it('keeps data that looks like markup inside its element, and reads it back whole', () => {
    const data = { a: '</script><script>alert(1)</script>', b: '<!-- x', c: '</SCRIPT >' }
    const doc = parse(html('<p>hi</p>', data))
    const el = doc.getElementById(DATA_ELEMENT_ID)
    expect(JSON.parse(el?.textContent ?? '')).toEqual(data)
    // Nothing escaped into a script of its own.
    expect([...doc.querySelectorAll('script')].some((s) => s.textContent?.includes('alert(1)') && s.id !== DATA_ELEMENT_ID)).toBe(false)
  })

  it('needs the runtime for a React view, and mounts into #root after the import map', () => {
    expect(() => buildViewDocument({ payload: { ...base, kind: 'react', script: 'export default 1' }, data: null, theme, fonts: '' })).toThrow()
    const doc = parse(buildViewDocument({ payload: { ...base, kind: 'react', script: 'export default () => null' }, data: null, theme, fonts: '', runtime }))
    const scripts = [...doc.querySelectorAll('script')]
    const map = scripts.findIndex((s) => s.type === 'importmap')
    const mount = scripts.findIndex((s) => s.type === 'module')
    expect(map).toBeGreaterThanOrEqual(0)
    expect(map).toBeLessThan(mount)
    expect(doc.getElementById('root')).not.toBeNull()
    expect(JSON.parse(scripts[map].textContent ?? '').imports[VIEW_MODULE]).toMatch(/^data:text\/javascript/)
  })
})

describe('inlineScript', () => {
  it('cannot be closed or commented out from inside', () => {
    const out = inlineScript('const s = "</script><b>"; const c = "<!--"; const t = "</SCRIPT>"')
    expect(out).not.toMatch(/<\/script/i)
    expect(out).not.toContain('<!--')
  })
})

describe('documentCsp', () => {
  it('lets a React view load its data: modules and a plain page not', () => {
    const scriptSrc = (csp: string) => csp.split('; ').find((d) => d.startsWith('script-src')) ?? ''
    expect(scriptSrc(documentCsp({ ...base, kind: 'react' })).split(' ')).toContain('data:')
    expect(scriptSrc(documentCsp({ ...base, kind: 'html' })).split(' ')).not.toContain('data:')
  })

  it('lets the page reach only the approved domains', () => {
    const csp = documentCsp({ ...base, kind: 'react', approvedDomains: ['api.github.com'] })
    expect(csp).toContain('connect-src https://api.github.com')
  })
})

describe('the import map', () => {
  const script = [
    "import { useState } from 'react'",
    "import { jsx as _jsx } from 'react/jsx-runtime'",
    "import { LineChart, Line } from 'recharts'",
    "import * as d3 from \"d3-scale\"",
    "import 'some-css-pkg'",
    "export { thing } from 'lodash-es'",
    "import local from './local.js'",
    "import abs from 'https://cdn.jsdelivr.net/npm/x@1/+esm'",
    "const later = () => import('date-fns')",
    "const text = 'import nothing from \"in-a-string\"'.length",
    'export default function View() { return null }',
  ].join('\n')

  it('finds every import, static and dynamic', () => {
    expect(moduleImports(script)).toEqual(
      expect.arrayContaining(['react', 'react/jsx-runtime', 'recharts', 'd3-scale', 'some-css-pkg', 'lodash-es', './local.js', 'date-fns']),
    )
    // A string that reads like an import is not one: it would be loaded, and fail the view.
    expect(moduleImports(script)).not.toContain('in-a-string')
  })

  it('sends bare packages to esm.sh against the page React, and leaves the rest alone', () => {
    const map = viewImportMap(script)
    expect(map.recharts).toBe(esmUrl('recharts'))
    expect(map.recharts).toBe('https://esm.sh/recharts?external=react,react-dom')
    expect(map['d3-scale']).toBe(esmUrl('d3-scale'))
    expect(map['date-fns']).toBe(esmUrl('date-fns'))
    expect(map['./local.js']).toBeUndefined()
    expect(map['https://cdn.jsdelivr.net/npm/x@1/+esm']).toBeUndefined()
    // React is always the page's own, never esm.sh's.
    for (const name of ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']) {
      expect(map[name]).toMatch(/^data:text\/javascript/)
    }
  })

  it('re-exports what the app’s React exports by name', () => {
    const shim = decodeURIComponent(viewImportMap('')['react'].split(',').slice(1).join(','))
    expect(shim).toContain('export default m')
    expect(shim).toMatch(/useState/)
    expect(shim).toMatch(/createElement/)
  })
})
