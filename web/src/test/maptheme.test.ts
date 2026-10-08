import { describe, it, expect } from 'vitest'
import { mapTheme } from '../store/store'
import { ARCHIPELAGO_ENABLED_KEY } from '../lib/experimental'

// adr: archipelago-sits-behind-an-experimental-switch
describe('mapTheme', () => {
  it('draws Planets for a stored Archipelago while its switch is off', () => {
    expect(mapTheme({ map_theme: 'archipelago' })).toBe('planets')
  })

  it('draws Archipelago once its switch is on', () => {
    expect(mapTheme({ map_theme: 'archipelago', [ARCHIPELAGO_ENABLED_KEY]: 'true' })).toBe('archipelago')
  })

  it('keeps Desk and Planets without any switch, and falls back on junk', () => {
    expect(mapTheme({ map_theme: 'desk' })).toBe('desk')
    expect(mapTheme({})).toBe('planets')
    expect(mapTheme({ map_theme: 'nebula' })).toBe('planets')
  })
})
