import { describe, expect, it } from 'vitest'
import { DEFAULT_COLOUR_CHOICE, parseColourChoice, serializeColourChoice } from '../mobile/platform/colourTheme'

describe('the phone colour choice, as stored', () => {
  it('round-trips', () => {
    const choice = { theme: 'velvet', followSystem: true, light: 'solar-light', dark: 'arctic' }
    expect(parseColourChoice(serializeColourChoice(choice))).toEqual(choice)
  })

  it('is Deep Field, not following the system, for a phone that never chose or stored garbage', () => {
    expect(parseColourChoice(null)).toEqual(DEFAULT_COLOUR_CHOICE)
    expect(parseColourChoice('not json')).toEqual(DEFAULT_COLOUR_CHOICE)
    expect(parseColourChoice('"velvet"')).toEqual(DEFAULT_COLOUR_CHOICE)
    expect(parseColourChoice('null')).toEqual(DEFAULT_COLOUR_CHOICE)
  })

  it('falls back field by field for a removed theme, keeping the rest', () => {
    const raw = JSON.stringify({ theme: 'gone', followSystem: true, light: 'solar-light', dark: 'gone' })
    expect(parseColourChoice(raw)).toEqual({ ...DEFAULT_COLOUR_CHOICE, followSystem: true, light: 'solar-light' })
  })

  it('keeps each appearance to themes of its own kind', () => {
    const raw = JSON.stringify({ theme: 'albedo', followSystem: true, light: 'velvet', dark: 'solar-light' })
    expect(parseColourChoice(raw)).toEqual({ ...DEFAULT_COLOUR_CHOICE, theme: 'albedo', followSystem: true })
  })

  it('follows the system only when stored as true', () => {
    expect(parseColourChoice(JSON.stringify({ followSystem: 'true' })).followSystem).toBe(false)
  })
})
