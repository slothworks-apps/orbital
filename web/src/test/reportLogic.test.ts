import { describe, it, expect } from 'vitest'
import type { OrbitalModel } from '../lib/types'
import { checkModels, pickCheckModel } from '../panels/report/logic'

const model = (value: string, family: string, variant: string | null = null): OrbitalModel => ({
  value, resolvedModel: value, family, version: family, shortVersion: family, variant, blurb: '', contextWindow: null,
})

describe('the Claude check models', () => {
  // The catalog as the server serves it: the family carries its version, aliases first, then pinned ids.
  const catalog = [
    model('opus', 'Opus 5.5'), model('fable', 'Fable 5.1'), model('sonnet', 'Sonnet 5.5'), model('haiku', 'Haiku 4.5'),
    model('claude-sonnet-5', 'Sonnet 5'), model('claude-opus-4-8', 'Opus 4.8'), model('opus[1m]', 'Opus 5.5', '1M'),
  ]

  it('offers one per family, named by the family alone, in the menu order', () => {
    expect(checkModels(catalog).map((m) => [m.name, m.value])).toEqual([
      ['Haiku', 'haiku'], ['Sonnet', 'sonnet'], ['Opus', 'opus'], ['Fable', 'fable'],
    ])
  })

  it('defaults to Haiku, and keeps a pick that is still offered', () => {
    const models = checkModels(catalog)
    expect(pickCheckModel(models, undefined)?.value).toBe('haiku')
    expect(pickCheckModel(models, 'sonnet')?.value).toBe('sonnet')
    expect(pickCheckModel(models, 'gone')?.value).toBe('haiku')
  })
})
