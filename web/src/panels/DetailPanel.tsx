import { swatch } from '../lib/palette'
import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  useOrbital,
  clampDetailPanelWidth,
  parseDetailPanelWidth,
  parseContextThresholds,
  headerSessionStats,
  questionComposerTarget,
  resolvePanelPairWidths,
  resolveWindowPanelWidths,
  DETAIL_PANEL_DEFAULT_PX,
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
import { Button } from '../ui/Button'
import { Composer } from './Composer'
import { useAttachments } from './useAttachments'
import { useImageDrop } from './useImageDrop'
import { promptWithFiles } from '../lib/attachedFiles'
import { Transcript } from './Transcript'
import { MediaGallery } from './MediaGallery'
import { useMedia } from '../store/media'
import { FileViewer } from './FileViewer'
import { StopDialog } from './StopDialog'
import { RewindDialog } from './RewindDialog'
import { cancelRewind, useRewindUi } from '../store/rewind'
import { primaryTag } from '../lib/primaryTag'
import {
  askToClear, askToTakeOver, changeTag, regenerateName, renameTaken, useSessionActions,
} from '../store/sessionActions'
import { isRewindCommand } from '../lib/rewind'
import { MCP_COMMAND, isMcpCommand } from '../lib/mcp'
import { useMcpUi } from '../store/mcp'
import { ModelSwitcher } from './ModelSwitcher'
import { SessionStatsRow } from './SessionStatsRow'
import { HarnessPill } from './HarnessPill'
import { DevicePill } from './DevicePill'
import {
  deviceChips, deviceLock, ideHere, localClaudeDirId, machineOffline, namesShown, stateAsOf,
  type DeviceLock,
} from '../lib/devices'
import { SubagentChip } from './SubagentChip'
import { TaskChip } from './TaskChip'
import { PIN_TOOLTIP_DELAY_MS, UtilityStrip } from './UtilityStrip'
import { endedFootnote, formatContextWindow, formatTokens } from '../lib/format'
import { contextWindowFor } from '../lib/models'
import { COMPACTING_PLACEHOLDER, compactConfirmCount, compactingOf, formatElapsed } from '../lib/compaction'
import { useAsOfNow } from '../lib/asOfClock'
import { useNow } from '../lib/useNow'
import { useCompactionUi } from '../store/compaction'
import { harnessEnabled, walkthroughEnabled } from '../lib/experimental'
import { TerminalChip } from '../terminal/TerminalEntry'
import { useSideSlotWidth } from '../terminal/useTerminalHost'
import { canTakeOver, gateWaits, isReadOnly, sessionStateKey, tagColor } from '../lib/types'
import { limitWaitStatus } from '../lib/limits'
import { loginWaitLabels } from '../lib/profileLogin'
import { ClaudeDirChip, useClaudeDirMark } from '../ui/ClaudeDirMark'
import { useClaudeDirModels } from '../lib/useClaudeDirModels'
import type { BackgroundTask, WalkthroughSummary } from '../lib/types'
import { scaledPx, useTextScaleVersion } from '../lib/textScale'

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
  // Times the app's text step (spec 2026-10-27-text-size-design).
  fontSize: scaledPx(TITLE_FONT_PX),
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
const UNMEASURED_INK = swatch('line', 0.3)
/**
 * The gauge while the session compacts (26c/26e): the old number held at .55,
 * the bar greyed like the map's arc, and a note that says why.
 */
