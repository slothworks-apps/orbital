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

/**
 * The composer is a ProseMirror editor, and ProseMirror measures the caret to
 * keep it in view. jsdom lays nothing out and leaves these unimplemented, so
 * they answer with an empty box; nothing in the suite asserts on geometry.
 */
const emptyRect = () =>
  ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  }) as DOMRect
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = emptyRect
}
if (!document.elementFromPoint) document.elementFromPoint = () => null
