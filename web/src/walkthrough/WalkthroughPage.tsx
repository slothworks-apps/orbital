import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { WalkthroughCrumbScreen } from '../lib/pageCrumbs'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { PageBar } from '../ui/PageBar'
import { CloseScreen } from './CloseScreen'
import { Cover } from './Cover'
import { midTurn, nextScreen, prevScreen, settleScreen, type Screen } from './derive'
import { StepScreen } from './StepScreen'
import { useWalkthrough } from './useWalkthrough'

/**
 * `/walkthrough/<id>` — the session's file changes, in order, one screen at a
 * time: cover, steps, close (spec: 2026-09-23-walkthrough-design § The page).
 */
export function WalkthroughPage({ id }: { id: string }) {
  const data = useWalkthrough(id)
  const [chosen, setScreen] = useState<Screen>({ kind: 'cover' })
  const stepKey = data.walkthrough?.steps.map((s) => s.id).join('\n') ?? ''
  // Keyed on the ids themselves, so a refetch that changes nothing about the
  // steps leaves the key handler below alone.
  const stepIds = useMemo(() => (stepKey ? stepKey.split('\n') : []), [stepKey])
  // The step being read never moves when the walkthrough grows (spec § The
  // page): the screen names its step by id and the index follows it.
  const screen = settleScreen(chosen, stepIds)

  // ⏎ start · → / ← step (canvas 21a); esc and ⌘[ are the page bar's. The
  // question field stops propagation, so typing never steps; Enter on a
  // focused control is that control's own press, not a start. A chord (⌘←,
  // ⌥→) is the browser's or the system's, never a step.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.altKey || e.ctrlKey) return
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      const onControl = target?.closest('button, a') != null
      if (e.key === 'ArrowRight' || (e.key === 'Enter' && screen.kind === 'cover' && !onControl)) {
        setScreen((s) => nextScreen(s, stepIds))
      }
      if (e.key === 'ArrowLeft') setScreen((s) => prevScreen(s, stepIds))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [screen.kind, stepIds])

  // One bar over every screen, the notices included, so esc and ⌘[ work from
  // all of them (canvas `Feature - Page headers` 25d). WALKTHROUGH is the
  // cover, which is page state rather than a path: a plain click or ⌘[ goes
  // there without a reload. Until the session is known, its crumb reads the
  // head of its id.
  const crumbScreen: WalkthroughCrumbScreen =
    screen.kind === 'step' ? { kind: 'step', n: stepIds.indexOf(screen.id) + 1, total: stepIds.length } : screen
  const bar = (
    <PageBar
      route={{ page: 'walkthrough', id, title: data.session?.title ?? id.slice(0, 8), screen: crumbScreen }}
      surface="columns"
      session={data.session}
      // The walkthrough may grow under the reader (spec
      // 2026-09-23-walkthrough-design § The page).
      notice={data.session && midTurn(data.session) ? 'session working · steps may be added' : null}
      onCrumb={{ walkthrough: () => setScreen({ kind: 'cover' }) }}
    />
  )

  if (data.error === 'not_found') {
    return (
      <Shell bar={bar}>
        <Notice>This session is not known to Orbital.</Notice>
      </Shell>
    )
  }
  if (data.error === 'failed' && !data.walkthrough) {
    return (
      <Shell bar={bar}>
        <Notice>
          The walkthrough could not be loaded.{' '}
          <button type="button" onClick={data.refetch} className="underline">
            Try again
          </button>
        </Notice>
      </Shell>
    )
  }
  if (!data.walkthrough || !data.session) return <Shell bar={bar} />

  const common = { id, session: data.session, walkthrough: data.walkthrough, onRefetch: data.refetch, bar }
  const jump = (stepId: string) => setScreen({ kind: 'step', id: stepId })
  return (
    <Shell>
      <ErrorBoundary label="Walkthrough">
        {screen.kind === 'cover' && <Cover {...common} onStart={() => setScreen(nextScreen(screen, stepIds))} />}
        {screen.kind === 'step' && (
          <StepScreen
            {...common}
            index={stepIds.indexOf(screen.id)}
            onPrev={() => setScreen(prevScreen(screen, stepIds))}
            onNext={() => setScreen(nextScreen(screen, stepIds))}
            onJump={jump}
          />
        )}
        {/* canvas 21e draws no Previous on the close screen; ← still steps back. */}
        {screen.kind === 'close' && (
          <CloseScreen id={id} session={data.session} walkthrough={data.walkthrough} bar={bar} onJump={jump} />
        )}
      </ErrorBoundary>
    </Shell>
  )
}

/** The page's ground. Each screen places the bar in its own layout; the notices get it from here. */
function Shell({ bar, children }: { bar?: ReactNode; children?: ReactNode }) {
  return (
    <div className="min-h-screen w-screen bg-space text-text-bright">
      {bar}
      {children}
    </div>
  )
}

function Notice({ children }: { children: ReactNode }) {
  return <p className="px-8 py-10 font-mono text-[12px] text-text-muted">{children}</p>
}
