/**
 * Whether the app runs as one of the website's demos (`site/demo`), on a
 * fake server. Set once by the demo before anything renders, never by the
 * app. What reaches the real world from the app — an issue on GitHub — stays
 * out of a demo, where a click would file it for real.
 */
let demo = false

/** `on` false only in tests, which share the module between cases. */
export function markDemo(on = true): void {
  demo = on
}

export function isDemo(): boolean {
  return demo
}
