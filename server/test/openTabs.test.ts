import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BARE_AT_TAB_MAX, completeFilePath, type OpenTabs } from '../src/files/complete.js'
import { OpenTabsReader, type OpenTabsSource } from '../src/files/openTabs.js'
import { makeTmpDir } from './tmp.js'

/**
 * The `@` completion's editor ranking (spec 2026-09-23-ide-bridge-design
 * § Open files, for `@` completion; canvas `Feature - IDE bridge` 20c).
 *
 * The order is the thing worth pinning: it is decided by the spec, it is not
 * obvious from reading the function, and it can break for a reason other than
 * someone deliberately changing a value.
 */

function tree(): string {
  const cwd = makeTmpDir('tabs')
  mkdirSync(join(cwd, 'web', 'src', 'panels'), { recursive: true })
  mkdirSync(join(cwd, 'server'), { recursive: true })
  writeFileSync(join(cwd, 'web', 'src', 'panels', 'DetailPanel.tsx'), 'detail')
  writeFileSync(join(cwd, 'web', 'src', 'panels', 'Composer.tsx'), 'composer')
  writeFileSync(join(cwd, 'server', 'Deploy.md'), 'deploy')
  writeFileSync(join(cwd, 'Deferred.md'), 'deferred')
  writeFileSync(join(cwd, 'app.ts'), 'app')
  return cwd
}

const names = (entries: { name: string }[]) => entries.map((e) => e.name)

describe('completeFilePath with the editor open', () => {
  it('answers exactly what it always did when there is no editor', () => {
    const cwd = tree()
    const bare = completeFilePath(cwd, 'De')
    expect(bare).toEqual(completeFilePath(cwd, 'De', null))
    expect(bare).toEqual(completeFilePath(cwd, 'De', { activePath: null, paths: [] }))
    expect(names(bare)).toEqual(['Deferred.md'])
    expect(bare[0].open).toBeUndefined()
  })

  it('answers a bare @ with the open tabs alone, and the tree again on one keystroke', () => {
    const cwd = tree()
    const tabs: OpenTabs = {
      activePath: null,
      paths: [join(cwd, 'web', 'src', 'panels', 'DetailPanel.tsx'), join(cwd, 'app.ts')],
    }

    // A bare `@` asks "what can I point at" and the editor answers it.
    expect(names(completeFilePath(cwd, '', tabs))).toEqual(['DetailPanel.tsx', 'app.ts'])

    // One character and the working tree is back — no affordance needed.
    expect(names(completeFilePath(cwd, 'D', tabs))).toContain('Deferred.md')
  })

  it('leaves a bare @ alone when no editor is open', () => {
    const cwd = tree()
    // The no-editor path must stay byte-for-byte what it was: the root walk,
    // directories first.
    expect(completeFilePath(cwd, '', null)).toEqual(completeFilePath(cwd, ''))
    expect(names(completeFilePath(cwd, '', null)).length).toBeGreaterThan(2)
  })

  it('caps a bare @ at BARE_AT_TAB_MAX even when more are open', () => {
    const cwd = tree()
    mkdirSync(join(cwd, 'many'), { recursive: true })
    const paths: string[] = []
    for (let i = 0; i < BARE_AT_TAB_MAX + 3; i += 1) {
      const p = join(cwd, 'many', `f${i}.ts`)
      writeFileSync(p, 'x')
      paths.push(p)
    }
    expect(completeFilePath(cwd, '', { activePath: null, paths })).toHaveLength(BARE_AT_TAB_MAX)
  })

  it('finds an open tab by its base name from anywhere in the tree', () => {
    const cwd = tree()
    const tabs: OpenTabs = {
      activePath: null,
      paths: [join(cwd, 'web', 'src', 'panels', 'DetailPanel.tsx')],
    }
    const entries = completeFilePath(cwd, 'De', tabs)
    expect(names(entries)).toEqual(['DetailPanel.tsx', 'Deferred.md'])
    // The row carries its own path, because the prefix does not point at the
    // directory it lives in.
    expect(entries[0]).toMatchObject({
      name: 'DetailPanel.tsx',
      path: 'web/src/panels/DetailPanel.tsx',
      open: true,
    })
    expect(entries[1].open).toBeUndefined()
    expect(entries[1].path).toBeUndefined()
  })

  it('puts the active tab first and the rest in the editor order', () => {
    const cwd = tree()
    const detail = join(cwd, 'web', 'src', 'panels', 'DetailPanel.tsx')
    const deploy = join(cwd, 'server', 'Deploy.md')
    const deferred = join(cwd, 'Deferred.md')
    // The editor lists them Deploy, Deferred, Detail; the caret is in Detail.
    const entries = completeFilePath(cwd, 'De', {
      activePath: detail,
      paths: [deploy, deferred, detail],
    })
    expect(names(entries)).toEqual(['DetailPanel.tsx', 'Deploy.md', 'Deferred.md'])
    expect(entries.every((e) => e.open)).toBe(true)
  })

  it('marks a tab the walk already found rather than listing it twice', () => {
    const cwd = tree()
    const entries = completeFilePath(cwd, 'De', {
      activePath: null,
      paths: [join(cwd, 'Deferred.md')],
    })
    expect(names(entries)).toEqual(['Deferred.md'])
    expect(entries[0].open).toBe(true)
    // In the directory the prefix points at, so there is nothing to carry.
    expect(entries[0].path).toBeUndefined()
    expect(entries[0].size).toBe('deferred'.length)
  })

  it('lifts an open tab above a directory, which nothing else does', () => {
    const cwd = tree()
    mkdirSync(join(cwd, 'apps'), { recursive: true })
    // Typed, not bare: a bare `@` answers with the tabs alone, so the ordering
    // this pins has to be read where the tree is still in the list.
    const entries = completeFilePath(cwd, 'a', {
      activePath: null,
      paths: [join(cwd, 'app.ts')],
    })
    // `app.ts` is a file and would sort below `apps/` on its own.
    expect(names(entries)).toEqual(['app.ts', 'apps'])
  })

  it('withholds the base-name reading once a directory has been typed', () => {
    const cwd = tree()
    const tabs: OpenTabs = {
      activePath: null,
      paths: [join(cwd, 'web', 'src', 'panels', 'DetailPanel.tsx')],
    }
    // `server/De` is a person navigating; a row from `web/` is not an answer.
    expect(names(completeFilePath(cwd, 'server/De', tabs))).toEqual(['Deploy.md'])
    // The path-wise reading still applies, and still ranks first.
    expect(names(completeFilePath(cwd, 'web/src/panels/', tabs))).toEqual([
      'DetailPanel.tsx',
      'Composer.tsx',
    ])
  })

  it('drops a tab outside the sandbox and one that has gone', () => {
    const cwd = tree()
    const outside = makeTmpDir('outside')
    writeFileSync(join(outside, 'Decoy.md'), 'x')
    const entries = completeFilePath(cwd, 'De', {
      activePath: join(outside, 'Decoy.md'),
      paths: [join(outside, 'Decoy.md'), join(cwd, 'Deleted.md')],
    })
    expect(names(entries)).toEqual(['Deferred.md'])
  })

  it('hides a dotfile tab unless the base asks for dotfiles', () => {
    const cwd = tree()
    writeFileSync(join(cwd, '.env'), 'x')
    const tabs: OpenTabs = { activePath: null, paths: [join(cwd, '.env')] }
    expect(names(completeFilePath(cwd, '', tabs))).not.toContain('.env')
    expect(names(completeFilePath(cwd, '.e', tabs))).toEqual(['.env'])
  })
})

