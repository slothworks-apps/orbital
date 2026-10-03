import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  useOrbital,
  clampDetailPanelWidth,
  parseDetailPanelWidth,
  parseContextThresholds,
  headerSessionStats,
  resolvePanelPairWidths,
  resolveWindowPanelWidths,
  DETAIL_PANEL_DEFAULT_PX,
  SUBAGENT_PANEL_DEFAULT_PX,
} from '../store/store'
import {
  contextFractionFor,
  contextLevel,
  contextLevelOklch,
  oklchCss,
  CONTEXT_CRITICAL_OKLCH,
} from '../lib/usage'
import { api } from '../lib/api'
import { GLINT_ACCENT_HUE, TopGlint } from '../ui/TopGlint'
import { openQuestion } from '../lib/questionCard'
import { composerHintFor, composerPlaceholderFor } from '../lib/decisionCard'
import { reportError } from '../lib/errors'
import { useWindowFocused } from '../lib/useWindowFocused'
import { useViewportWidth } from '../lib/useViewportWidth'
import { Panel, WINDOW_STRIP_INSET_PX } from '../ui/Panel'
import { useEscapeLayer } from '../ui/escapeLayer'
import { useCommand } from '../lib/commands'
import { shortcutLabel } from '../lib/keymap'
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
import { RefreshGlyph, RewindGlyph, UtilityButton } from '../ui/UtilityButton'
import { Tooltip } from '../ui/Tooltip'
import { ModeSwitcher } from './ModeSwitcher'
import { Select } from '../ui/Select'
import type { SelectHandle } from '../ui/Select'
import { Button } from '../ui/Button'
import { Composer } from './Composer'
import { useAttachments } from './useAttachments'
import { useImageDrop } from './useImageDrop'
import { promptWithFiles } from '../lib/attachedFiles'
import { Transcript } from './Transcript'
import { FileViewer } from './FileViewer'
import { StopDialog } from './StopDialog'
import { ClearDialog } from './ClearDialog'
import { EndDialog } from './EndDialog'
import { RewindDialog } from './RewindDialog'
import { cancelRewind, useRewindUi } from '../store/rewind'
import { isRewindCommand } from '../lib/rewind'
import { MCP_COMMAND, isMcpCommand } from '../lib/mcp'
import { useMcpUi } from '../store/mcp'
import { ModelSwitcher } from './ModelSwitcher'
import { SessionStatsRow } from './SessionStatsRow'
import { HarnessPill } from './HarnessPill'
import { harnessUnfinished } from '../lib/harnessSession'
import { SubagentChip } from './SubagentChip'
import { TaskChip } from './TaskChip'
import { PIN_TOOLTIP_DELAY_MS, UtilityStrip } from './UtilityStrip'
import { endedFootnote, formatContextWindow, formatTokens } from '../lib/format'
import { contextWindowFor } from '../lib/models'
import { COMPACTING_PLACEHOLDER, compactConfirmCount, compactingOf, formatElapsed } from '../lib/compaction'
import { useNow } from '../lib/useNow'
import { useCompactionUi } from '../store/compaction'
import { harnessEnabled, walkthroughEnabled } from '../lib/experimental'
import { gateWaits, isReadOnly, sessionStateKey, tagColor } from '../lib/types'
import type { ApiSession, BackgroundTask, Tag, WalkthroughSummary } from '../lib/types'

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
const ACCENT_HUE = GLINT_ACCENT_HUE

/**
 * The title's type, from `Feature - Detail header` 9d's row 2. One object
 * because the resting clamp and the editing textarea have to render at
 * identical metrics — a swap that moved the text by a pixel would read as a
 * jump — and the auto-grow below measures in these same units.
 */
/** Canvas 26c: the session column from which the subagent and ▣ chips both fit in their full form. */
const CHIPS_FULL_MIN_PX = 540
const NO_TASKS: readonly BackgroundTask[] = []
const TITLE_FONT_PX = 22
const TITLE_LINE_HEIGHT = 1.15
const TITLE_TYPE = {
  fontSize: `${TITLE_FONT_PX}px`,
  fontWeight: 700,
  lineHeight: TITLE_LINE_HEIGHT,
  letterSpacing: '-0.015em',
} as const

/** 9e: the field grows to this many lines, and only then truncates. */
const TITLE_MAX_LINES = 2

/** What the title reads before a session has a name — the resting title is a
 * button, and a button with no text has no accessible name either. */
const UNTITLED = 'Untitled session'

/** Placeholder for a session whose context nothing has measured yet — a
 * fresh session against a known window reads "— / 200k ctx" rather than
 * inventing a zero. */
const NO_VALUE = '—'

/** The unmeasured read-out and its note (canvas 1b-alt): deliberately NOT the
 * session's hue, so an em dash cannot be mistaken for a reading. */
const UNMEASURED_INK = 'rgba(150,205,255,.3)'
/**
 * The gauge while the session compacts (26c/26e): the old number held at .55,
 * the bar greyed like the map's arc, and a note that says why.
 */
const COMPACTING_READOUT_INK = 'rgba(200,215,235,.55)'
const COMPACTING_BAR_INK = 'rgba(200,215,235,.3)'
const COMPACTING_NOTE_INK = 'rgba(160,190,225,.6)'

/**
 * Right-hand detail panel (artboard 1b, header re-cut by `Feature - Detail
 * header` 9d): the header (path + actions, editable title, tag chips,
 * permission/status badges, context bar),
 * the session's transcript, and a footer that varies
 * by session kind — a prompt composer for web/ended sessions, or a read-only
 * bar for a session still live in a terminal (which this UI can never take
 * over; the server's 409 on `POST .../messages` is the real backstop).
 *
 * `standalone` is the panel alone in a detached desktop window (spec:
 * 2026-09-23-detached-session-windows-design; canvas `Feature - Detached
 * window` 22b–22d): it fills the window in the window's own chrome, has no
 * resize handle and no slide-in (the window's own opening is the entrance),
 * its row 1 is the title bar, and it has no close control — the window's is
 * the only one.
 *
 * `hidden` is a standalone panel kept mounted under a swapped-in subagent
 * panel (spec: 2026-09-24-subagent-list-design § 4): nothing of it is on
 * screen, so none of its session commands answer a key.
 */
