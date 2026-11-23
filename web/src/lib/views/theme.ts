import { useSyncExternalStore } from 'react'
import { TOKENS, type Token } from '../palette'

/**
 * The colour theme a view's page is drawn in (spec
 * 2026-11-18-generated-views-design § Theme): every token as the root's
 * stylesheet sets it now. Read from CSS rather than through `sceneColours`,
 * which would pull three.js into the phone's bundle with it; a token that
 * refers to another (`--color-shadow: var(--color-shade)`) is handed over
 * as written, and resolves in the page, which carries every token too.
 */

type Colours = Readonly<Record<Token, string>>

let current: Colours | null = null
let currentKey = ''
const listeners = new Set<() => void>()
let observer: MutationObserver | null = null

function read(): Colours {
  const style = getComputedStyle(document.documentElement)
  const out = {} as Record<Token, string>
  for (const token of TOKENS) out[token] = style.getPropertyValue(`--color-${token}`).trim()
  return out
}

function refresh(): void {
  const next = read()
  const key = TOKENS.map((t) => next[t]).join('|')
  if (key === currentKey && current) return
  current = next
  currentKey = key
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!observer && typeof MutationObserver !== 'undefined') {
    // A colour theme is a `data-colours` on the root (`lib/colourTheme.ts`).
    observer = new MutationObserver(refresh)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-colours', 'class', 'style'] })
    refresh()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && observer) {
      observer.disconnect()
      observer = null
    }
  }
}

function snapshot(): Colours {
  if (!current) refresh()
  return current!
}

/** Every token's value now; re-renders the caller when the colour theme changes. */
export function useViewColours(): Colours {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