describe('OpenTabsReader', () => {
  function source(over: Partial<OpenTabsSource> = {}) {
    const calls = { locate: 0, openFiles: 0 }
    const base: OpenTabsSource = {
      locate: (_cwd: string) => {
        calls.locate += 1
        return { selection: { filePath: '/w/x/a.ts', lineStart: 88 } }
      },
      openFiles: async (_cwd: string) => {
        calls.openFiles += 1
        return ['/w/x/a.ts', '/w/x/b.ts']
      },
    }
    return { source: { ...base, ...over }, calls }
  }

  it('reads the tab list once per window and the active tab every time', async () => {
    let clock = 0
    const { source: src, calls } = source()
    const reader = new OpenTabsReader(src, { ttlMs: 1_000, now: () => clock })

    expect(await reader.read('/w/x')).toEqual({
      activePath: '/w/x/a.ts',
      activeLine: 88,
      paths: ['/w/x/a.ts', '/w/x/b.ts'],
    })
    await reader.read('/w/x')
    clock = 999
    await reader.read('/w/x')
    expect(calls.openFiles).toBe(1)

    clock = 1_000
    await reader.read('/w/x')
    expect(calls.openFiles).toBe(2)
    expect(calls.locate).toBe(4)
  })

  it('coalesces a burst into one call while the first is still in flight', async () => {
    let release: (paths: string[]) => void = () => {}
    const { source: src, calls } = source({
      openFiles: () =>
        new Promise<string[] | null>((resolve) => {
          calls.openFiles += 1
          release = resolve
        }),
    })
    const reader = new OpenTabsReader(src)
    const all = Promise.all([reader.read('/w/x'), reader.read('/w/x'), reader.read('/w/x')])
    release(['/w/x/a.ts'])
    const results = await all
    expect(calls.openFiles).toBe(1)
    expect(results.every((r) => r?.paths.length === 1)).toBe(true)
  })

  it('answers null for every kind of no-editor, and does not cache it', async () => {
    const { source: src, calls } = source({
      openFiles: async () => {
        calls.openFiles += 1
        return null
      },
    })
    const reader = new OpenTabsReader(src)
    expect(await reader.read('/w/x')).toBeNull()
    expect(await reader.read('/w/x')).toBeNull()
    // Not cached, so the moment an editor connects the next keystroke finds it.
    expect(calls.openFiles).toBe(2)
  })

  it('survives a store that throws on either half', async () => {
    const rejecting = new OpenTabsReader({
      locate: () => null,
      openFiles: async () => {
        throw new Error('socket gone')
      },
    })
    expect(await rejecting.read('/w/x')).toBeNull()

    const throwing = new OpenTabsReader({
      locate: () => {
        throw new Error('nope')
      },
      openFiles: async () => ['/w/x/a.ts'],
    })
    expect(await throwing.read('/w/x')).toBeNull()
  })

  it('reads the active tab as null when nothing is selected', async () => {
    const reader = new OpenTabsReader({
      locate: () => ({ selection: null }),
      openFiles: async () => ['/w/x/a.ts'],
    })
    expect(await reader.read('/w/x')).toEqual({
      activePath: null,
      activeLine: null,
      paths: ['/w/x/a.ts'],
    })
  })
})