export function DetailPanel({
  standalone = false,
  hidden = false,
}: { standalone?: boolean; hidden?: boolean } = {}) {
  const selectedId = useOrbital((s) => s.ui.selectedId)
  // What a standalone panel is as wide as, what the path line budgets its
  // characters against, and the viewport every docked width is clamped to.
  const windowWidth = useViewportWidth()
  const windowFocused = useWindowFocused(standalone)
  // The panel keeps rendering the OUTGOING session while it slides away —
  // deselecting clears `selectedId` immediately, and without holding the last
  // one the panel would empty itself and then animate an empty shell out.
  const lastId = useRef<string | null>(selectedId)
  if (selectedId) lastId.current = selectedId
  const id = selectedId ?? lastId.current
  // A session that left for a window of its own did not close — it moved —
  // so the docked panel goes in the same frame, with no exit (canvas
  // `Feature - Detached window` 22a, DETACHING). An ordinary close still
  // slides away.
  const movedToWindow = useOrbital((s) => id != null && s.detachedIds.includes(id))
  const { mounted, state: presence } = usePresence(
    selectedId != null,
    PANEL_ENTER_MS,
    movedToWindow ? 0 : PANEL_EXIT_MS
  )
  const session = useOrbital((s) => (id ? s.sessions[id] : undefined))
  const tags = useOrbital(useShallow((s) => s.tags))
  const settings = useOrbital(useShallow((s) => s.settings))
  const models = useOrbital(useShallow((s) => s.models))
  const contextWindows = useOrbital(useShallow((s) => s.contextWindows))
  const dialog = useOrbital((s) => s.ui.dialog)
  const setDialog = useOrbital((s) => s.setDialog)
  const sendPrompt = useOrbital((s) => s.sendPrompt)
  /** The editor on this session's workspace, and this session's own × (spec
   * 2026-09-23-ide-bridge-design § The slot and the lip). */
  const ide = useOrbital((s) => (id ? (s.sessions[id]?.ide ?? null) : null))
  const ideDismissedId = useOrbital((s) => (id ? s.ideDismissed[id] : undefined))
  const dismissIdeSelection = useOrbital((s) => s.dismissIdeSelection)
  const setSessionPinned = useOrbital((s) => s.setSessionPinned)
  // The question this session is stopped on, and what has been answered of it
  // so far (spec: 2026-09-20-interactive-decisions-design § Web UI).
  const pendingDecision = useOrbital((s) => (id ? s.pendingDecisions[id] : undefined))
  const decisionAnswers = useOrbital((s) =>
    pendingDecision?.kind === 'question' ? s.decisionAnswers[pendingDecision.id] : undefined,
  )

  // A compaction running in this session (spec
  // 2026-09-28-context-compaction-design): the chip counts it up, the gauge
  // greys, and the composer locks until it ends.
  const compacting = session ? compactingOf(session) : null
  const compactingNow = useNow(compacting !== null)
  const composerLocked = session?.source === 'web' && session.compacting != null

  const [titleDraft, setTitleDraft] = useState('')
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const titleFieldRef = useRef<HTMLTextAreaElement | null>(null)
  // Escape must not save: the blur it causes would still be holding the
  // edited draft. Cleared on the way IN rather than on the way out, so a
  // cancel that never produced a blur cannot poison the next edit.
  const titleAbandoned = useRef(false)
  const [retitling, setRetitling] = useState(false)
  // Per session and in the store, so leaving for another session and coming
  // back does not lose a half-written message.
  const prompt = useOrbital((s) => (id ? (s.composerDrafts[id] ?? '') : ''))
  const setComposerDraft = useOrbital((s) => s.setComposerDraft)
  const setPrompt = (text: string) => {
    if (id) setComposerDraft(id, text)
  }

  // Rewind (spec 2026-09-29-rewind-design; canvas `Feature - Rewind v2`
  // 27a/27b). The pending rewind is the server's; once this tab has sent it,
  // the strip and the marker go at once rather than when the CLI answers.
  const rewindSending = useOrbital((s) => (id ? Boolean(s.rewindSending[id]) : false))
  const rewindPending = rewindSending ? null : (session?.rewindPending ?? null)
  const picking = useRewindUi((s) => id != null && s.pick === id)
  const rewindPicked = useRewindUi((s) => (id != null && s.picked?.sessionId === id ? s.picked : null))
  const leavePick = useRewindUi((s) => s.leavePick)
  const togglePick = useRewindUi((s) => s.togglePick)
  // Pick mode belongs to the session it was entered for, and ends when that
  // session gets a pending rewind or a terminal takes it over.
  useEffect(() => {
    leavePick()
  }, [id, leavePick])
  const terminalHeld = session ? isReadOnly(session) : false
  useEffect(() => {
    if (rewindPending || terminalHeld) leavePick()
  }, [rewindPending, terminalHeld, leavePick])
  // Esc leaves pick mode before it reaches anything further out.
  useEscapeLayer(picking && !hidden, leavePick)

  // Image intake (spec: 2026-09-20-composer-design § Image intake). The chips
  // live here rather than inside `Composer` because the Send button below reads
  // them — a turn can be images with no text at all — and because the drop
  // TARGET is the whole panel: "a 418 px well is too small a thing to aim at
  // while holding a file" (canvas 9c-1). The empty-string key is the render
  // before a session is selected, on which nothing can be dropped anyway.
  const attachments = useAttachments(id ?? '')
  const { armed: dropArmed, ref: dropTargetRef } = useImageDrop((files, folders) =>
    attachments.accept(files, 'file', folders),
  )

  // Resizable width (docs/ideas/resizable-detail-panel.md). The store value
  // moves LIVE during the drag — the panel and the map's follow inset track
  // the pointer — and the PATCH goes out once, on release. Same optimistic
  // shape as the Appearance slider; a failed save is recorded and the value
  // stands until reload.
  //
  // `detailWidth` stays the single-panel-clamped NOMINAL width — the value
  // the drag handle's own math starts from and the value that gets PATCHed
  // — unchanged by whether the subagent panel is open (task 8 brief,
  // requirement 1: this clamp must not regress). `renderedDetailWidth` is
  // what the panel is actually drawn at: with the subagent panel open, the
  // pair's 75% ceiling can pull it narrower than `detailWidth` says, which
  // is exactly what keeps a drag that requests more room than the ceiling
  // allows from ever widening the panel past it (spec § 8 "Layout").
  const detailWidth = parseDetailPanelWidth(settings, windowWidth)
  // The side slot holds a subagent or a task's output; either narrows this panel the same way.
  const subagentPanelOpen = useOrbital(
    (s) => s.subagentPanel !== null || s.taskOutput !== null || s.harnessPanel !== null,
  )
  const renderedDetailWidth = subagentPanelOpen
    ? resolvePanelPairWidths(detailWidth, SUBAGENT_PANEL_DEFAULT_PX, windowWidth).detailWidthPx
    : detailWidth
  // A standalone panel is the window's width, or its share of it once the
  // subagent panel sits beside it (`SessionWindow`).
  const standaloneWidth = subagentPanelOpen
    ? resolveWindowPanelWidths(windowWidth).detailWidthPx
    : windowWidth
  const widthDragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  // In the store, not local state: SpaceMap's right-anchored overlays (the
  // aggregate readout, the zoom stack) drop their `right` transition on the
  // same flag, so they track the drag 1:1 alongside the panel.
  const draggingWidth = useOrbital((s) => s.ui.resizingPanel ?? false)
  const setDraggingWidth = (resizingPanel: boolean) =>
    useOrbital.setState((state) => ({ ui: { ...state.ui, resizingPanel } }))

  const setWidthLocal = (width: number) => {
    const value = String(Math.round(clampDetailPanelWidth(width, windowWidth)))
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

  // The prompt draft is keyed by session in the store, so a change of
  // session swaps it rather than clearing it.
  useEffect(() => {
    setIsEditingTitle(false)
    // The chips belong to the draft, so they go with it — and the refs they
    // would have carried are this session's, not the next one's.
    attachments.reset()
    // `attachments` is deliberately absent: `reset` is stable, and listing the
    // object would only re-run this on a render it has nothing to do with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Title draft reseeds whenever the session (or its title) changes, but
  // never while the field is actively being edited — a WS-delivered upsert
  // for the same session must not clobber in-progress keystrokes.
  useEffect(() => {
    if (isEditingTitle) return
    setTitleDraft(session?.title ?? '')
  }, [id, session?.title, isEditingTitle])

  // The walkthrough's entry (spec 2026-09-23-walkthrough-design § The page,
  // canvas 21f): present only for Orbital's own sessions with at least one
  // file change — absent, not disabled. The count comes from the server's
  // summary because the loaded transcript is paged and cannot say whether an
  // older turn wrote. Re-asked when the session settles, so a session that
  // makes its first edit while selected gains the control. "Settled" is
  // status !== 'working' rather than idle/ended: a live Orbital session sits
  // in needs_input between turns (the spec's "Where it is offered"), and
  // that is exactly when a just-finished edit should be picked up. The
  // answer is kept against the session it is for, so a re-ask on settling
  // leaves the control in place instead of blinking it out and back.
  const [walkthroughSummary, setWalkthroughSummary] = useState<{ key: string; summary: WalkthroughSummary } | null>(null)
  const sessionId = session?.id
  const sessionSource = session?.source
  const sessionSettled = session?.status !== 'working'
  const summaryKey = `${sessionId}:${sessionSource}`
  // Behind the Experimental switch (adr walkthrough-sits-behind-an-experimental-switch).
  const walkthroughOn = walkthroughEnabled(settings)
  useEffect(() => {
    if (!walkthroughOn || !sessionId || sessionSource !== 'web') return
    let cancelled = false
    api.walkthroughSummary(sessionId)
      .then((s) => { if (!cancelled) setWalkthroughSummary({ key: `${sessionId}:${sessionSource}`, summary: s }) })
      .catch(() => { /* absent is the honest state when the server cannot say */ })
    return () => { cancelled = true }
  }, [walkthroughOn, sessionId, sessionSource, sessionSettled])
  const walkthroughEntry = walkthroughOn && walkthroughSummary?.key === summaryKey ? walkthroughSummary.summary : null

  // The title field is one line until its own text needs a second, and stops
  // there (9e). On every keystroke, because the height is a function of the
  // text rather than of the element: the browser will not shrink a textarea
  // back on its own, hence the reset to zero before the measurement.
  useEffect(() => {
    const el = titleFieldRef.current
    if (!el) return
    const line = TITLE_FONT_PX * TITLE_LINE_HEIGHT
    el.style.height = '0px'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, line), line * TITLE_MAX_LINES)}px`
  }, [titleDraft, isEditingTitle])

  // The caret lands at the END of the name: the usual edit is fixing or
  // extending the tail, not retyping from the front.
  useEffect(() => {
    if (!isEditingTitle) return
    const el = titleFieldRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [isEditingTitle])

  // While the title is being edited, Escape belongs to the field — without
  // this it reaches `App` and closes the whole panel mid-rename.
  useEscapeLayer(isEditingTitle, () => abandonTitleEdit())

  // The session commands (spec: 2026-09-23-shortcuts-design § 4), each enabled
  // exactly while the control it stands for is on screen — so a key never
  // does what no button offers. `selectedId`, not `session`: the panel keeps
  // drawing the outgoing session while it slides away, and that one is no
  // longer the one the keys are about.
  const tagSelectRef = useRef<SelectHandle>(null)
  /** Row 4, the header's full content width: the subagent list ends on its right edge (canvas 25a). */
  const stateRowRef = useRef<HTMLDivElement | null>(null)
  // A hidden panel draws no control, so it serves no key either.
  const shown = selectedId != null && !hidden ? session : undefined
  // Stop sits in the composer, which a terminal-live session does not get.
  useCommand(
    'session.interrupt',
    () => setDialog('stop'),
    shown?.status === 'working' && !isReadOnly(shown)
  )
  // Clear and End are Orbital's own, as the strip draws them (`UtilityStrip`).
  useCommand('session.clear', () => handleClearClick(), shown?.source === 'web')
  // ⌘⇧H toggles the harness panel, as the pill and the strip button do;
  // terminal sessions cannot take a harness.
  useCommand(
    'session.harness',
    () => {
      if (shown) useOrbital.getState().openHarness(shown.id)
    },
    harnessEnabled(settings) && shown?.source === 'web'
  )
  useCommand(
    'session.end',
    () => setDialog('end'),
    shown?.source === 'web' && shown.status !== 'ended'
  )
  useCommand(
    'session.pin',
    () => {
      if (shown) void setSessionPinned(shown.id, shown.pinnedAt == null)
    },
    shown != null
  )
  useCommand(
    'session.tag',
    () => tagSelectRef.current?.open(),
    shown != null && primaryTag(shown, tags) !== undefined
  )

  // Standalone has nothing to slide away to: it shows whenever its session is
  // selected, which is from the moment the window seats it.
  if ((standalone ? !selectedId : !mounted) || !id) return null

  /** Opens the field. Named rather than inlined so the abandon flag can only
   * ever be cleared here. */
  function beginTitleEdit() {
    titleAbandoned.current = false
    setIsEditingTitle(true)
  }

  /** Escape: put the field away and let the reseed effect above restore the
   * session's own name. */
  function abandonTitleEdit() {
    titleAbandoned.current = true
    setIsEditingTitle(false)
  }

  function commitTitle() {
    setIsEditingTitle(false)
    if (titleAbandoned.current) return
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
    // "Don't ask again" skips straight to what the dialog's only action does:
    // clear and start new. Ending without a successor is End session's job
    // (spec 2026-09-23-end-session-design).
    if (settings.confirm_before_clear === 'false') {
      // The dialog's default, unasked: a harness with steps left goes on in
      // the new session (spec 2026-10-02-harness-redesign-design § 8).
      const carry = harnessUnfinished(useOrbital.getState().harnesses[id])
      void (carry ? api.clearSession(id, true, { carryHarness: true }) : api.clearSession(id, true))
        .then((result) => {
          if (result.sessionId) void useOrbital.getState().select(result.sessionId)
        })
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
  /**
   * `/mcp` picked from the completion popup opens its dialog there and then,
   * not after a second ⏎ (canvas `Feature - MCP dialog` 12d) — but only when
   * the draft is nothing more than the command being typed.
   */
  function handleAcceptAction(insert: string): boolean {
    if (insert !== MCP_COMMAND || attachments.armed) return false
    if (!MCP_COMMAND.startsWith(prompt.trim())) return false
    handleSend(MCP_COMMAND)
    return true
  }

  function handleSend(draft: string = prompt) {
    const text = draft.trim()
    const sessionId = id
    if (!sessionId) return
    if (composerLocked) return
    if (!text && !attachments.armed) return
    // `/rewind` is Orbital's, never the agent's: sent, it opens pick mode
    // (spec 2026-09-29-rewind-design § Behaviour 1). While a rewind is
    // pending it does nothing — Cancel rewind is the way back.
    if (isRewindCommand(text) && !attachments.armed) {
      if (rewindPending) return
      setPrompt('')
      if (!picking) togglePick(sessionId)
      return
    }
    // `/mcp` is Orbital's too: it opens the MCP dialog and nothing is sent —
    // the CLI has no interactive `/mcp` under the SDK, and the server refuses
    // it as a message (spec 2026-10-01-mcp-servers-in-the-session-design
    // § Where it lives).
    if (isMcpCommand(text) && !attachments.armed) {
      setPrompt('')
      useMcpUi.getState().open(sessionId)
      return
    }
    // A turn sent from pick mode ends it.
    leavePick()
    // A `/compact` past running subagents asks first; the draft stays for a
    // Cancel, and the dialog sends it (spec § Confirmation when subagents are
    // running).
    const confirmCount = attachments.armed ? 0 : compactConfirmCount(text, session)
    if (confirmCount > 0) {
      useCompactionUi.getState().setConfirm({ sessionId, text, count: confirmCount })
      return
    }
    setPrompt('')
    if (!attachments.armed) {
      void sendPrompt(sessionId, text)
      return
    }
    void attachments.takeForSend().then(({ images, files }) => {
      // Files ride by path at the end of the text (spec
      // 2026-10-01-file-attachments-design § The wire into the session).
      const outgoing = promptWithFiles(text, files.map((file) => file.path))
      if (images.length > 0) void sendPrompt(sessionId, outgoing, images)
      // Every upload failed after the well was cleared: send the text alone
      // rather than swallowing the turn.
      else if (outgoing) void sendPrompt(sessionId, outgoing)
    })
  }

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
  const showContext = canShowContext && contextWindow !== null
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
    pendingDecision?.kind === 'question' && !isTerminalLive
      ? openQuestion(pendingDecision.input.questions, decisionAnswers ?? {})
      : undefined

  // A permission prompt or a plan approval takes no words as its answer, but
  // typed words are still meant for it — as the CLI's own "no, and tell
  // Claude what to do differently". The composer has to say so before anyone
  // presses ⏎ expecting the opposite (spec
  // 2026-09-23-permission-and-plan-decisions-design § Answering).
  const openVerdictKind =
    pendingDecision && pendingDecision.kind !== 'question' && !isTerminalLive
      ? pendingDecision.kind
      : undefined

  const pinned = session?.pinnedAt != null
  const footNote =
    session?.status === 'ended' ? endedFootnote({ pinned, endedAt: session.endedAt ?? session.lastAt ?? null }) : null

  const sessionTag = session ? primaryTag(session, tags) : undefined
  const headerHue = sessionTag?.hue
  const accent = tagColor(headerHue ?? ACCENT_HUE)
  /** The context fill's glow below the first threshold (canvas 1b-alt). */
  const accentSoft55 = `oklch(80% 0.13 ${headerHue ?? ACCENT_HUE} / 0.55)`
  /** The title's rule while it is being edited (9e-4). */
  const accentSoft70 = `oklch(80% 0.13 ${headerHue ?? ACCENT_HUE} / 0.7)`

  /**
   * The context gauge takes the map arc's colours past the same two
   * thresholds, so "arc colour and sidebar % change at the same values"
   * (canvas 1i's acceptance) holds: green while there is room, amber past
   * the first, red past the second — never the tag hue. Derived from the
   * UNROUNDED fraction, so a bar reading "50%" and an arc at 50.4 % cannot
   * end up on opposite sides of the line.
   */
  /** Where the header carries session stats — the strip, or one icon in the
   * utility row (canvas `Feature - Header gauges` 11c). */
  const statsVariant = headerSessionStats(settings)
  const contextThresholds = parseContextThresholds(settings)
  const contextBarLevel =
    contextFraction === undefined ? undefined : contextLevel(contextFraction, contextThresholds)
  // No level (a count against an unknown window) keeps the session's accent:
  // green would claim there is room when nothing knows that.
  const contextBarOklch = contextBarLevel && contextLevelOklch(contextBarLevel)
  // One ink for the number and the fill (canvas 1b-alt, column A). Unmeasured
  // is its own washed-out ink rather than the accent at low alpha: an em dash
  // in the session's hue reads as a value.
  const contextInk = contextBarOklch ? oklchCss(contextBarOklch) : accent
  // 9d glows the fill at the same .55 in every ink — 1b-alt's dimmer glow
  // past the first threshold did not survive into the implemented header.
  const contextGlow = contextBarOklch ? oklchCss(contextBarOklch, 0.55) : accentSoft55
  /**
   * The right-hand note, present only when the read-out alone would mislead
   * (canvas 1b-alt): a session with no measurement yet, and one measured past
   * its own window — where the bar is pinned full but the numerator is not.
   * Every ordinary fill gets no note at all.
   */
  const contextNote = compacting
    ? { text: 'COMPACTING…', ink: COMPACTING_NOTE_INK }
    : contextFraction === undefined
      ? { text: 'NOT MEASURED YET', ink: UNMEASURED_INK }
      : contextUsed != null && contextWindow !== null && contextUsed > contextWindow
        ? { text: 'OVER WINDOW', ink: oklchCss(CONTEXT_CRITICAL_OKLCH) }
        : undefined

  // The panel has the live question in the store as well as on the
  // snapshot, and the store's copy is the fresher of the two — it hears
  // `decision_pending` directly.
  const stateKey = session
    ? sessionStateKey({ ...session, pendingDecision: pendingDecision ?? session.pendingDecision })
    : 'idle'
  // 26d: once the turn is over and only launched work runs, the badge says
  // WAITING FOR and the chips after it carry the nouns.
  const waiting = stateKey === 'waiting'
  const tasks = session?.backgroundTasks ?? NO_TASKS
  // 26c: both chips at full width need `CHIPS_FULL_MIN_PX` of session column;
  // below it, with both shown, each takes its compact form.
  const columnWidth = standalone ? standaloneWidth : renderedDetailWidth
  const compactChips =
    columnWidth < CHIPS_FULL_MIN_PX && tasks.length > 0 && (session?.subagents.length ?? 0) > 0

  return (
    // 1b paints a faint outer bloom in the session's hue around the panel.
    // Slide wrapper, not `Panel` itself: Panel already declares
    // `transition-[width]`, and a second transition-property utility would
    // resolve by stylesheet order rather than by intent.
    <div
      ref={dropTargetRef}
      data-state={standalone ? 'entered' : presence}
      // The drop target is the panel, not the well (canvas 9c-1). It sits on
      // this wrapper rather than inside `Panel` because the listeners want the
      // outermost element the drag can be over, and the accent border + inset
      // ring below are painted on the same box.
      data-drop-target
      data-drop-armed={dropArmed || undefined}
      // Still painted while it slides away, but no longer a live surface.
      inert={(!standalone && presence === 'exiting') || undefined}
      className={
        standalone
          ? 'relative h-full'
          : [
              'relative h-full',
              PANEL_TRANSITION,
              presence === 'exiting' ? PANEL_EXIT_DURATION : PANEL_ENTER_DURATION,
              presence === 'entered' ? PANEL_OPEN : PANEL_CLOSED,
              presence === 'exiting' ? EXITING : '',
            ].join(' ')
      }
    >
    {/* The harness's drawer handle (canvas `Feature - Harness` 30a-d): on the
        panel's right edge, outside its clipping shell. A detached window's
        edge is the window's own, so there the pill keeps inside it. */}
    {session && (
      <HarnessPill
        session={session}
        stateRowRef={stateRowRef}
        edge={standalone && !subagentPanelOpen ? 'inside' : 'over'}
      />
    )}
    <Panel
      side="right"
      glowHue={headerHue ?? ACCENT_HUE}
      widthPx={renderedDetailWidth}
      widthTransition={!draggingWidth}
      fill={standalone}
      className="relative flex h-full flex-col overflow-hidden"
    >
      {/* Inner-edge drag handle: widen by dragging left, double-click resets
          to the export's 450. Sits above the panel content (z) but inside
          the overflow-hidden shell. A detached window is resized by its own
          frame instead. */}
      {!standalone && (
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
        // `orbital-no-drag`: its top runs under the main window's drag band
        // (canvas `Feature - Main window chrome` 24a), which would take it.
        className="orbital-no-drag absolute inset-y-0 left-0 z-20 w-2 cursor-col-resize touch-none hover:bg-[rgba(150,205,255,.08)]"
      />
      )}
      {/* Top hairline glint in the session's tag hue (canvas 1b). A detached
          window keeps it and dims it while unfocused (22d). */}
      <TopGlint hue={headerHue} focused={windowFocused} />

      {/* Header — `Feature - Detail header` 9d, variant B: a utility strip
          carrying the path and the session's actions, over a title that owns
          the whole next line. Padding 12px 22px 16px over a hairline rule.
          9c-1 steps it back to .4 while a drop is armed, a touch brighter than
          the transcript's .35: it is the session's name, and the marker is the
          only thing that should be competing.
          Docked in the main window, its top lies under the drag band (24a):
          `orbital-band-controls` keeps row 1's buttons and the title field
          clickable there. */}
      <div
        className={[
          'orbital-band-controls border-b border-panel-border px-[22px] pt-3 pb-4',
          dropArmed ? 'opacity-40' : '',
        ].join(' ')}
      >
        {/* Row 1 — the utility strip (9d). The path was already the quietest
            line in the header, so it carries the actions without either of
            them gaining weight, and the title gets the width back (9c,
            DECISION). */}
        {/* In a detached window the row is also the title bar (22b): it
            reaches out over the header's top and side padding so the whole
            band drags the window, and its left inset clears the traffic
            lights. Its controls stay clickable (`orbital-drag-region`). */}
        <div
          className={[
            'flex items-center',
            standalone ? 'orbital-drag-region -mx-[22px] -mt-3 h-10 pt-3 pr-[22px]' : 'h-7',
          ].join(' ')}
          style={standalone ? { paddingLeft: WINDOW_STRIP_INSET_PX } : undefined}
        >
          {/* No `gap` on the row: the strip spaces its own buttons, because
              it animates those spaces when it folds (23d). */}
          <UtilityStrip
            session={session}
            standalone={standalone}
            statsVariant={statsVariant}
            pinned={pinned}
            onTogglePin={() => {
              if (session) void setSessionPinned(session.id, !pinned)
            }}
            onClear={handleClearClick}
            onEnd={() => setDialog('end')}
            onCollapse={() => useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: null } }))}
            walkthroughEntry={walkthroughEntry}
            pathBudgetPx={standalone ? standaloneWidth : detailWidth}
          />
        </div>

        {/* Row 2 — the title, on a line of its own (9d). At rest it is a
            two-line clamp that ellipsises; editing swaps in the textarea it
            grows into, which is the only way to have both (adr
            `the-title-is-read-as-text-and-edited-as-a-field`). */}
        <div className="mt-0.5 flex items-start gap-[7px]">
          <div
            className="flex min-w-0 flex-1 items-start gap-2 border-b pb-[3px]"
            // 9e-4: focus trades the dashed rule for a solid one in the
            // session's own accent, the same signal the caret carries.
            style={{
              borderBottomStyle: isEditingTitle ? 'solid' : 'dashed',
              borderBottomColor: isEditingTitle ? accentSoft70 : 'rgba(150,205,255,.35)',
            }}
          >
            {isEditingTitle ? (
              <textarea
                ref={titleFieldRef}
                aria-label="Session title"
                rows={1}
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    e.currentTarget.blur()
                  }
                }}
                // Scrolls rather than clips past the second line: the clamp
                // is how a title is READ, and a caret you cannot see is not a
                // way to write one.
                className="min-w-0 flex-1 resize-none overflow-y-auto bg-transparent text-text-bright focus:outline-none"
                style={TITLE_TYPE}
              />
            ) : (
              <button
                type="button"
                title="Rename this session"
                onClick={beginTitleEdit}
                className="min-w-0 flex-1 cursor-text text-left text-text-bright transition-opacity duration-200"
                // 9d: the old name stays on screen at 45% while the model
                // writes the new one, so the row neither empties nor jumps.
                style={{ ...TITLE_TYPE, opacity: retitling ? 0.45 : 1 }}
              >
                {/* The clamp lives on a span, not on the button: Chrome
                    blockifies a button's `display` to `flow-root` whatever it
                    is set to, and `-webkit-line-clamp` needs the box it was
                    given. */}
                <span className="line-clamp-2 break-words">{titleDraft || UNTITLED}</span>
              </button>
            )}
            <span
              aria-hidden
              className="mt-1 shrink-0 text-xs"
              style={{ color: isEditingTitle ? 'rgba(160,190,225,.35)' : 'rgba(160,190,225,.6)' }}
            >
              ✎
            </span>
          </div>
          {/* Regenerate the name. It stays attached to the TITLE rather than
              to the session actions above (9a's BEHAVIOUR + RULES) — it is
              the one control that rewrites the thing next to it. Deliberately
              NOT gated on `source === 'web'` the way Clear is: the server
              names a session from the transcript on disk, which a terminal
              session has exactly like a web one. */}
          {session && (
            <Tooltip
              title="Regenerate name"
              description="Names this session from what it has actually been doing."
              align="right"
              delayMs={PIN_TOOLTIP_DELAY_MS}
            >
              <UtilityButton
                variant="title"
                className="mt-0.5"
                active={retitling}
                disabled={retitling}
                aria-label="Regenerate name"
                onClick={handleRetitle}
              >
                <RefreshGlyph spinning={retitling} />
              </UtilityButton>
            </Tooltip>
          )}
        </div>

        {session && (
          <>
            {/* Row 3 — meta (canvas 9d): tag dropdown left, model badge and
                permission dot pushed right; one wrapping row, 6px gap, 14px
                below the title block. The status lives in row 4. */}
            <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
              {sessionTag && (
                <Select
                  ref={tagSelectRef}
                  variant="tag"
                  font="sans"
                  aria-label="Change tag"
                  title={`Change tag · ${shortcutLabel('session.tag')}`}
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
                  hidden={hidden}
                  disabledReason={
                    isTerminalLive ? 'Live in a terminal — Orbital does not own this session' : undefined
                  }
                />
              )}
              <ModeSwitcher session={session} disabled={isTerminalLive} />
            </div>

            {/* Row 4 — status + context (canvas `Feature - Detail header`
                9d): the state chip on the left — outlined in its state colour
                since `Feature - State colours` 24c — and the context read-out
                pushed right. The read-out, and the bar under
                this row, are drawn only when the window is actually known — a
                bar scaled to a made-up denominator is worse than no bar (per
                docs/decisions/models-come-from-the-sdk.md). A terminal
                session never gets either (see `canShowContext`); 9d ends its
                row with a TERMINAL chip instead. */}
            <div ref={stateRowRef} className="mt-3 flex items-center gap-2.5">
              {compacting ? (
                <Badge variant="compacting" elapsed={formatElapsed(compactingNow - compacting.startedAt)} />
              ) : rewindPending ? (
                // Canvas 27b: the state line while a rewind is pending.
                <Badge variant="rewind" />
              ) : (
                <Badge
                  variant="status"
                  // The panel has the live question in the store as well as on
                  // the snapshot, and the store's copy is the fresher of the
                  // two — it hears `decision_pending` directly.
                  state={stateKey}
                  gate={gateWaits(session)}
                />
              )}
              {/* Subagent list spec § 1: the chip is as tall as the badge,
                  so the row does not grow; none at all without subagents.
                  The ▣ chip follows it on the same terms (26a). */}
              <SubagentChip
                sessionId={session.id}
                subagents={session.subagents}
                compact={compactChips}
                waiting={waiting}
                withinRef={stateRowRef}
              />
              <TaskChip
                sessionId={session.id}
                tasks={tasks}
                compact={compactChips}
                waiting={waiting}
                withinRef={stateRowRef}
              />
              <span aria-hidden className="flex-1" />
              {showContext && contextNote && (
                // 9d names the note but draws no state that carries one; it
                // sits just left of the read-out, so the number keeps the
                // row's right edge in every state.
                <span
                  data-context-note
                  className="font-mono text-[9.5px] tracking-[0.16em]"
                  style={{ color: contextNote.ink }}
                >
                  {contextNote.text}
                </span>
              )}
              {showContext && (
                <span
                  data-context-readout
                  data-testid="context-readout"
                  className="flex items-baseline gap-[5px] font-mono"
                >
                  <span
                    className="text-[17px] leading-none tracking-[-0.01em] transition-colors duration-300"
                    style={{
                      color: compacting ? COMPACTING_READOUT_INK : contextUsed != null ? contextInk : UNMEASURED_INK,
                    }}
                  >
                    {/* The measurement itself, NOT the bar's clamped fraction:
                        a session past a mis-learned window says so. */}
                    {contextUsed != null ? formatTokens(contextUsed) : NO_VALUE}
                  </span>
                  <span className="text-[10.5px] text-[rgba(160,190,225,.55)]">
                    / {formatContextWindow(contextWindow)}
                  </span>
                </span>
              )}
              {session.source === 'terminal' && (
                <span
                  data-terminal-chip
                  title="Attached from an external terminal · Orbital measures no context for it"
                  className="rounded-[4px] border border-[rgba(150,205,255,.18)] bg-[rgba(150,205,255,.04)] px-[7px] py-[3px] font-mono text-[9.5px] tracking-[0.16em] text-[rgba(160,190,225,.75)]"
                >
                  TERMINAL
                </span>
              )}
            </div>

            {/* The context bar (9d): a 3px track notched at the two
                thresholds, filled in the same ink as the read-out above. */}
            {showContext && (
              <div className="relative mt-[9px] h-[3px] overflow-hidden rounded-[2px] bg-[rgba(150,205,255,.12)]">
                {contextPercent !== undefined && (
                  <span
                    role="progressbar"
                    aria-label="Context usage"
                    aria-valuenow={contextPercent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    className="block h-full rounded-[2px]"
                    data-context-level={contextBarLevel}
                    style={{
                      width: `${contextPercent}%`,
                      background: compacting ? COMPACTING_BAR_INK : contextInk,
                      boxShadow: compacting ? 'none' : `0 0 8px ${contextGlow}`,
                      transition: 'width .45s ease, background .3s ease',
                    }}
                  />
                )}
                {/* The two notches mark where the ink changes. Positioned
                    from the SETTINGS, not from 9d's literal 50/80 — those are
                    the defaults the artboard happens to draw. */}
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
            )}

            {/* The stats readout (canvas 10g): below the panel's own meta,
                above the transcript, never a coloured button. It sits at the
                foot of the header block rather than directly under the path
                line the artboard draws it under — the real panel has the tag,
                model and usage rows in between, and splitting them from the
                title they belong to would cost more than the artboard's
                literal order buys.

                `Feature - Header gauges` 11b (variant A) took its chip away
                so it lines up with the context gauge, and 11c made it
                optional: button-only drew it into the utility strip above and
                gives the transcript the 42px back. */}
            {statsVariant === 'bar' && <SessionStatsRow session={session} className="mt-3.5" />}
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
          // The well, its editor and its completion popup are
          // `Composer`'s — the same control the New Session dialog mounts
          // (spec: 2026-09-20-composer-design). The action row stays the
          // panel's: Stop and Send belong to a live session, not to a field.
          <Composer
            sessionKey={{ session: id }}
            value={prompt}
            onChange={setPrompt}
            enter="send"
            onSend={handleSend}
            actOnAccept={handleAcceptAction}
            placement="above"
            variant="panel"
            // Canvas 9c: one hint line rewritten while a question is open —
            // ⏎ answers it, it does not start a new turn.
            // Canvas 27a: pick mode and a pending rewind rewrite it too, in
            // the brighter ink, ahead of everything else — they are what ⏎
            // (or a click) does next.
            hint={
              picking || rewindPicked
                ? 'click a message · esc cancels'
                : rewindPending
                  ? '⏎ send — the rewind becomes permanent'
                  : openDecisionQuestion
                ? '⏎ answers the question · ⇧⏎ newline'
                : openVerdictKind
                  ? composerHintFor(openVerdictKind)
                  : '⏎ send · ⇧⏎ newline · ⌘V paste image'
            }
            answering={
              !picking && !rewindPending && (openDecisionQuestion !== undefined || openVerdictKind !== undefined)
            }
            hintBright={picking || rewindPicked !== null || rewindPending !== null}
            emphasized={rewindPending !== null}
            strip={
              picking || rewindPicked ? (
                // Canvas 27a/27c: pick mode's strip. A draft already in the
                // field stays untouched underneath it.
                <>
                  <span className="flex text-accent">
                    <RewindGlyph size="strip" />
                  </span>
                  <span className="text-text-bright">Pick one of your messages to rewind to</span>
                  <span aria-hidden className="flex-1" />
                  <Button variant="strip" size="strip" onClick={leavePick}>
                    Cancel
                  </Button>
                </>
              ) : rewindPending ? (
                // Canvas 27a/27c: the pending strip, the only Cancel.
                <>
                  <span className="flex text-accent">
                    <RewindGlyph size="strip" />
                  </span>
                  <span className="text-text-bright">Rewound</span>
                  <span aria-hidden className="text-[rgba(150,205,255,.3)]">
                    ·
                  </span>
                  <span data-rewind-hidden>
                    {rewindPending.hiddenCount} {rewindPending.hiddenCount === 1 ? 'message' : 'messages'} hidden
                  </span>
                  <span aria-hidden className="flex-1" />
                  <Button variant="strip" size="strip" onClick={() => id && void cancelRewind(id)}>
                    Cancel rewind
                  </Button>
                </>
              ) : undefined
            }
            locked={composerLocked}
            // The placeholder names the question's header chip, so with 2–4
            // stacked you know WHICH one you would be answering (canvas 9c).
            placeholder={
              composerLocked
                ? COMPACTING_PLACEHOLDER
                : openDecisionQuestion
                ? `Answer ${openDecisionQuestion.header}, or pick an option above…`
                : openVerdictKind
                  ? composerPlaceholderFor(openVerdictKind)
                  : promptPlaceholder
            }
            aria-label="Prompt"
            // Ambient, optional and silent about every kind of absence: no
            // editor, an editor on another project, a socket that dropped —
            // each draws nothing and changes nothing else about the composer.
            ide={ide}
            ideDismissedId={ideDismissedId}
            onIdeDismiss={(selectionId) => id && dismissIdeSelection(id, selectionId)}
            attachments={attachments}
            dropArmed={dropArmed}
            // In a hint row narrower than 440px (a narrow panel) the buttons
            // keep only their glyphs — ■ and ↑ — rather than breaking "Send ↑"
            // over two lines; the words stay as their accessible names.
            actions={
              <>
                {/* Canvas 27a/27c: ↶ left of Send, a 30px chip lit while
                    pick mode is on. Gone while a rewind is pending — Cancel
                    rewind is the way back. */}
                {!rewindPending && (
                  <span className="flex shrink-0">
                    <Tooltip
                      title="Rewind"
                      description="Take the conversation back to before one of your messages. Files on disk stay as they are."
                      align="right"
                      side="above"
                      delayMs={PIN_TOOLTIP_DELAY_MS}
                    >
                      <Button
                        variant={picking || rewindPicked ? 'toggle-on' : 'toggle'}
                        size="icon"
                        aria-label="Rewind to one of your messages"
                        aria-pressed={picking || rewindPicked !== null}
                        disabled={composerLocked}
                        onClick={() => id && togglePick(id)}
                      >
                        <RewindGlyph />
                      </Button>
                    </Tooltip>
                  </span>
                )}
                {session?.status === 'working' && (
                  <Button
                    variant="warning-outline"
                    size="sm"
                    // Stretched to Send's height: without its word, the square
                    // alone would leave Stop a text line shorter.
                    className="shrink-0 self-stretch"
                    aria-label="Stop"
                    title={`Interrupt the run · ${shortcutLabel('session.interrupt')}`}
                    onClick={() => setDialog('stop')}
                  >
                    <span aria-hidden className="h-2 w-2 rounded-[1px] bg-current" />
                    <span className="hidden @min-[440px]:inline">Stop</span>
                  </Button>
                )}
                <Button
                  variant="primary"
                  size="sm"
                  className="shrink-0"
                  aria-label="Send"
                  title="Send"
                  onClick={() => handleSend()}
                  // Live on text OR on one chip that is uploaded or still
                  // uploading; a failed chip alone arms nothing (spec § Send).
                  disabled={composerLocked || (!prompt.trim() && !attachments.armed)}
                >
                  <span>
                    <span className="hidden @min-[440px]:inline">Send </span>↑
                  </span>
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
      />
      <EndDialog open={dialog === 'end'} sessionId={id} onClose={() => setDialog(null)} />
      <RewindDialog sessionId={id} />
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
          'pointer-events-none absolute inset-0 border transition-[border-color,box-shadow] duration-[120ms] ease-in',
          // Square in a detached window, where the panel has no radius (22b).
          standalone ? '' : 'rounded-[14px]',
          dropArmed
            ? 'border-[oklch(85%_.12_205_/_.45)] shadow-[inset_0_0_0_1px_oklch(85%_.12_205_/_.12)]'
            : 'border-transparent',
        ].join(' ')}
      />
    </div>
  )
}
