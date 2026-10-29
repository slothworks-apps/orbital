import { describe, expect, it } from 'vitest'
import {
  COLOUR_THEMES,
  applyColourTheme,
  macColourChoice,
  macColourTheme,
  resolveColourTheme,
} from '../lib/colourTheme'

describe('colour themes', () => {
  it('has one theme per id', () => {
    expect(new Set(COLOUR_THEMES.map((theme) => theme.id)).size).toBe(COLOUR_THEMES.length)
  })

  it('paints Deep Field on the Mac until a theme is picked, and the picked one after', () => {
    expect(macColourTheme({}, true)).toBe('deep-field')
    expect(macColourTheme({ colour_theme: 'velvet' }, true)).toBe('velvet')
  })

  it('falls back to Deep Field for an unknown or removed theme', () => {
    expect(macColourTheme({ colour_theme: 'gone' }, true)).toBe('deep-field')
  })

  it('takes Albedo in light mode and the chosen dark theme in dark mode until each is picked', () => {
    const settings = { colour_theme: 'arctic', colour_theme_follow_system: 'true' }
    expect(macColourTheme(settings, false)).toBe('albedo')
    expect(macColourTheme(settings, true)).toBe('arctic')
    // A light theme chosen before has no place in dark mode.
    expect(macColourTheme({ ...settings, colour_theme: 'solar-light' }, true)).toBe('deep-field')
  })

  it('takes the theme picked for each appearance while following the system', () => {
    const settings = {
      colour_theme: 'arctic',
      colour_theme_follow_system: 'true',
      colour_theme_light: 'solar-light',
      colour_theme_dark: 'velvet',
    }
    expect(macColourTheme(settings, false)).toBe('solar-light')
    expect(macColourTheme(settings, true)).toBe('velvet')
    expect(macColourTheme({ ...settings, colour_theme_follow_system: 'false' }, false)).toBe('arctic')
  })

  it('drops a theme of the other kind, or an unknown one, from an appearance', () => {
    const choice = macColourChoice({ colour_theme_light: 'velvet', colour_theme_dark: 'albedo' })
    expect(choice.light).toBe('albedo')
    expect(choice.dark).toBe('deep-field')
    expect(macColourChoice({ colour_theme_light: 'gone' }).light).toBe('albedo')
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
