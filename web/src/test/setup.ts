import '@testing-library/jest-dom'

/**
 * `lib/keymap` sniffs the platform once, at module load, and `matches` reads
 * ⌘ from `metaKey` only on macOS — so every test that presses a ⌘ chord
 * through a component needs a Mac platform in place before that module is
 * first imported. jsdom reports an empty `navigator.platform`; Orbital ships
 * for macOS only, so the suite runs as one.
 */
Object.defineProperty(window.navigator, 'platform', {
  value: 'MacIntel',
  configurable: true,
})
