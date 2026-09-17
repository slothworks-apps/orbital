import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { api } from '../lib/api'

/**
 * Every mounted boundary's reset callback. Module-level rather than a
 * context, because the thing that wants to reset them — a hot update landing
 * in a tab whose tree React has already torn down — happens outside React
 * entirely and has no component to call a hook from.
 */
const mounted = new Set<() => void>()

/**
 * Clears every boundary that is currently showing its fallback, letting the
 * tree try to render again.
 *
 * Wired to `vite:afterUpdate` in dev (see `main.tsx`): Orbital is used to
 * drive sessions that edit Orbital, so its own `web/src` is hot-swapped
 * mid-write and a component can arrive in a state that parses but throws.
 * Without this the tab stays on the fallback until a human reloads, even
 * though the very next update usually makes it valid again. See
 * `docs/fixes/hmr-of-a-half-written-file-kills-the-open-ui.md`.
 */
export function resetErrorBoundaries(): void {
  for (const reset of [...mounted]) reset()
}

export interface ErrorBoundaryProps {
  /** Names the surface in the fallback, so a crashed panel says which one. */
  label: string
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * Catches a render error and shows a fallback in place of the subtree it
 * wraps, instead of letting React unmount the whole tree.
 *
 * The fallback is deliberately plain markup rather than `ui/Button` and
 * friends: it is what renders when rendering is already going wrong, so the
 * less of the component library it depends on, the more often it can
 * actually appear.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  private reset = (): void => {
    // Guarded: `resetErrorBoundaries` calls every boundary, and setting state
    // on the ones that never failed would re-render the whole app on every
    // hot update.
    if (this.state.error) this.setState({ error: null })
  }

  componentDidMount(): void {
    mounted.add(this.reset)
  }

  componentWillUnmount(): void {
    mounted.delete(this.reset)
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The terminal keeps saying it too — the log is an addition, not a move.
    console.error(`orbital: ${this.props.label} crashed`, error, info.componentStack)

    void api
      .reportErrorToServer({
        kind: 'render_crash',
        message: error.message,
        // Both stacks, because they answer different questions: the JS stack
        // says which code threw, the component stack says where in the tree
        // it was mounted.
        detail: [error.stack, info.componentStack].filter(Boolean).join('\n\n') || null,
        context: { label: this.props.label },
      })
      // Same rule as `reportError`: a failed report stops at the console. A
      // crash reporter that reports its own failures never stops.
      .catch((reportErr) => {
        console.error('orbital: failed to record a render crash', reportErr)
      })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div
        role="alert"
        className="flex h-full flex-col items-start justify-center gap-2 p-4 font-mono text-xs text-red-300"
      >
        <span className="tracking-[0.1em]">⚠ {this.props.label} crashed</span>
        <span className="max-w-full break-words text-[11px] text-red-300/70">{error.message}</span>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-md border border-red-400/30 bg-red-400/10 px-2.5 py-1 text-[11px] text-red-200 hover:bg-red-400/20"
        >
          Reload
        </button>
      </div>
    )
  }
}
