import { describe, expect, it } from 'vitest'
import {
  COLOUR_THEMES,
  applyColourTheme,
  macColourTheme,
  resolveColourTheme,
} from '../lib/colourTheme'

describe('colour themes', () => {
  it('has one theme per id', () => {
    expect(new Set(COLOUR_THEMES.map((theme) => theme.id)).size).toBe(COLOUR_THEMES.length)
  })

  it('paints Deep Field on the Mac until Labs turns themes on', () => {
    expect(macColourTheme({ colour_theme: 'velvet' }, true)).toBe('deep-field')
    expect(macColourTheme({ colour_themes_enabled: 'true', colour_theme: 'velvet' }, true)).toBe('velvet')
  })

  it('falls back to Deep Field for an unknown or removed theme', () => {
    expect(macColourTheme({ colour_themes_enabled: 'true', colour_theme: 'gone' }, true)).toBe('deep-field')
  })

  it('takes Albedo in light mode and the chosen theme in dark mode while following the system', () => {
    const settings = { colour_themes_enabled: 'true', colour_theme: 'arctic', colour_theme_follow_system: 'true' }
    expect(macColourTheme(settings, false)).toBe('albedo')
    expect(macColourTheme(settings, true)).toBe('arctic')
  })

  it('ignores the system unless following it', () => {
    const choice = { theme: 'molten', followSystem: false, light: 'solar-light', dark: 'slate' }
    expect(resolveColourTheme(choice, false)).toBe('molten')
    expect(resolveColourTheme({ ...choice, followSystem: true }, false)).toBe('solar-light')
    expect(resolveColourTheme({ ...choice, followSystem: true }, true)).toBe('slate')
  })

  it('drops the attribute for Deep Field, which is the stylesheet itself', () => {
    const root = document.createElement('div')
    applyColourTheme(root, 'albedo')
    expect(root.dataset.colours).toBe('albedo')
    applyColourTheme(root, 'deep-field')
    expect(root.dataset.colours).toBeUndefined()
  })
})
