import { describe, expect, it } from 'vitest'
import { completionKeyId } from '../lib/completionKey'

describe('completionKeyId', () => {
  it('tells apart every key that reads a different catalog or filesystem', () => {
    const ids = [
      completionKeyId({ session: 's1' }),
      completionKeyId({ cwd: '/w' }),
      completionKeyId({ cwd: '/w', claudeDir: 2 }),
      completionKeyId({ cwd: '/w', machine: 'build-box' }),
      completionKeyId({ cwd: '/w', machine: 'air-m3' }),
      completionKeyId({ cwd: '/other' }),
    ]
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('is the same for the same key rebuilt', () => {
    expect(completionKeyId({ cwd: '/w', machine: 'm', claudeDir: 1 })).toBe(
      completionKeyId({ claudeDir: 1, machine: 'm', cwd: '/w' }),
    )
  })
})
