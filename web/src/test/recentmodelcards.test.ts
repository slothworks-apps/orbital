import { describe, expect, it } from 'vitest'
import { modelCardSlots, recentModelCards } from '../lib/models'
import type { OrbitalModel } from '../lib/types'

const row = (value: string, resolvedModel = value): OrbitalModel => ({
  value,
  resolvedModel,
  family: value,
  version: value,
  shortVersion: value,
  variant: null,
  blurb: '',
  contextWindow: null,
})

const opus = row('opus', 'claude-opus-5-5')
const fable = row('fable', 'claude-fable-5-2')
const sonnet = row('sonnet', 'claude-sonnet-5-5')
const haiku = row('haiku', 'claude-haiku-5-5')
const old = row('claude-opus-4-8')
const models = [opus, fable, sonnet, haiku, old]
const values = (rows: OrbitalModel[]) => rows.map((m) => m.value)

describe('modelCardSlots', () => {
  // Canvas 72c: the 418 px column of the 920 px dialog keeps four, a narrow one two.
  it('fits as many 96 px cards as the width holds, never fewer than two', () => {
    expect(modelCardSlots(418)).toBe(4)
    expect(modelCardSlots(520)).toBe(5)
    expect(modelCardSlots(100)).toBe(2)
    expect(modelCardSlots(0)).toBe(2)
  })
})

describe('recentModelCards', () => {
  it('puts the history first, newest first, matched by value or resolved id, once each', () => {
    const cards = recentModelCards({
      models,
      recent: ['claude-opus-4-8', 'claude-fable-5-2', 'fable', 'gone-model'],
      preselected: null,
      defaultValue: 'opus',
      slots: 3,
    })
    expect(values(cards)).toEqual(['claude-opus-4-8', 'fable', 'opus'])
  })

  it('without history: the default, then the catalog order', () => {
    const cards = recentModelCards({ models, recent: [], preselected: null, defaultValue: 'sonnet', slots: 3 })
    expect(values(cards)).toEqual(['sonnet', 'opus', 'fable'])
  })

  it('gives the preselected model the last slot when it is not recent enough', () => {
    const cards = recentModelCards({
      models,
      recent: ['opus', 'fable', 'sonnet'],
      preselected: 'claude-haiku-5-5',
      defaultValue: 'opus',
      slots: 3,
    })
    expect(values(cards)).toEqual(['opus', 'fable', 'haiku'])
  })

  it('keeps the order when the preselected model already has a card', () => {
    const cards = recentModelCards({ models, recent: ['opus', 'fable'], preselected: 'fable', defaultValue: null, slots: 2 })
    expect(values(cards)).toEqual(['opus', 'fable'])
  })
})
