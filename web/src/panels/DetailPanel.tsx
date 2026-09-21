import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  useOrbital,
  clampDetailPanelWidth,
  parseDetailPanelWidth,
  parseContextThresholds,
  releaseDelayMs,
  DETAIL_PANEL_DEFAULT_PX,
} from '../store/store'
import {
  contextFractionFor,
  contextLevel,
  oklchCss,
  CONTEXT_CRITICAL_OKLCH,
  CONTEXT_WARN_OKLCH,
} from '../lib/usage'
import { api } from '../lib/api'
import { openQuestion } from '../lib/questionCard'
import { reportError } from '../lib/errors'
import { Panel } from '../ui/Panel'
import { usePresence } from '../ui/usePresence'
import {
  PANEL_CLOSED,
  PANEL_ENTER_DURATION,
  PANEL_ENTER_MS,
  PANEL_EXIT_DURATION,
  PANEL_EXIT_MS,
  PANEL_OPEN,
  PANEL_TRANSITION,
  EXITING,
} from '../ui/motion'
import { Badge } from '../ui/Badge'
import { PinButton } from '../ui/PinButton'
import { Tooltip } from '../ui/Tooltip'
import { ModeReadout } from '../ui/ModeDot'
import { Chip } from '../ui/Chip'
import { Select } from '../ui/Select'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Composer } from './Composer'
import { useAttachments } from './useAttachments'
import { useImageDrop } from './useImageDrop'
import { Transcript } from './Transcript'
import { FileViewer } from './FileViewer'
import { StopDialog } from './StopDialog'
import { ClearDialog } from './ClearDialog'
import { ModelSwitcher } from './ModelSwitcher'
import {
  shortenPath,
  formatContextWindow,
  formatDuration,
  releaseFootnote,
} from '../lib/format'
import { contextWindowFor } from '../lib/models'
import { isReadOnly, tagColor } from '../lib/types'
import type { ApiSession, Tag } from '../lib/types'

/**
 * The one tag the session wears — first resolvable id, falling back to the
 * default tag. `tagIds` stays an array because that is the wire shape, but a
 * session carries a single tag (canvas 1b); see the sidebar and the map,
 * which pick their hue the same way.
 */
function primaryTag(session: ApiSession, tags: Tag[]): Tag | undefined {
  for (const tagId of session.tagIds) {
    const tag = tags.find((t) => t.id === tagId)
    if (tag) return tag
  }
  return tags.find((t) => t.is_default === 1)
}

/** Hue the panel's accents fall back to when the session has no tag — the
 * export's own `oklch(85% .12 205)` accent (canvas 1b). */
const ACCENT_HUE = 205

/**
 * How long the pointer rests on the pin before its tooltip appears (canvas
 * 4d). Long enough that crossing the header's action group on the way to ×
 * never raises it.
 */
const PIN_TOOLTIP_DELAY_MS = 400

/** Placeholder for a session whose context nothing has measured yet — a
 * fresh session against a known window reads "— / 200k ctx" rather than
 * inventing a zero. */
const NO_VALUE = '—'

/** The unmeasured read-out and its note (canvas 1b-alt): deliberately NOT the
 * session's hue, so an em dash cannot be mistaken for a reading. */
const UNMEASURED_INK = 'rgba(150,205,255,.3)'

/**
 * Compact token count in the export's own notation — "142.3k", "28.9k",
 * "116k" (canvas 1b's context read-out). Counts under 1k
 * are shown verbatim; a trailing ".0" is dropped.
 */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
}

/**
 * Right-hand detail panel (artboard 1b): editable header (title, cwd, tag
 * chips, permission/status badges, context bar, lineage dots),
 * the session's transcript + live subagents strip, and a footer that varies
 * by session kind — a prompt composer for web/ended sessions, or a read-only
 * bar for a session still live in a terminal (which this UI can never take
 * over; the server's 409 on `POST .../messages` is the real backstop).
 */
