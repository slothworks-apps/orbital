import { createContext, useContext, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

type Layer = { depth: number; seq: number; dismiss: () => void }

const stack: Layer[] = []
let listening = false
let nextSeq = 0

/**
 * How deeply nested a surface is. Ranking by depth — rather than by the order
 * layers happen to register — is what makes "innermost wins" actually true:
 * React runs child effects BEFORE parent ones, so two surfaces opening in the
 * same commit would otherwise rank backwards.
 */
const EscapeDepthContext = createContext(0)

/**
 * Wrap the content of a surface that can contain further dismissible surfaces,
 * so anything inside it outranks it.
 */
export function EscapeBoundary({ children }: { children: ReactNode }) {
  const depth = useContext(EscapeDepthContext)
  return <EscapeDepthContext.Provider value={depth + 1}>{children}</EscapeDepthContext.Provider>
}

/** Deepest layer wins; among equals, the most recently opened one. */
function topLayer(): Layer | undefined {
  let top: Layer | undefined
  for (const layer of stack) {
    if (!top || layer.depth > top.depth || (layer.depth === top.depth && layer.seq > top.seq)) {
      top = layer
    }
  }
  return top
}

function handleKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  const top = topLayer()
  if (!top) return
  // Escape belongs to exactly one layer. Stop it here so it cannot also reach
  // a layer further out in the same keystroke.
  e.preventDefault()
  e.stopPropagation()
  e.stopImmediatePropagation()
  top.dismiss()
}

/**
 * Registers a dismissible surface with the app's single Escape handler, so one
 * press peels exactly one layer.
 *
 * Every surface used to listen for Escape itself, which cannot work: `App`
 * listened on `window` in the CAPTURE phase, and capture runs outside-in — so
 * it fired before any inner handler and `stopPropagation` in a bubble-phase
 * listener could never head it off. One Escape inside an open select, inside
 * an open rule row, inside the Tags & rules panel closed all three at once.
 *
 * A layer may peel internally (Tags & rules closes an open rule row before
 * closing itself) — that stays its own business; the stack only guarantees it
 * is the single recipient of the keystroke.
 */
export function useEscapeLayer(active: boolean, dismiss: () => void): void {
  const depth = useContext(EscapeDepthContext)
  // Held in a ref so a changing callback identity never re-registers the
  // layer — re-registering would re-rank it among its peers.
  const latest = useRef(dismiss)
  latest.current = dismiss

  useEffect(() => {
    if (!active) return

    if (!listening) {
      window.addEventListener('keydown', handleKeyDown, true)
      listening = true
    }

    const layer: Layer = { depth, seq: nextSeq++, dismiss: () => latest.current() }
    stack.push(layer)
    return () => {
      const i = stack.lastIndexOf(layer)
      if (i !== -1) stack.splice(i, 1)
    }
  }, [active, depth])
}

/** Test-only: the current number of registered layers. */
export function escapeLayerDepth(): number {
  return stack.length
}
