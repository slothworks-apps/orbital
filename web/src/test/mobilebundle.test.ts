import { describe, expect, it } from 'vitest'
import { forbiddenModules, type ChunkModules, type ViteManifest } from '../mobile/bundleGuard'

describe('forbiddenModules', () => {
  const manifest: ViteManifest = {
    'index.mobile.html': { file: 'assets/index-a.js', isEntry: true, imports: ['_vendor-b.js'] },
    '_vendor-b.js': { file: 'assets/vendor-b.js' },
    'src/assets/logo.svg': { file: 'assets/logo-c.svg' },
  }

  it('passes a bundle with no three.js in any chunk', () => {
    const modules: ChunkModules = {
      'assets/index-a.js': ['/w/web/src/mobile/main.tsx'],
      'assets/vendor-b.js': ['/w/node_modules/react/index.js'],
    }
    expect(forbiddenModules(manifest, modules)).toEqual([])
  })

  it('names every chunk that carries three or @react-three', () => {
    const modules: ChunkModules = {
      'assets/index-a.js': ['/w/node_modules/@react-three/fiber/dist/index.js'],
      'assets/vendor-b.js': ['/w/node_modules/three/build/three.module.js'],
    }
    expect(forbiddenModules(manifest, modules)).toEqual([
      'assets/index-a.js: /w/node_modules/@react-three/fiber/dist/index.js',
      'assets/vendor-b.js: /w/node_modules/three/build/three.module.js',
    ])
  })

  it('fails a JS chunk it cannot see into', () => {
    expect(forbiddenModules(manifest, { 'assets/index-a.js': [] })).toEqual(['assets/vendor-b.js: not in chunk-modules.json'])
  })
})

type Fs = { existsSync(path: URL): boolean; readFileSync(path: URL, encoding: 'utf8'): string }
// Through `process` rather than an import: web/'s tsconfig carries no Node types.
const fs = (globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } }).process.getBuiltinModule('node:fs')
// `import.meta.url` goes through a local first: written inline as the literal
// `new URL('...', import.meta.url)`, Vite's asset-url plugin pattern-matches
// the call (it does this for any string literal, no extension check) and
// rewrites it to a dev-server URL instead of leaving it a plain file:// path.
const here = import.meta.url
const built = new URL('../../dist-mobile/.vite/', here)
const hasBuild = fs.existsSync(new URL('manifest.json', built))
// `npm run test:bundle` runs in this mode, right after a mobile build: there, no build is a failure.
const required = import.meta.env.MODE === 'bundle'

describe('the built mobile bundle', () => {
  it.skipIf(!hasBuild && !required)('carries no three.js in any chunk', () => {
    expect(hasBuild, 'run `npm run build:mobile -w @orbital/web` first').toBe(true)
    const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', built), 'utf8')) as ViteManifest
    const modules = JSON.parse(fs.readFileSync(new URL('chunk-modules.json', built), 'utf8')) as ChunkModules
    expect(forbiddenModules(manifest, modules)).toEqual([])
  })
})
