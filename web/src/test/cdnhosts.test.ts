import { describe, expect, it } from 'vitest'
import { VIEW_BUILTIN_CDN_HOSTS } from '@orbital/shared/views'
import { CDN_HOST_HELP, cdnHostField, cdnHostRows, viewsStateLine, withCdnHost, withoutCdnHost } from '../lib/cdnHosts'

const stored = JSON.stringify([{ host: 'cdn.skypack.dev', addedAt: 1 }])

describe('cdnHostRows', () => {
  it('lists the built-in hosts first, locked, then the user’s', () => {
    const rows = cdnHostRows(stored)
    expect(rows.map((r) => r.host)).toEqual([...VIEW_BUILTIN_CDN_HOSTS, 'cdn.skypack.dev'])
    expect(rows.filter((r) => r.builtIn).length).toBe(VIEW_BUILTIN_CDN_HOSTS.length)
    expect(rows.at(-1)).toEqual({ host: 'cdn.skypack.dev', builtIn: false, addedAt: 1 })
  })

  it('reads a broken stored value as no hosts of the user’s', () => {
    expect(cdnHostRows('{nope').every((r) => r.builtIn)).toBe(true)
  })
})

describe('cdnHostField', () => {
  it('takes a host, and says the standing line', () => {
    expect(cdnHostField('  Ga.JSPM.io ', stored)).toEqual({ state: 'ok', help: CDN_HOST_HELP, host: 'ga.jspm.io' })
  })

  it('offers nothing to add while empty', () => {
    expect(cdnHostField('  ', stored)).toEqual({ state: 'empty', help: CDN_HOST_HELP, host: null })
  })

  it('says what to type instead of a URL', () => {
    const field = cdnHostField('https://ga.jspm.io/npm:react', stored)
    expect(field.state).toBe('bad')
    expect(field.host).toBeNull()
    expect(field.help).toBe('A host only, without https:// or a path. Try ga.jspm.io.')
  })

  it('offers no suggestion when nothing reads as a host', () => {
    expect(cdnHostField('localhost', stored).help).toBe('A host only, without https:// or a path.')
  })

  it('refuses a built-in host and one already added', () => {
    expect(cdnHostField('unpkg.com', stored)).toMatchObject({ state: 'dup', help: 'unpkg.com is already in the list.' })
    expect(cdnHostField('CDN.skypack.dev', stored)).toMatchObject({ state: 'dup', host: null })
  })
})

describe('withCdnHost / withoutCdnHost', () => {
  it('appends with the time added, and removes by host', () => {
    const added = withCdnHost(stored, 'ga.jspm.io', 5)
    expect(JSON.parse(added)).toEqual([
      { host: 'cdn.skypack.dev', addedAt: 1 },
      { host: 'ga.jspm.io', addedAt: 5 },
    ])
    expect(JSON.parse(withoutCdnHost(added, 'cdn.skypack.dev'))).toEqual([{ host: 'ga.jspm.io', addedAt: 5 }])
  })

  it('adds nothing that is no host or already listed', () => {
    expect(JSON.parse(withCdnHost(stored, 'esm.sh', 5))).toEqual([{ host: 'cdn.skypack.dev', addedAt: 1 }])
    expect(JSON.parse(withCdnHost(null, 'http://x', 5))).toEqual([])
  })
})

describe('viewsStateLine', () => {
  it('counts every host while on, and says the user’s are kept while off', () => {
    expect(viewsStateLine(true, stored)).toContain(String(VIEW_BUILTIN_CDN_HOSTS.length + 1))
    expect(viewsStateLine(false, stored)).not.toBeNull()
    expect(viewsStateLine(false, null)).toBeNull()
  })
})