const COMPACTING_READOUT_INK = swatch('ink-600', 0.55)
const COMPACTING_BAR_INK = swatch('ink-600', 0.3)
const COMPACTING_NOTE_INK = swatch('ink-900', 0.6)

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
  // The body shows Media instead of Transcript (canvas `Feature - Media` 24d)
  // — for the session it was opened on; another session opens on its transcript.
  const galleryOpen = useMedia((s) => id != null && s.gallery === id)
  const gallery = usePresence(galleryOpen, PANEL_ENTER_MS, PANEL_EXIT_MS)
  useEffect(() => {
    const media = useMedia.getState()
    if (media.gallery !== null && media.gallery !== id) media.setGallery(null)
  }, [id])
  const claudeDirMark = useClaudeDirMark(localClaudeDirId(session))
  // What a session stopped on a lost login waits for (spec
  // 2026-10-21-log-in-from-orbital-design § 3), named by its profile here.
  const loginProfileName = useOrbital((s) => {
    const dirId = session?.loginWait ? localClaudeDirId(session) : null
    return dirId === null ? null : (s.claudeDirs.find((d) => d.id === dirId)?.name ?? null)
  })
  const loginLabels =
    session?.loginWait && session.source !== 'terminal' ? loginWaitLabels(session.loginWait, loginProfileName) : null
  // What the switcher offers is the session's own account's catalog — read
  // from the device it runs on, whose directory ids are its own.
  const switcherModels = useClaudeDirModels(session?.claudeDirId, true, session?.machine?.id)
  const tags = useOrbital(useShallow((s) => s.tags))
  const settings = useOrbital(useShallow((s) => s.settings))
  const models = useOrbital(useShallow((s) => s.models))
  const contextWindows = useOrbital(useShallow((s) => s.contextWindows))
  const dialog = useOrbital((s) => s.ui.dialog)
  const setDialog = useOrbital((s) => s.setDialog)
  const sendPrompt = useOrbital((s) => s.sendPrompt)
  /** The editor on this session's workspace, and this session's own × (spec
   * 2026-09-23-ide-bridge-design § The slot and the lip). */
  const ide = useOrbital((s) => (id ? ideHere(s.sessions[id]) : null))
  const ideDismissedId = useOrbital((s) => (id ? s.ideDismissed[id] : undefined))
  const dismissIdeSelection = useOrbital((s) => s.dismissIdeSelection)
  const setSessionPinned = useOrbital((s) => s.setSessionPinned)
  // The question this session is stopped on, and what has been answered of it
  // so far (spec: 2026-09-20-interactive-decisions-design § Web UI).
  const pendingDecision = useOrbital((s) => (id ? s.pendingDecisions[id] : undefined))
  // Where the pending question card is — a question, or its review — and
  // so what ⏎ in the composer does (spec
  // 2026-10-21-question-card-go-back-design § Composer).
  const questionTarget = useOrbital(
    useShallow((s) => (id ? questionComposerTarget(s, id) : null)),
  )

  // A compaction running in this session (spec
  // 2026-09-28-context-compaction-design): the chip counts it up, the gauge
  // greys, and the composer locks until it ends.
  const compacting = session ? compactingOf(session) : null
  const compactingNow = useNow(compacting !== null)
  const composerLocked = session?.source === 'web' && session.compacting != null

  // Another device of the group (canvas 50f): its pill on the panel's edge,
  // and the lock in the composer's place while it cannot be driven. The
  // clock ticks by the minute only while there is an age to count.
  // Each read off the roster settles to a boolean or a string pair: `remote`
  // is replaced on every status publish, a paired phone's presence included.
  const foreign = session?.machine !== undefined
  const deviceOffline = useOrbital((s) => {
    const x = id ? s.sessions[id] : undefined
    return x ? machineOffline(x, s.remote?.group?.members) : false
  })
  const deviceNow = useAsOfNow(deviceOffline)
  const lock: DeviceLock | null = useOrbital(
    useShallow((s) => {
      const x = id ? s.sessions[id] : undefined
      return x ? deviceLock(x, s.remote?.group?.members, deviceNow) : null
    }),
  )
  const namesOn = useOrbital((s) => namesShown(deviceChips(s.remote?.group?.members), s.ui.hiddenDeviceIds ?? []))
  const showDevicePill = session !== undefined && (foreign || namesOn)
  // Nothing of it was kept here while it was up: once it is back, read it.
  const historyUnkept = useOrbital((s) => (selectedId ? Boolean(s.historyUnkept?.[selectedId]) : false))
  const machineOnline = session?.machine?.online ?? true
  useEffect(() => {
    if (selectedId && historyUnkept && machineOnline) void useOrbital.getState().select(selectedId)
  }, [selectedId, historyUnkept, machineOnline])

  const [titleDraft, setTitleDraft] = useState('')
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const titleFieldRef = useRef<HTMLTextAreaElement | null>(null)
  // Escape must not save: the blur it causes would still be holding the
  // edited draft. Cleared on the way IN rather than on the way out, so a
  // cancel that never produced a blur cannot poison the next edit.
  const titleAbandoned = useRef(false)
  // Whether this session's name is being written — by the button below or
  // by the context menu's Regenerate name, which share the store's list.
  const retitling = useSessionActions((s) => (id ? s.retitling.includes(id) : false))
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
  // Another device's session reads no path of this one: images only.
  const attachments = useAttachments(id ?? '', { foreign })
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
  // The side slot holds a subagent, a task's output, the harness or the
  // terminal's side panel; any of them narrows this panel the same way.
  const slotWidthPx = useSideSlotWidth()
  const subagentPanelOpen = slotWidthPx > 0
  const renderedDetailWidth = subagentPanelOpen
    ? resolvePanelPairWidths(detailWidth, slotWidthPx, windowWidth).detailWidthPx
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

  // The context menu's Rename (spec 2026-10-24-session-context-menu-design):
  // it selected the session and left the request here, and the title opens
  // for editing as a click on it opens it. After the reset on a change of
  // session above, which would otherwise close it again.
  const renaming = useSessionActions((s) => s.renaming)
  const renameReady = renaming !== null && renaming === selectedId && !hidden && session !== undefined
  useEffect(() => {
    if (!renameReady) return
    renameTaken()
    titleAbandoned.current = false
    setIsEditingTitle(true)
  }, [renameReady])

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

  // A new text step changes the line height under an open field.
  const textScaleVersion = useTextScaleVersion()
  // The title field is one line until its own text needs a second, and stops
  // there (9e). On every keystroke, because the height is a function of the
  // text rather than of the element: the browser will not shrink a textarea
  // back on its own, hence the reset to zero before the measurement.
  useEffect(() => {
    const el = titleFieldRef.current
    if (!el) return
    // The rendered size, not TITLE_FONT_PX: the text step scales it.
    const line = (parseFloat(getComputedStyle(el).fontSize) || TITLE_FONT_PX) * TITLE_LINE_HEIGHT
    el.style.height = '0px'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, line), line * TITLE_MAX_LINES)}px`
  }, [titleDraft, isEditingTitle, textScaleVersion])

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
  /** Row 4, the header's full content width: the subagent list ends on its right edge (canvas 25a). */
  const stateRowRef = useRef<HTMLDivElement | null>(null)
  // A hidden panel draws no control, so it serves no key either.
  const shown = selectedId != null && !hidden ? session : undefined
  // Stop sits in the composer, which a terminal-live session does not get.
  useCommand(
    'session.interrupt',
    () => setDialog('stop'),
    shown?.status === 'working' && !isReadOnly(shown) && lock === null
  )
  // Clear and End are Orbital's own, as the strip draws them (`UtilityStrip`).
  useCommand(
    'session.clear',
    () => {
      if (shown) askToClear(shown.id)
    },
    shown?.source === 'web'
  )
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
    if (composerLocked || lock) return
    if (!text && !attachments.armed) return
    if (reviewHeld) return
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

  // The question the card has open — the first unanswered one, or one
  // reopened to change it — or undefined once the card is sent, which is
  // what makes the composer revert to a normal reply the moment the card is
  // settled by a click (canvas 9c). A terminal session Orbital only watches
  // can read the question but never answer it, so its composer is unchanged
  // too.
  const openDecisionQuestion =
    questionTarget?.kind === 'question' && !isTerminalLive ? questionTarget : undefined
  // The review is showing (canvas 9f D): a plain composer whose ⏎ is held —
  // the text stays in the box and becomes a normal reply after Send.
  const reviewHeld = questionTarget?.kind === 'review' && !isTerminalLive

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

  const sessionTag = session ? primaryTag(session.tagIds, tags) : undefined
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
      // The media popover spans this box less its inset (canvas `Feature - Media` 24b).
      data-media-bound
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
    {/* The device it runs on (canvas 50f), on the panel's top edge, outside
        its clipping shell like the harness pill. A detached window draws it
        in its title bar instead. */}
    {session && showDevicePill && !standalone && (
      <DevicePill session={session} hue={headerHue ?? ACCENT_HUE} placement="edge" />
    )}
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
        className="orbital-no-drag absolute inset-y-0 left-0 z-20 w-2 cursor-col-resize touch-none hover:bg-line/8"
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
          'orbital-band-controls border-b border-line/14 px-[22px] pt-3 pb-4',
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
            standalone ? 'orbital-drag-region -mx-[22px] -mt-3 h-fit min-h-10 pt-3 pr-[22px]' : 'h-fit min-h-7',
          ].join(' ')}
          style={standalone ? { paddingLeft: WINDOW_STRIP_INSET_PX } : undefined}
        >
          {session && showDevicePill && standalone && (
            <DevicePill session={session} hue={headerHue ?? ACCENT_HUE} placement="inline" />
          )}
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
            onClear={() => askToClear(id)}
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
              borderBottomColor: isEditingTitle ? accentSoft70 : swatch('line', 0.35),
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
                className="min-w-0 flex-1 resize-none overflow-y-auto bg-transparent text-ink-100 focus:outline-none"
                style={TITLE_TYPE}
              />
            ) : (
              <button
                type="button"
                title="Rename this session"
                onClick={beginTitleEdit}
                className="min-w-0 flex-1 cursor-text text-left text-ink-100 transition-opacity duration-200"
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
              className="mt-1 shrink-0 fs-12 leading-(--text-xs--line-height)"
              style={{ color: isEditingTitle ? swatch('ink-900', 0.35) : swatch('ink-900', 0.6) }}
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
                onClick={() => regenerateName(id)}
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
                  variant="tag"
                  font="sans"
                  aria-label="Change tag"
                  title="Change tag"
                  value={sessionTag.id}
                  options={tags.map((tag) => ({
                    value: tag.id,
                    label: tag.name,
                    dotColor: tagColor(tag.hue),
                  }))}
                  onChange={(tagId) => changeTag(id, tagId)}
                  footer="ONE TAG PER SESSION · SETS PLANET HUE"
                />
              )}
              {/* Canvas 44b: the session's Claude directory, after the tag chip,
                  with two or more configured. Read-only. */}
              {claudeDirMark && <ClaudeDirChip mark={claudeDirMark} />}
              <span aria-hidden className="flex-1" />
              {(session.model || session.resolvedModel || models.length > 0) && (
                <ModelSwitcher
                  session={session}
                  models={switcherModels}
                  defaultValue={settings.default_model ?? null}
                  hidden={hidden}
                  disabledReason={
                    isTerminalLive
                      ? 'Live in a terminal — Orbital does not own this session'
                      : // A device that cannot be driven would refuse the switch.
                        (lock?.title ?? undefined)
                  }
                />
              )}
              <ModeSwitcher session={session} disabled={isTerminalLive || lock !== null} />
            </div>

            {/* Row 4 — status (canvas `Feature - Detail header` 9d): the state
                chip on the left — outlined in its state colour since
                `Feature - State colours` 24c — then the chips. The context
                read-out sits on the bar's line below (48e). The read-out, and
                the bar, are drawn only when the window is actually known — a
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
              ) : session.limitWait ? (
                // `Feature - Plan limits` 31b: the state line while it waits for a reset.
                <Badge variant="limit" label={limitWaitStatus(session.limitWait)} />
              ) : loginLabels?.short ? (
                // `Feature - Log in` 62a: while its profile logs in, the
                // session rests as a limit wait does, on the same quiet line.
                <Badge variant="limit" label={loginLabels.header} />
              ) : (
                <Badge
                  variant="status"
                  // The panel has the live question in the store as well as on
                  // the snapshot, and the store's copy is the fresher of the
                  // two — it hears `decision_pending` directly.
                  state={stateKey}
                  gate={gateWaits(session)}
                  // 62d: NEEDS INPUT · LOG IN TO WORK PROFILE.
                  waitsFor={loginLabels?.header}
                  // Canvas 50f: an offline device's state keeps its last value, dated.
                  asOf={stateAsOf(session.machine, deviceNow)}
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
              {/* The user's own shells (canvas `Feature - Terminal` 48e),
                  after ▣ and never counted in it. Terminal sessions get it
                  too: it is the one thing they can type into. */}
              <TerminalChip sessionId={session.id} />
              <span aria-hidden className="flex-1" />
              {session.source === 'terminal' && (
                <span
                  data-terminal-chip
                  title="Attached from an external terminal · Orbital measures no context for it"
                  className="rounded-[4px] border border-line/18 bg-line/4 px-[7px] py-[3px] font-mono fs-9.5 tracking-[0.16em] text-ink-900/75"
                >
                  TERMINAL
                </span>
              )}
            </div>

            {/* The context bar (9d): a 3px track notched at the two
                thresholds, with the read-out on its line, in the same ink
                as the fill. The read-out used to end the state row; it
                moved here to make room there for the chips (canvas
                `Feature - Terminal` 48e: bar flex, gap 12, read-out right). */}
            {showContext && (
              <div className="mt-[9px] flex items-center gap-3">
                <div className="relative h-[3px] min-w-0 flex-1 overflow-hidden rounded-[2px] bg-line/12">
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
                      className="absolute top-0 bottom-0 w-[1.5px] bg-shade/80"
                      style={{ left: `${percent}%` }}
                    />
                  ))}
                </div>
                {contextNote && (
                  <span
                    data-context-note
                    className="font-mono fs-9.5 tracking-[0.16em] whitespace-nowrap"
                    style={{ color: contextNote.ink }}
                  >
                    {contextNote.text}
                  </span>
                )}
                <span
                  data-context-readout
                  data-testid="context-readout"
                  className="flex items-baseline gap-1 font-mono whitespace-nowrap"
                >
                  <span
                    className="fs-12.5 leading-none transition-colors duration-300"
                    style={{
                      // Past the critical line the number turns ink-100 beside the red
                      // fill: red light enough to read stops looking critical
                      // (canvas `Feature - Colour themes` 1b, flag 2).
                      color: compacting
                        ? COMPACTING_READOUT_INK
                        : contextUsed == null
                          ? UNMEASURED_INK
                          : contextBarLevel === 'critical'
                            ? swatch('ink-100')
                            : contextInk,
                    }}
                  >
                    {/* The measurement itself, NOT the bar's clamped fraction:
                        a session past a mis-learned window says so. */}
                    {contextUsed != null ? formatTokens(contextUsed) : NO_VALUE}
                  </span>
                  <span className="fs-10 text-ink-900/55">
                    / {formatContextWindow(contextWindow)}
                  </span>
                </span>
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
        className={['relative min-h-0 flex-1', dropArmed ? 'opacity-35' : ''].join(' ')}
      >
        {/* Media takes over the body (canvas `Feature - Media` 24d). The
            transcript stays mounted underneath, invisible rather than gone,
            so going back finds it at the scroll position it was left at. */}
        <div
          className={[
            'h-full',
            // It fades as the gallery comes down over it, and turns invisible only once
            // the fade is through (`visibility` switches at the end of its transition).
            'motion-safe:transition-[opacity,visibility] motion-safe:ease-[cubic-bezier(.2,.8,.2,1)]',
            galleryOpen ? 'invisible opacity-0 motion-safe:duration-[320ms]' : 'opacity-100 motion-safe:duration-[240ms]',
          ].join(' ')}
          inert={galleryOpen || undefined}
        >
          <Transcript sessionId={id} />
        </div>
        {gallery.mounted && (
          <div
            className={[
              'absolute inset-0',
              // The gallery comes down from the top over the transcript and goes back up.
              PANEL_TRANSITION,
              gallery.state === 'exiting' ? `${PANEL_EXIT_DURATION} ${EXITING}` : PANEL_ENTER_DURATION,
              gallery.state === 'entered' ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-6',
            ].join(' ')}
            inert={gallery.state === 'exiting' || undefined}
          >
            <MediaGallery sessionId={id} columns={standalone ? 5 : 3} />
          </div>
        )}
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
          className="mx-[22px] mb-3.5 rounded-[10px] border border-white/25 bg-white/[0.06] px-3.5 py-3 font-mono fs-10.5 leading-[1.7] text-ink-200/85 [text-wrap:pretty]"
        >
          Turn interrupted by a server restart. The conversation is intact — ask again for
          whatever did not come back.
        </div>
      )}

      {/* 4a's foot note: what the pin promises, or how long this session has
          left on the map. Only an ended session has either to say — a live
          one is not going anywhere. */}
      {footNote && (
        <div className="mx-[22px] mb-3.5 rounded-[10px] border border-line/10 bg-shade/45 px-3.5 py-3 font-mono fs-10.5 leading-[1.7] text-ink-900/70 [text-wrap:pretty]">
          {footNote}
        </div>
      )}

      {/* Composer — canvas 1b: padding 14px 16px 16px over a hairline rule. */}
      <div
        className="border-t border-line/14 px-4 pb-4 pt-3.5"
        // Canvas 9f D: during the review ⇧⇥ from the composer jumps to the
        // card's Send.
        onKeyDownCapture={(e) => {
          if (!reviewHeld || e.key !== 'Tab' || !e.shiftKey) return
          if (e.metaKey || e.ctrlKey || e.altKey) return
          // The one interactive card is this panel's: the subagent panel's
          // cards are read-only.
          const send = document.querySelector<HTMLElement>(
            '[data-question-card][data-mode="interactive"] [data-question-send]',
          )
          if (!send) return
          e.preventDefault()
          e.stopPropagation()
          send.focus()
        }}
      >
        {isTerminalLive && session ? (
          // Take over (spec 2026-10-21-take-over-terminal-session-design): a
          // CLI that is not plainly idle asks first, since what runs there
          // stops. The bar keeps its old height; placement awaits Claude Design.
          <div className="flex items-center justify-between gap-3 rounded-[10px] border border-line/18 bg-shade/60 py-[5px] pl-3 pr-[5px] font-mono fs-11.5 text-ink-900/70">
            runs in terminal — read-only
            {canTakeOver(session) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => askToTakeOver(session.id)}
              >
                Take over
              </Button>
            )}
          </div>
        ) : lock ? (
          // Canvas 50f C: the reason in the composer's place — never a
          // disabled field to type into.
          <div
            data-device-lock
            aria-disabled="true"
            className="flex items-start gap-3 rounded-[10px] border border-line/14 bg-shade/40 px-3.5 py-[13px]"
          >
            <span
              aria-hidden
              className="mt-[5px] box-border block size-2 flex-none rounded-full border-[1.3px] border-solid border-ink-600/60"
            />
            <span className="flex flex-1 flex-col gap-1">
              <span className="fs-13.5 font-semibold text-ink-100">{lock.title}</span>
              <span className="fs-12.5 leading-normal text-ink-900/72 [text-wrap:pretty]">
                {lock.body}
              </span>
            </span>
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
                ? openDecisionQuestion.changing
                  ? `⏎ replaces the answer to ${openDecisionQuestion.question.header}`
                  : '⏎ answers the question'
                : reviewHeld
                  ? prompt.trim()
                    ? '⏎ is held — this stays here until the answers are sent'
                    : '⏎ here won’t send them · ⇧⇥ jumps to Send'
                : openVerdictKind
                  ? composerHintFor(openVerdictKind)
                  : '⏎ send · ⇧⏎ newline · ⌘V paste image'
            }
            answering={
              !picking && !rewindPending && (openDecisionQuestion !== undefined || openVerdictKind !== undefined)
            }
            hintBright={picking || rewindPicked !== null || rewindPending !== null}
            hintHeld={reviewHeld && !picking && !rewindPicked && !rewindPending}
            // Canvas 9c / 9f D: while a question card is open the newline key
            // stands apart at the row's end, and the sentence keeps to one line.
            hintAside={
              (openDecisionQuestion || reviewHeld) && !picking && !rewindPicked && !rewindPending
                ? '⇧⏎ newline'
                : undefined
            }
            emphasized={rewindPending !== null}
            strip={
              picking || rewindPicked ? (
                // Canvas 27a/27c: pick mode's strip. A draft already in the
                // field stays untouched underneath it.
                <>
                  <span className="flex text-accent">
                    <RewindGlyph size="strip" />
                  </span>
                  <span className="text-ink-100">Pick one of your messages to rewind to</span>
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
                  <span className="text-ink-100">Rewound</span>
                  <span aria-hidden className="text-line/30">
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
                ? `${openDecisionQuestion.changing ? 'Change' : 'Answer'} ${openDecisionQuestion.question.header}, or pick an option above…`
                : reviewHeld
                  ? 'Your answers are ready — Send is in the card above'
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
                  // Held while a question card's review shows (canvas 9f D;
                  // the phone's Send does the same, 9i).
                  disabled={composerLocked || reviewHeld || (!prompt.trim() && !attachments.armed)}
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
          overlays (Stop, Rewind), because it always belongs to the selected
          session — it needs this session's id for the read and its cwd/title
          for the refusal copy and footer, and `select()` closing it keeps the
          pairing honest. It portals to document.body like the Lightbox, so
          the panel's overflow-hidden shell never clips it. Judgement call:
          the spec only says "over the app"; this is the mount point that
          gets the session without threading it through the store. */}
      {session && <FileViewer session={session} />}
      <StopDialog open={dialog === 'stop'} sessionId={id} onClose={() => setDialog(null)} />
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
            ? 'border-accent/45 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-accent)_12%,transparent)]'
            : 'border-transparent',
        ].join(' ')}
      />
    </div>
  )
}