export function DetailPanel() {
  const selectedId = useOrbital((s) => s.ui.selectedId)
  const { mounted, state: presence } = usePresence(
    selectedId != null,
    PANEL_ENTER_MS,
    PANEL_EXIT_MS
  )
  // The panel keeps rendering the OUTGOING session while it slides away —
  // deselecting clears `selectedId` immediately, and without holding the last
  // one the panel would empty itself and then animate an empty shell out.
  const lastId = useRef<string | null>(selectedId)
  if (selectedId) lastId.current = selectedId
  const id = selectedId ?? lastId.current
  const session = useOrbital((s) => (id ? s.sessions[id] : undefined))
  const tags = useOrbital(useShallow((s) => s.tags))
  // Off the session itself, like the map's moons — the server keeps it current
  // for every session, not just the open one.
  const subagents = useOrbital(useShallow((s) => (id ? (s.sessions[id]?.subagents ?? []) : [])))
  const settings = useOrbital(useShallow((s) => s.settings))
  const models = useOrbital(useShallow((s) => s.models))
  const contextWindows = useOrbital(useShallow((s) => s.contextWindows))
  const dialog = useOrbital((s) => s.ui.dialog)
  const setDialog = useOrbital((s) => s.setDialog)
  const sendPrompt = useOrbital((s) => s.sendPrompt)
  const setSessionPinned = useOrbital((s) => s.setSessionPinned)
  // The question this session is stopped on, and what has been answered of it
  // so far (spec: 2026-09-20-interactive-decisions-design § Web UI).
  const pendingDecision = useOrbital((s) => (id ? s.pendingDecisions[id] : undefined))
  const decisionAnswers = useOrbital((s) =>
    pendingDecision ? s.decisionAnswers[pendingDecision.id] : undefined,
  )

  const [titleDraft, setTitleDraft] = useState('')
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [retitling, setRetitling] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [lineageCache, setLineageCache] = useState<Record<string, string[]>>({})

  // Image intake (spec: 2026-09-20-composer-design § Image intake). The chips
  // live here rather than inside `Composer` because the Send button below reads
  // them — a turn can be images with no text at all — and because the drop
  // TARGET is the whole panel: "a 418 px well is too small a thing to aim at
  // while holding a file" (canvas 9c-1). The empty-string key is the render
  // before a session is selected, on which nothing can be dropped anyway.
  const attachments = useAttachments(id ?? '')
  const { armed: dropArmed, ref: dropTargetRef } = useImageDrop((files) =>
    attachments.accept(files, 'file'),
  )

  // Resizable width (docs/ideas/resizable-detail-panel.md). The store value
  // moves LIVE during the drag — the panel and the map's follow inset track
  // the pointer — and the PATCH goes out once, on release. Same optimistic
  // shape as the Appearance slider; a failed save is recorded and the value
  // stands until reload.
  const detailWidth = parseDetailPanelWidth(settings, window.innerWidth)
  const widthDragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  // In the store, not local state: SpaceMap's right-anchored overlays (the
  // aggregate readout, the zoom stack) drop their `right` transition on the
  // same flag, so they track the drag 1:1 alongside the panel.
  const draggingWidth = useOrbital((s) => s.ui.resizingPanel ?? false)
  const setDraggingWidth = (resizingPanel: boolean) =>
    useOrbital.setState((state) => ({ ui: { ...state.ui, resizingPanel } }))

  const setWidthLocal = (width: number) => {
    const value = String(Math.round(clampDetailPanelWidth(width, window.innerWidth)))
    useOrbital.setState((state) => ({
      settings: { ...state.settings, detail_panel_width: value },
    }))
    return value
  }

  const saveWidth = (value: string) => {
    api
      .patchSettings({ detail_panel_width: value })
      .catch((err) => reportError(err, 'Failed to save the panel width'))
  }

  const handleWidthPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    widthDragRef.current = { startX: e.clientX, startWidth: detailWidth }
    setDraggingWidth(true)
    // Optional-chained: jsdom has no pointer capture.
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }

  const handleWidthPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = widthDragRef.current
    if (!drag) return
    // Right-docked panel: the pointer moving LEFT widens it.
    setWidthLocal(drag.startWidth + (drag.startX - e.clientX))
  }

  const handleWidthPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = widthDragRef.current
    if (!drag) return
    widthDragRef.current = null
    setDraggingWidth(false)
    saveWidth(setWidthLocal(drag.startWidth + (drag.startX - e.clientX)))
  }

  const handleWidthReset = () => {
    saveWidth(setWidthLocal(DETAIL_PANEL_DEFAULT_PX))
  }

  // Prompt draft is reset ONLY when the selected session actually changes —
  // never on a title/session update for the SAME session (a rename firing
  // mid-draft used to wipe whatever the user had typed; see fix round 2).
  useEffect(() => {
    setPrompt('')
    setIsEditingTitle(false)
    // The chips belong to the draft, so they go with it — and the refs they
    // would have carried are this session's, not the next one's.
    attachments.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `reset` is stable;
    // listing it would only re-run this on a render it has nothing to do with.
  }, [id])

  // Title draft reseeds whenever the session (or its title) changes, but
  // never while the field is actively being edited — a WS-delivered upsert
  // for the same session must not clobber in-progress keystrokes.
  useEffect(() => {
    if (isEditingTitle) return
    setTitleDraft(session?.title ?? '')
  }, [id, session?.title, isEditingTitle])

  // Lazily fetch + cache the lineage chain per session id (component state
  // per the brief — `sessions` doesn't carry `lineage`, only `getSession`
  // returns it, and there's no reason to make every session's row in the
  // store carry a chain nothing else needs).
  useEffect(() => {
    if (!id || lineageCache[id] !== undefined) return
    let cancelled = false
    api
      .getSession(id)
      .then(({ lineage }) => {
        if (!cancelled) setLineageCache((cache) => ({ ...cache, [id]: lineage }))
      })
      .catch(() => {
        // Leave uncached; a future select() of this session can retry.
      })
    return () => {
      cancelled = true
    }
  }, [id, lineageCache])

  if (!mounted || !id) return null

  function invalidateLineage(clearedId: string) {
    setLineageCache((cache) => {
      if (!(clearedId in cache)) return cache
      const next = { ...cache }
      delete next[clearedId]
      return next
    })
  }

  function commitTitle() {
    setIsEditingTitle(false)
    if (!id || !session) return
    const next = titleDraft.trim()
    if (!next || next === session.title) {
      setTitleDraft(session.title)
      return
    }
    const previousTitle = session.title
    useOrbital.setState((state) => {
      const current = state.sessions[id]
      if (!current) return state
      return { sessions: { ...state.sessions, [id]: { ...current, title: next } } }
    })
    api.renameSession(id, next).catch((err) => {
      useOrbital.setState((state) => {
        const current = state.sessions[id]
        if (!current) return state
        return { sessions: { ...state.sessions, [id]: { ...current, title: previousTitle } } }
      })
      setTitleDraft(previousTitle)
      reportError(err, 'Failed to rename session')
    })
  }

  /**
   * Names the session from its own contents, now.
   *
   * Nothing is written here on success: the server publishes the new title on
   * the `sessions` topic, and the draft above reseeds from it. What this does
   * own is the case where the model answers that the current name still fits
   * — silence there would read as a broken button every time it agrees.
   */
  function handleRetitle() {
    if (!id || retitling) return
    setRetitling(true)
    api
      .retitleSession(id)
      .then(({ changed }) => {
        if (changed) return
        useOrbital.setState({
          toast: { kind: 'info', message: 'Name kept — it still fits this session.' },
        })
      })
      .catch((err) => reportError(err, 'Failed to regenerate the name'))
      .finally(() => setRetitling(false))
  }

  /**
   * A session wears exactly one tag (canvas 1b), so picking replaces rather
   * than adds: the PUT carries a single id, which the server turns into one
   * manual row and a `manual_removed` row for every rule tag it displaces.
   */
  function selectTag(tagId: number) {
    if (!id || !session) return
    const previousTagIds = session.tagIds
    if (previousTagIds.length === 1 && previousTagIds[0] === tagId) return
    const nextIds = [tagId]
    useOrbital.setState((state) => {
      const current = state.sessions[id]
      if (!current) return state
      return { sessions: { ...state.sessions, [id]: { ...current, tagIds: nextIds } } }
    })
    api.setSessionTags(id, nextIds).catch((err) => {
      useOrbital.setState((state) => {
        const current = state.sessions[id]
        if (!current) return state
        return { sessions: { ...state.sessions, [id]: { ...current, tagIds: previousTagIds } } }
      })
      reportError(err, 'Failed to change the session tag')
    })
  }

  function handleClearClick() {
    if (!id) return
    if (settings.confirm_before_clear === 'false') {
      void api
        .clearSession(id, false)
        .then(() => invalidateLineage(id))
        .catch((err) => reportError(err, 'Failed to clear session'))
      return
    }
    setDialog('clear')
  }

  /**
   * `Composer` hands over the trimmed text on ⏎; the Send button has none.
   *
   * With no chips this is exactly what it always was — one synchronous call, so
   * a plain turn's timing is untouched. With chips it becomes the queued send
   * (spec § Send): the field and the chip row clear in this frame, and the turn
   * goes out when the last upload settles. A chip that failed is left behind and
   * is not in the turn.
   */
  function handleSend(draft: string = prompt) {
    const text = draft.trim()
    const sessionId = id
    if (!sessionId) return
    if (!text && !attachments.armed) return
    setPrompt('')
    if (!attachments.armed) {
      void sendPrompt(sessionId, text)
      return
    }
    void attachments.takeForSend().then((images) => {
      if (images.length > 0) void sendPrompt(sessionId, text, images)
      // Every upload failed after the well was cleared: send the text alone
      // rather than swallowing the turn.
      else if (text) void sendPrompt(sessionId, text)
    })
  }

  const lineage = lineageCache[id]
  const contextWindow = session ? contextWindowFor(session, models, contextWindows) : null
  const contextUsed = session?.contextUsedTokens ?? null
  // The SAME number the map's arc is drawn from, through the same function —
  // a row field the server persists and republishes, not the live-only
  // `turn_result` event this used to read (adr: context-usage-has-one-source).
  const contextFraction =
    (session ? contextFractionFor(session, models, contextWindows) : null) ?? undefined
  const contextPercent =
    contextFraction !== undefined ? Math.round(contextFraction * 100) : undefined
  // Nothing measures a transcript Orbital only watches, so a terminal
  // session's context bar is permanently unmeasurable — not merely
  // unmeasured yet, the way a fresh web session's is. The owner ruled that a
  // number that can never arrive should not sit there as an em dash either
  // ("pokud terminálové sessions tyhle věci vůbec nevidí, tak bych to
  // skryl"). Same ruling as `contextFillFor`'s `source !== 'web'`; unlike the
  // arc, an ENDED session keeps its last reading here.
  const canShowContext = session?.source !== 'terminal'
  // Same predicate the sidebar badges a row with — one definition, so the
  // mark on the row and the refusal at the composer cannot drift apart.
  const isTerminalLive = session ? isReadOnly(session) : false
  const promptPlaceholder = session?.status === 'ended' ? 'Continue conversation…' : 'Send a message…'

  // The FIRST unanswered question of the pending card, or undefined once the
  // last one is answered — which is what makes the composer revert to a
  // normal reply the moment the card is settled by a click (canvas 9c).
  // A terminal session Orbital only watches can read the question but never
  // answer it, so its composer is unchanged too.
  const openDecisionQuestion =
    pendingDecision && !isTerminalLive
      ? openQuestion(pendingDecision.input.questions, decisionAnswers ?? {})
      : undefined

  const pinned = session?.pinnedAt != null
  // The release delay as the MAP applies it, so the tooltip and the footer
  // quote the same number the body actually falls on.
  const releaseAfterMs = releaseDelayMs(settings)
  const footNote =
    session?.status === 'ended'
      ? releaseFootnote({ pinned, endedAt: session.lastAt ?? null, releaseAfterMs })
      : null

  const sessionTag = session ? primaryTag(session, tags) : undefined
  const headerHue = sessionTag?.hue
  const accent = tagColor(headerHue ?? ACCENT_HUE)
  /** The context fill's glow below the first threshold (canvas 1b-alt). */
  const accentSoft55 = `oklch(80% 0.13 ${headerHue ?? ACCENT_HUE} / 0.55)`

  /**
   * The context gauge takes the map arc's colours past the same two
   * thresholds, so "arc colour and sidebar % change at the same values"
   * (canvas 1i's acceptance) holds: the session's own hue while there is
   * room, amber past the first, red past the second. Derived from the
   * UNROUNDED fraction, so a bar reading "50%" and an arc at 50.4 % cannot
   * end up on opposite sides of the line.
   */
  const contextThresholds = parseContextThresholds(settings)
  const contextBarLevel =
    contextFraction === undefined ? undefined : contextLevel(contextFraction, contextThresholds)
  // Below the first threshold the bar keeps the session's own hue, exactly
  // as it always has — the `ok` level is not a colour of its own.
  const contextBarOklch =
    contextBarLevel === 'warn'
      ? CONTEXT_WARN_OKLCH
      : contextBarLevel === 'critical'
        ? CONTEXT_CRITICAL_OKLCH
        : undefined
  // One ink for the number and the fill (canvas 1b-alt, column A). Unmeasured
  // is its own washed-out ink rather than the accent at low alpha: an em dash
  // in the session's hue reads as a value.
  const contextInk = contextBarOklch ? oklchCss(contextBarOklch) : accent
  // 1b-alt glows the fill at .55 under the first threshold and .5 past it —
  // amber and red carry enough on their own.
  const contextGlow = contextBarOklch ? oklchCss(contextBarOklch, 0.5) : accentSoft55
  /**
   * The right-hand note, present only when the read-out alone would mislead
   * (canvas 1b-alt): a session with no measurement yet, and one measured past
   * its own window — where the bar is pinned full but the numerator is not.
   * Every ordinary fill gets no note at all.
   */
  const contextNote =
    contextFraction === undefined
      ? { text: 'NOT MEASURED YET', ink: UNMEASURED_INK }
      : contextUsed != null && contextWindow !== null && contextUsed > contextWindow
        ? { text: 'OVER WINDOW', ink: oklchCss(CONTEXT_CRITICAL_OKLCH) }
        : undefined

  return (
    // 1b paints a faint outer bloom in the session's hue around the panel.
    // Slide wrapper, not `Panel` itself: Panel already declares
    // `transition-[width]`, and a second transition-property utility would
    // resolve by stylesheet order rather than by intent.
    <div
      ref={dropTargetRef}
      data-state={presence}
      // The drop target is the panel, not the well (canvas 9c-1). It sits on
      // this wrapper rather than inside `Panel` because the listeners want the
      // outermost element the drag can be over, and the accent border + inset
      // ring below are painted on the same box.
      data-drop-target
      data-drop-armed={dropArmed || undefined}
      // Still painted while it slides away, but no longer a live surface.
      inert={presence === 'exiting' || undefined}
      className={[
        'relative h-full',
        PANEL_TRANSITION,
        presence === 'exiting' ? PANEL_EXIT_DURATION : PANEL_ENTER_DURATION,
        presence === 'entered' ? PANEL_OPEN : PANEL_CLOSED,
        presence === 'exiting' ? EXITING : '',
      ].join(' ')}
    >
    <Panel
      side="right"
      glowHue={headerHue ?? ACCENT_HUE}
      widthPx={detailWidth}
      widthTransition={!draggingWidth}
      className="relative flex h-full flex-col overflow-hidden"
    >
      {/* Inner-edge drag handle: widen by dragging left, double-click resets
          to the export's 450. Sits above the panel content (z) but inside
          the overflow-hidden shell. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        aria-valuenow={detailWidth}
        title="Drag to resize · double-click to reset"
        onPointerDown={handleWidthPointerDown}
        onPointerMove={handleWidthPointerMove}
        onPointerUp={handleWidthPointerUp}
        onPointerCancel={handleWidthPointerUp}
        onDoubleClick={handleWidthReset}
        className="absolute inset-y-0 left-0 z-20 w-2 cursor-col-resize touch-none hover:bg-[rgba(150,205,255,.08)]"
      />
      {/* Top hairline glint in the session's tag hue (canvas 1b). */}
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-px"
        style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }}
      />

      {/* Header — canvas 1b: padding 20px 22px 16px over a hairline rule.
          9c-1 steps it back to .4 while a drop is armed, a touch brighter than
          the transcript's .35: it is the session's name, and the marker is the
          only thing that should be competing. */}
      <div
        className={[
          'border-b border-panel-border px-[22px] pb-4 pt-5',
          dropArmed ? 'opacity-40' : '',
        ].join(' ')}
      >
        <div className="flex items-start gap-2.5">
          <div className="min-w-0 flex-1">
            {/* Title reads as an editable value: dashed underline + pencil (1b). */}
            <label className="inline-flex max-w-full items-center gap-2 border-b border-dashed border-[rgba(150,205,255,.35)] pb-0.5">
              <Input
                variant="inline"
                aria-label="Session title"
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onFocus={() => setIsEditingTitle(true)}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    ;(e.target as HTMLInputElement).blur()
                  }
                }}
                // Export values (1b): 19px/700, tracking -.01em, and a field
                // sized to its own value (`width:13ch` for "auth-refactor")
                // so the dashed rule hugs the title instead of running the
                // width of the panel. Inline because each one overrides the
                // primitive's own type scale / `w-full`.
                style={{
                  fontSize: '19px',
                  fontWeight: 700,
                  letterSpacing: '-0.01em',
                  width: `${Math.min(Math.max(titleDraft.length + 1, 6), 34)}ch`,
                }}
                className="min-w-0 truncate"
              />
              <span aria-hidden className="shrink-0 text-xs text-text-muted">
                ✎
              </span>
            </label>
            {session && (
              <div className="mt-2 truncate font-mono text-[11.5px] text-text-muted">
                {shortenPath(session.cwd)}
              </div>
            )}
          </div>
          {lineage && lineage.length > 0 && (
            <span aria-label="Lineage" className="mt-1.5 flex shrink-0 items-center gap-1">
              {lineage.map((ancestorId) => (
                <span key={ancestorId} aria-hidden className="h-1.5 w-1.5 rounded-full bg-text-muted" />
              ))}
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-text-bright" />
            </span>
          )}
          {/* Regenerate the name. Not on the canvas — it borrows 4b's UNPINNED
              chrome verbatim so the header reads as one set of controls rather
              than as a stray button. It is deliberately NOT gated on
              `source === 'web'` the way Clear beside it is: the server names a
              session from the transcript on disk, which a terminal session has
              exactly like a web one. */}
          {session && (
            <Tooltip
              title="Regenerate name"
              description="Names this session from what it has actually been doing."
              align="right"
              delayMs={PIN_TOOLTIP_DELAY_MS}
            >
              <button
                type="button"
                aria-label="Regenerate name"
                disabled={retitling}
                onClick={handleRetitle}
                className={[
                  'grid h-7 w-7 shrink-0 place-items-center rounded-[7px] border ease-[ease]',
                  'transition-[background-color,border-color,color] duration-[180ms]',
                  'border-[rgba(150,205,255,.14)] text-[rgba(200,220,245,.7)]',
                  'hover:border-[rgba(150,205,255,.26)] hover:bg-[rgba(150,205,255,.09)] hover:text-[#dce8f7]',
                  'focus-visible:border-[rgba(150,205,255,.26)] focus-visible:bg-[rgba(150,205,255,.09)] focus-visible:text-[#dce8f7]',
                  'disabled:pointer-events-none disabled:opacity-50',
                ].join(' ')}
              >
                <svg
                  aria-hidden
                  viewBox="0 0 24 24"
                  width="13"
                  height="13"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={retitling ? 'animate-spin' : undefined}
                >
                  <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1.06 6.67 2.7L21 8" />
                  <path d="M21 3v5h-5" />
                </svg>
              </button>
            </Tooltip>
          )}
          {/* 4b: the pin sits left of Clear and ×, and IS the pinned
              indicator — there is no status chip for it; the footer below
              carries the wording. */}
          {session && (
            <Tooltip
              title={pinned ? 'Unpin' : 'Pin'}
              description={
                pinned
                  ? releaseAfterMs == null
                    ? 'The release timer is off.'
                    : `Releases into history ${formatDuration(releaseAfterMs)} after it ended.`
                  : 'Keeps the session on the map — it is never released into history.'
              }
              align="right"
              delayMs={PIN_TOOLTIP_DELAY_MS}
            >
              <PinButton
                size={28}
                pinned={pinned}
                onToggle={() => void setSessionPinned(session.id, !pinned)}
              />
            </Tooltip>
          )}
          {session?.source === 'web' && (
            <Button variant="ghost" size="sm" onClick={handleClearClick}>
              Clear
            </Button>
          )}
          <button
            type="button"
            aria-label="Close panel"
            onClick={() => useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: null } }))}
            // 28px square, 7px radius, 14px glyph (1b).
            className="grid h-7 w-7 shrink-0 place-items-center rounded-[7px] border border-panel-border text-sm text-[rgba(200,220,245,.7)] transition-colors hover:bg-white/5 hover:text-text-bright"
          >
            ×
          </button>
        </div>

        {session && (
          <>
            {/* Tag dropdown left, permission/status chips pushed right (1b:
                one wrapping row, 6px gap, 14px below the title block). */}
            <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
              {sessionTag && (
                <Select
                  variant="tag"
                  font="sans"
                  aria-label="Change tag"
                  value={sessionTag.id}
                  options={tags.map((tag) => ({
                    value: tag.id,
                    label: tag.name,
                    dotColor: tagColor(tag.hue),
                  }))}
                  onChange={selectTag}
                  footer="ONE TAG PER SESSION · SETS PLANET HUE"
                />
              )}
              <span aria-hidden className="flex-1" />
              {(session.model || session.resolvedModel || models.length > 0) && (
                <ModelSwitcher
                  session={session}
                  models={models}
                  defaultValue={settings.default_model ?? null}
                  disabledReason={
                    isTerminalLive ? 'Live in a terminal — Orbital does not own this session' : undefined
                  }
                />
              )}
              {session.permissionMode && <ModeReadout mode={session.permissionMode} />}
              <Badge
                variant="status"
                value={session.status}
                hue={headerHue}
                interrupted={Boolean(session.interruptedAt)}
              />
            </div>

            {/* The context gauge (canvas 1b, states in 1b-alt column A): a
                21px read-out over a 6px track notched at the two thresholds.
                It took over the 16px gap under the badge row when the
                INPUT/OUTPUT/CACHE READ grid was removed from above it (adr
                `context-usage-has-one-source`), which is why the header does
                not shift. Drawn only when the window is actually known — a
                bar scaled to a made-up denominator is worse than no bar (per
                docs/decisions/models-come-from-the-sdk.md).

                1b draws this as a <button> that cycles the demo states; that
                is canvas scaffolding for previewing, not a control the
                product has. */}
            {canShowContext && contextWindow !== null && (
              <div className="mt-4">
                <div
                  data-context-readout
                  data-testid="context-readout"
                  className="flex items-baseline gap-[7px] font-mono"
                >
                  <span
                    className="text-[21px] leading-none tracking-[-0.01em] transition-colors duration-300"
                    style={{ color: contextUsed != null ? contextInk : UNMEASURED_INK }}
                  >
                    {/* The measurement itself, NOT the bar's clamped fraction:
                        a session past a mis-learned window says so. */}
                    {contextUsed != null ? formatTokens(contextUsed) : NO_VALUE}
                  </span>
                  <span className="text-[11px] text-[rgba(160,190,225,.6)]">
                    / {formatContextWindow(contextWindow)} ctx
                  </span>
                  {contextNote && (
                    <>
                      <span aria-hidden className="flex-1" />
                      <span
                        data-context-note
                        className="text-[9.5px] tracking-[0.16em]"
                        style={{ color: contextNote.ink }}
                      >
                        {contextNote.text}
                      </span>
                    </>
                  )}
                </div>
                <div className="relative mt-[9px] h-[6px] overflow-hidden rounded-[3px] bg-[rgba(150,205,255,.12)]">
                  {contextPercent !== undefined && (
                    <span
                      role="progressbar"
                      aria-label="Context usage"
                      aria-valuenow={contextPercent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      className="block h-full rounded-[3px]"
                      data-context-level={contextBarLevel}
                      style={{
                        width: `${contextPercent}%`,
                        background: contextInk,
                        boxShadow: `0 0 10px ${contextGlow}`,
                        transition: 'width .45s ease, background .3s ease',
                      }}
                    />
                  )}
                  {/* The two notches mark where the ink changes. Positioned
                      from the SETTINGS, not from 1b's literal 50/80 — those
                      are the defaults the artboard happens to draw. */}
                  {[contextThresholds.warn, contextThresholds.critical].map((percent) => (
                    <span
                      key={percent}
                      aria-hidden
                      data-context-notch={percent}
                      className="absolute top-0 bottom-0 w-[1.5px] bg-[rgba(4,8,16,.8)]"
                      style={{ left: `${percent}%` }}
                    />
                  ))}
                </div>
              </div>
            )}

            {subagents.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Subagents">
                {subagents.map((agent) => (
                  <Chip
                    key={agent.id}
                    label={`${agent.name} · ${agent.state}`}
                    dot
                    pulse={agent.state === 'working'}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* 9c-1: the transcript drops to .35 for the duration of the drag, so the
          marker is the only lit thing in the panel. */}
      <div
        data-transcript-dim
        className={['min-h-0 flex-1', dropArmed ? 'opacity-35' : ''].join(' ')}
      >
        <Transcript sessionId={id} />
      </div>

      {/* What a restart cost this session (spec
          2026-09-21-session-autoheal-design). Directly over the composer,
          because what it asks for is the next thing typed — and outside the
          transcript, so it cannot scroll away. Borrows the foot note's box
          and the INTERRUPTED chip's white ink, the two treatments this panel
          already uses for "read this" and "a turn stopped". It clears itself
          the moment the session runs a turn again. */}
      {session?.interruptedAt != null && (
        <div
          data-interrupted-banner
          className="mx-[22px] mb-3.5 rounded-[10px] border border-white/25 bg-white/[0.06] px-3.5 py-3 font-mono text-[10.5px] leading-[1.7] text-[rgba(220,235,255,.85)] [text-wrap:pretty]"
        >
          Turn interrupted by a server restart. The conversation is intact — ask again for
          whatever did not come back.
        </div>
      )}

      {/* 4a's foot note: what the pin promises, or how long this session has
          left on the map. Only an ended session has either to say — a live
          one is not going anywhere. */}
      {footNote && (
        <div className="mx-[22px] mb-3.5 rounded-[10px] border border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.45)] px-3.5 py-3 font-mono text-[10.5px] leading-[1.7] text-[rgba(160,190,225,.7)] [text-wrap:pretty]">
          {footNote}
        </div>
      )}

      {/* Composer — canvas 1b: padding 14px 16px 16px over a hairline rule. */}
      <div className="border-t border-panel-border px-4 pb-4 pt-3.5">
        {isTerminalLive ? (
          <div className="rounded-[10px] border border-[rgba(150,205,255,.18)] bg-[rgba(4,8,16,.6)] px-3 py-3 text-center font-mono text-[11.5px] text-text-muted">
            runs in terminal — read-only
          </div>
        ) : (
          // The well, its highlight mirror and its completion popup are
          // `Composer`'s — the same control the New Session dialog mounts
          // (spec: 2026-09-20-composer-design). The action row stays the
          // panel's: Stop and Send belong to a live session, not to a field.
          <Composer
            sessionKey={{ session: id }}
            value={prompt}
            onChange={setPrompt}
            enter="send"
            onSend={handleSend}
            placement="above"
            variant="panel"
            // Canvas 9c: one hint line rewritten while a question is open —
            // ⏎ answers it, it does not start a new turn.
            hint={
              openDecisionQuestion
                ? '⏎ answers the question · ⇧⏎ newline'
                : '⏎ send · ⇧⏎ newline · ⌘V paste image'
            }
            answering={openDecisionQuestion !== undefined}
            // The placeholder names the question's header chip, so with 2–4
            // stacked you know WHICH one you would be answering (canvas 9c).
            placeholder={
              openDecisionQuestion
                ? `Answer ${openDecisionQuestion.header}, or pick an option above…`
                : promptPlaceholder
            }
            aria-label="Prompt"
            attachments={attachments}
            dropArmed={dropArmed}
            actions={
              <>
                {session?.status === 'working' && (
                  <Button variant="warning-outline" size="sm" onClick={() => setDialog('stop')}>
                    <span aria-hidden className="h-2 w-2 rounded-[1px] bg-current" />
                    Stop
                  </Button>
                )}
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => handleSend()}
                  // Live on text OR on one chip that is uploaded or still
                  // uploading; a failed chip alone arms nothing (spec § Send).
                  disabled={!prompt.trim() && !attachments.armed}
                >
                  Send ↑
                </Button>
              </>
            }
          />
        )}
      </div>

      {/* The file viewer mounts HERE, beside the panel's other session-scoped
          overlays (Stop/Clear), because it always belongs to the selected
          session — it needs this session's id for the read and its cwd/title
          for the refusal copy and footer, and `select()` closing it keeps the
          pairing honest. It portals to document.body like the Lightbox, so
          the panel's overflow-hidden shell never clips it. Judgement call:
          the spec only says "over the app"; this is the mount point that
          gets the session without threading it through the store. */}
      {session && <FileViewer session={session} />}
      <StopDialog open={dialog === 'stop'} sessionId={id} onClose={() => setDialog(null)} />
      <ClearDialog
        open={dialog === 'clear'}
        sessionId={id}
        onClose={() => setDialog(null)}
        onCleared={invalidateLineage}
      />
    </Panel>
      {/* The armed panel's chrome (canvas 9c-1 / 9e drop state): accent border
          at .45 over a matching inset ring at .12, arriving over .12s.

          Its own overlay element rather than classes on the wrapper because the
          wrapper already carries `PANEL_TRANSITION`, and a second
          transition-property utility on one element resolves by stylesheet
          order rather than by intent (see web/CLAUDE.md). It matches `Panel`'s
          own 14px radius and never takes the pointer, so the drag still reaches
          the wrapper's listeners. */}
      <div
        aria-hidden
        className={[
          'pointer-events-none absolute inset-0 rounded-[14px] border transition-[border-color,box-shadow] duration-[120ms] ease-in',
          dropArmed
            ? 'border-[oklch(85%_.12_205_/_.45)] shadow-[inset_0_0_0_1px_oklch(85%_.12_205_/_.12)]'
            : 'border-transparent',
        ].join(' ')}
      />
    </div>
  )
}
