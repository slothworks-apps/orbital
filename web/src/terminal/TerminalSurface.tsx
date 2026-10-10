import { Suspense, lazy, useEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { terminalCursor, terminalCursorBlink } from '../lib/experimental'
import { shortenPath } from '../lib/format'
import { shortcutLabel } from '../lib/keymap'
import { tagColor, workingDirOf } from '../lib/types'
import type { ApiSession, Tag } from '../lib/types'
import { useEscapeLayer } from '../ui/escapeLayer'
import { toggleTerminalShown } from './actions'
import { TERMINAL_BG } from './palette'
import { useTerminals } from './store'
import { tabLabels, tabRunning } from './tabs'
import type { TerminalInfo } from './types'
import type { TerminalLook } from './runtime'

/** xterm and its CSS load with the first terminal shown, not with the app. */
const TerminalView = lazy(() => import('./TerminalView'))

/** 48a/48d: the hue dot's fallback, the accent's own hue. */
const ACCENT_HUE = 205
/** 48e: a tab is never wider than this; its label ellipsises inside. */
const TAB_MAX_PX = 180

/** The session's one tag, as the detail panel picks it (canvas 1b). */
function sessionHue(session: ApiSession | undefined, tags: Tag[]): number {
  if (!session) return ACCENT_HUE
  for (const id of session.tagIds) {
    const tag = tags.find((t) => t.id === id)
    if (tag) return tag.hue
  }
  return tags.find((t) => t.is_default === 1)?.hue ?? ACCENT_HUE
}

/** `HH:MM`, the closing line's time (48d). */
function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 48a's × glyph: two hairlines, crossed. */
function CloseGlyph() {
  return (
    <span aria-hidden className="relative block h-[7px] w-[7px]">
      <span className="absolute top-0 left-1/2 -ml-[0.6px] h-full w-[1.2px] rotate-45 rounded-[1px] bg-current" />
      <span className="absolute top-0 left-1/2 -ml-[0.6px] h-full w-[1.2px] -rotate-45 rounded-[1px] bg-current" />
    </span>
  )
}

/**
 * × on a busy tab asks once, anchored under the tab rather than as a modal
 * (48d). Keep running is the default: it has focus, so ⏎ keeps, and ⎋ keeps
 * too. A click anywhere else keeps as well.
 */
function CloseQuestion({ tab, label }: { tab: TerminalInfo; label: string }) {
  const keepRef = useRef<HTMLButtonElement | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const keep = () => {
    const terminals = useTerminals.getState()
    terminals.cancelClose()
    terminals.requestFocus(tab.id)
  }
  useEscapeLayer(true, keep)
  useEffect(() => {
    keepRef.current?.focus()
    const onPointerDown = (e: PointerEvent) => {
      if (boxRef.current && e.target instanceof Node && !boxRef.current.contains(e.target)) {
        useTerminals.getState().cancelClose()
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [])
  return (
    <div
      ref={boxRef}
      role="alertdialog"
      aria-label={`${label} is still running`}
      className="absolute top-8 -left-0.5 z-[6] flex w-[318px] flex-col gap-2.5 rounded-[10px] border border-[rgba(150,205,255,.16)] bg-[rgba(10,16,28,.96)] p-3.5 font-sans whitespace-normal shadow-[0_24px_60px_rgba(0,0,0,.6)]"
    >
      <div className="text-[13px] font-semibold text-[#e8eef8]">{label} is still running</div>
      <div className="text-[12px] leading-[1.5] text-[rgba(200,214,235,.85)] [text-wrap:pretty]">
        Closing the tab ends its shell and stops what runs in it. Hiding the terminal or switching session
        keeps it running.
      </div>
      <div className="mt-0.5 flex items-center gap-2">
        <button
          ref={keepRef}
          type="button"
          onClick={keep}
          className="cursor-pointer rounded-[7px] border border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)] px-3 py-1.5 text-[12px] font-bold text-[#e8eef8] shadow-[0_0_0_2px_oklch(85%_.12_205_/_.45)] focus-visible:outline-none"
        >
          Keep running
        </button>
        <button
          type="button"
          onClick={() => void useTerminals.getState().close(tab.id)}
          className="cursor-pointer rounded-[7px] border border-[rgba(150,205,255,.14)] bg-transparent px-3 py-1.5 text-[12px] font-semibold text-[rgba(200,220,245,.85)] hover:border-[rgba(150,205,255,.3)] hover:text-[#e8eef8]"
        >
          Stop and close
        </button>
        <span className="flex-1" />
        <span className="font-mono text-[10px] text-[rgba(160,190,225,.5)]">⏎ keep</span>
      </div>
    </div>
  )
}

/** One tab of the strip (48a, 48e): label, a static dot while busy, the exit code once ended, ×. */
function Tab({
  tab,
  label,
  active,
  confirming,
  onPick,
}: {
  tab: TerminalInfo
  label: string
  active: boolean
  confirming: boolean
  onPick: () => void
}) {
  const exited = tab.exitCode !== null
  // Exit codes share one ink whatever the number (48e: "killed · same ink as 0").
  const ink = active ? 'text-[#e8eef8]' : exited ? 'text-[rgba(160,190,225,.5)]' : 'text-[rgba(160,190,225,.75)]'
  return (
    <div
      className={[
        'relative flex h-[26px] min-w-0 shrink items-center gap-0.5 rounded-md border py-0 pr-[3px] pl-2.5 font-mono text-[11px] whitespace-nowrap',
        active
          ? 'border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)]'
          : 'border-transparent bg-transparent hover:bg-[rgba(150,205,255,.07)]',
        ink,
      ].join(' ')}
      style={{ maxWidth: TAB_MAX_PX }}
    >
      <button
        type="button"
        title={exited ? `${label} · exit ${tab.exitCode}` : label}
        onClick={onPick}
        className="flex h-6 min-w-0 cursor-pointer items-center gap-[7px] border-0 bg-transparent p-0 pr-1 font-[inherit] text-inherit"
      >
        {/* Static: something runs, not that something is new (48c). */}
        {tabRunning(tab) && (
          <span aria-hidden className="block h-[5px] w-[5px] shrink-0 rounded-full bg-[rgba(200,220,245,.7)]" />
        )}
        <span className="min-w-0 truncate">{label}</span>
        {exited && <span className="shrink-0 text-[rgba(160,190,225,.5)]">· exit {tab.exitCode}</span>}
      </button>
      <button
        type="button"
        aria-label="Close tab"
        title={`Close tab · ${shortcutLabel('terminal.close-tab')}`}
        onClick={() => useTerminals.getState().requestClose(tab.id)}
        className="grid h-[18px] w-[18px] shrink-0 cursor-pointer place-items-center rounded border-0 bg-transparent p-0 text-[rgba(200,220,245,.55)] hover:bg-[rgba(150,205,255,.12)] hover:text-[#e8eef8]"
      >
        <CloseGlyph />
      </button>
      {confirming && <CloseQuestion tab={tab} label={label} />}
    </div>
  )
}

export type TerminalVariant = 'dock' | 'side' | 'window'

/**
 * The terminal itself, the same in every placement (48c, 48d): the tab
 * strip, the active tab's terminal on its opaque body, and the closing line
 * of an exited shell. The dock, the side panel and a detached window's dock
 * frame it; `variant` only changes what the frame needs from it.
 *
 * Nothing here marks a tab that printed while hidden — no dot, count, blink
 * or motion ([[why-orbital]] § Calm).
 */
export function TerminalSurface({ sessionId, variant }: { sessionId: string; variant: TerminalVariant }) {
  const tabs = useTerminals(useShallow((s) => s.tabs[sessionId] ?? []))
  const activeId = useTerminals((s) => s.active[sessionId] ?? null)
  const confirmClose = useTerminals((s) => s.confirmClose)
  const size = useTerminals((s) => (activeId ? s.sizes[activeId] : undefined))
  const exitedAt = useTerminals((s) => (activeId ? s.exitedAt[activeId] : undefined))
  const session = useOrbital((s) => s.sessions[sessionId])
  const tags = useOrbital(useShallow((s) => s.tags))
  const cursor = useOrbital((s) => terminalCursor(s.settings))
  const blink = useOrbital((s) => terminalCursorBlink(s.settings))
  const look = useMemo<TerminalLook>(() => ({ cursor, blink }), [cursor, blink])

  const labels = tabLabels(tabs)
  const active = tabs.find((t) => t.id === activeId) ?? null
  const ended = active && active.exitCode !== null ? active : null
  const endedAt = ended ? (ended.exitedAt ?? exitedAt) : undefined
  const toggle = shortcutLabel('terminal.toggle')

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className={[
          'relative z-[2] flex flex-none items-center gap-1 border-b border-[rgba(150,205,255,.1)] pr-2.5 pl-3.5',
          variant === 'side' ? 'h-11' : 'h-10 pt-0.5',
        ].join(' ')}
      >
        <span
          aria-hidden
          title={session ? `Terminals of the session ${session.title}` : undefined}
          className="mr-2 block h-1.5 w-1.5 flex-none rounded-full"
          style={{ background: tagColor(sessionHue(session, tags)) }}
        />
        {tabs.map((tab, i) => (
          <Tab
            key={tab.id}
            tab={tab}
            label={labels[i]}
            active={tab.id === activeId}
            confirming={confirmClose === tab.id}
            onPick={() => {
              useTerminals.getState().pick(sessionId, tab.id)
              useTerminals.getState().requestFocus(tab.id)
            }}
          />
        ))}
        <button
          type="button"
          aria-label="New tab"
          title={`New tab · ${shortcutLabel('terminal.new-tab')}`}
          onClick={() => void useTerminals.getState().open(sessionId)}
          className="ml-0.5 grid h-[26px] w-[26px] flex-none cursor-pointer place-items-center rounded-md border-0 bg-transparent p-0 font-mono text-[15px] leading-none text-[rgba(200,220,245,.7)] hover:bg-[rgba(150,205,255,.09)] hover:text-[#e8eef8]"
        >
          +
        </button>
        <span className="min-w-0 flex-1" />
        {/* The side panel says it in its footer instead (48b). */}
        {variant !== 'side' && (
          <span className="flex-none font-mono text-[10px] tracking-[0.06em] whitespace-nowrap text-[rgba(160,190,225,.5)]">
            yours · not sent to the agent
          </span>
        )}
        {size && (
          <span
            className={[
              'flex-none font-mono text-[10px] whitespace-nowrap text-[rgba(160,190,225,.45)]',
              variant !== 'side' ? 'ml-3' : '',
            ].join(' ')}
          >
            {size.cols} × {size.rows}
          </span>
        )}
        <button
          type="button"
          onClick={() => toggleTerminalShown(sessionId)}
          className="ml-2 h-6 flex-none cursor-pointer rounded-md border-0 bg-transparent px-2 font-mono text-[10px] tracking-[0.06em] whitespace-nowrap text-[rgba(200,220,245,.7)] hover:bg-[rgba(150,205,255,.09)] hover:text-[#e8eef8]"
        >
          hide {toggle}
        </button>
      </div>

      <div
        className={[
          'flex min-h-0 flex-1 flex-col pt-2 pr-3.5 pb-2.5 pl-3.5 font-mono text-[12.5px] leading-5 text-[#d3deef]',
          variant === 'dock' ? 'rounded-b-[13px]' : '',
        ].join(' ')}
        style={{ background: TERMINAL_BG }}
      >
        <div className="min-h-0 flex-1">
          {active && (
            <Suspense fallback={null}>
              <TerminalView key={active.id} id={active.id} look={look} />
            </Suspense>
          )}
        </div>
        {ended && (
          // 48d: one neutral line, whatever the code.
          <div className="mt-1.5 flex flex-none items-center gap-3 border-t border-[rgba(150,205,255,.12)] pt-2 text-[11px] leading-[18px] text-[rgba(160,190,225,.7)]">
            <span>
              shell ended · exit {ended.exitCode}
              {endedAt !== undefined && endedAt !== null ? ` · ${clock(endedAt)}` : ''}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => void useTerminals.getState().restart(ended.id)}
              className="cursor-pointer rounded-[5px] border border-[rgba(150,205,255,.14)] bg-transparent px-2 py-0.5 font-mono text-[10.5px] text-[rgba(200,220,245,.85)] hover:border-[rgba(150,205,255,.3)] hover:text-[#e8eef8]"
            >
              ⏎ new shell here
            </button>
            <span className="text-[rgba(160,190,225,.45)]">{shortcutLabel('terminal.close-tab')} close tab</span>
          </div>
        )}
      </div>

      {variant === 'side' && (
        <div className="flex h-[30px] flex-none items-center gap-2 rounded-b-[13px] border-t border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.6)] px-3.5 font-mono text-[10px] tracking-[0.06em] text-[rgba(160,190,225,.5)]">
          your shell · not sent to the agent
          <span className="flex-1" />
          {session ? shortenPath(workingDirOf(session)) : ''}
        </div>
      )}
    </div>
  )
}
