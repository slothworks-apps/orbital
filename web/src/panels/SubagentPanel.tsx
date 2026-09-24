import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import type { Tag } from '../lib/types'
import { formatToolDuration } from '../lib/format'
import { modelNameForId } from '../lib/models'
import {
  elapsedMsFor,
  subagentModelFrom,
  subagentTypeFrom,
  taskStateFor,
  withoutLeadingUserFrame,
} from '../lib/subagentPanel'
import { Panel } from '../ui/Panel'
import { Chip } from '../ui/Chip'
import { Badge } from '../ui/Badge'
import { CollapseGlyph, UtilityButton } from '../ui/UtilityButton'
import { Tooltip } from '../ui/Tooltip'
import { PIN_TOOLTIP_DELAY_MS } from './UtilityStrip'
import { useEscapeLayer } from '../ui/escapeLayer'
import { TranscriptView } from './TranscriptView'

/**
 * The one tag a session wears, resolved the same way `DetailPanel`,
 * `Sidebar`, `map/layout.ts` and `NewSessionDialog` each already do — this
 * repo has no shared helpers module for it (see those four for the same
 * three lines), so this is a fifth, matching copy rather than a new import
 * that would only serve one more caller.
 */
function primaryTag(tagIds: number[], tags: Tag[]): Tag | undefined {
  for (const tagId of tagIds) {
    const tag = tags.find((t) => t.id === tagId)
    if (tag) return tag
  }
  return tags.find((t) => t.is_default === 1)
}

/** How often the RUNNING elapsed reading advances (canvas 11c: "the only
 * state that animates"). A mono reading that never shows sub-second
 * precision has no use for anything finer. The subagent list's running
 * rows tick at the same rate. */
export const ELAPSED_TICK_MS = 1000

/**
 * STREAM LOST's body (canvas 11c): the reason block sits where the first
 * transcript row would otherwise be, closed by a dashed rule, so the space
 * below reads as "nothing to show" rather than "nothing happened" — the
 * distinction the whole state exists to draw. Its own small component
 * because `SubagentPanel` swaps this in for `TranscriptView` entirely
 * rather than asking `TranscriptView` to render an empty state it was
 * never given a prop for (task 7 brief: "Do not change `TranscriptView`'s
 * props").
 */
function StreamLostBody() {
  return (
    <div className="flex h-full flex-col gap-[14px] overflow-y-auto px-[18px] py-[22px]">
      <div
        data-stream-lost-reason
        className="flex flex-col gap-[9px] rounded-[10px] border border-dashed border-[oklch(80%_0.13_60_/_0.45)] bg-[oklch(80%_0.13_60_/_0.05)] p-[14px]"
      >
        <div className="font-mono text-[9.5px] tracking-[0.16em] text-[oklch(85%_0.12_60)]">
          TRANSCRIPT UNAVAILABLE
        </div>
        <div className="text-[12.5px] leading-[1.6] text-[rgba(228,238,250,.9)] text-pretty">
          The Orbital server lost this agent&rsquo;s buffer — most likely a restart. It was only
          ever held in memory, so there is nothing left to show here.
        </div>
        <div className="font-mono text-[10px] leading-[1.7] text-[rgba(160,190,225,.65)]">
          this is not an empty run — the agent kept working
          <br />
          its report still lands in the parent transcript
        </div>
      </div>
      <div className="flex items-center gap-2.5 font-mono text-[9.5px] tracking-[0.14em] text-[rgba(160,190,225,.4)]">
        <span
          aria-hidden
          className="h-px flex-1"
          style={{
            background:
              'repeating-linear-gradient(90deg, rgba(150,205,255,.22) 0 3px, transparent 3px 8px)',
          }}
        />
        NO STEPS RECOVERABLE
        <span
          aria-hidden
          className="h-px flex-1"
          style={{
            background:
              'repeating-linear-gradient(90deg, rgba(150,205,255,.22) 0 3px, transparent 3px 8px)',
          }}
        />
      </div>
    </div>
  )
}

export interface SubagentPanelProps {
  /**
   * The panel's width in CSS px. Task 8 owns clamping it against the
   * viewport and the detail panel's own minimum — this component only ever
   * draws at whatever it is told (task 7 brief: "Build the panel as a
   * self-contained component with a width it is told, and let the next
   * task place it").
   */
  widthPx: number
  /**
   * Beside the detail panel in a detached window (spec:
   * 2026-09-23-detached-session-windows-design § The subagent panel in the
   * window): flush and chrome-less like the standalone detail panel, filling
   * the column its caller sizes, and its header row drags the window.
   */
  inWindow?: boolean
}

/**
 * The read-only subagent transcript panel (spec:
 * 2026-09-22-subagent-transcript-panel-design.md § 8, canvas 11b–11c).
 * Renders nothing while `store.subagentPanel` is null — the caller (task 8)
 * decides whether that means "unmounted" or "mounted but hidden"; this
 * component does not animate its own entrance/exit, the way `DetailPanel`
 * does, because how the two panels enter and leave TOGETHER is explicitly
 * the next task's layout concern, not this one's.
 */
export function SubagentPanel({ widthPx, inWindow = false }: SubagentPanelProps) {
  const panel = useOrbital((s) => s.subagentPanel)
  const closeSubagent = useOrbital((s) => s.closeSubagent)
  const models = useOrbital(useShallow((s) => s.models))
  const tags = useOrbital(useShallow((s) => s.tags))
  const parentSession = useOrbital((s) => (panel ? s.sessions[panel.sessionId] : undefined))
  // The PARENT's own transcript, read only to derive the agent-type chip
  // (`subagentTypeFrom` — see that function's doc for why `Subagent` itself
  // cannot carry it). Empty, not missing, when this tab never fetched or
  // subscribed to the parent (a panel opened straight from a map moon,
  // before its session was ever selected) — the derivation already treats
  // that as "type unknown" rather than throwing.
  const parentMessages = useOrbital(
    useShallow((s) => (panel ? (s.transcripts[panel.sessionId] ?? []) : []))
  )

  /**
   * The LIVE agent, re-selected out of the parent session on every store
   * change — not `panel.subagent`, which `openSubagent` stored by value at
   * the moment of the click and which nothing ever writes again.
   *
   * `applySessionsEvent` replaces `sessions[id]` wholesale from the WS
   * payload, so a `task_notification` arriving under an open panel lands
   * `state: 'ended'` and `status` on a BRAND NEW `Subagent` object. Reading
   * the snapshot instead meant the badge stayed RUNNING forever and the
   * elapsed clock never froze (`elapsedMsFor` kept returning
   * `now - startedAt`) — spec § 8's
   * "Agent ends | Panel stays, frozen, with the final report" and the whole
   * COMPLETED/FAILED/STOPPED half of § 10 were unreachable on the only path
   * that produces them.
   *
   * Joined on `subagent.id` (the task id), not `toolUseId`: `id` is the one
   * field `SubagentInfo` always carries (see `lib/types.ts`), and it is
   * stable across every republish of the same agent.
   *
   * The snapshot stays as the FALLBACK, for the window where the session no
   * longer carries the agent at all — a server restart repopulates
   * `sessions` with `subagents: []`, and the header must keep naming the
   * agent the user opened rather than blanking. What turns that window into
   * STREAM LOST is `panel.found`, written by `openSubagent`'s own 404
   * branch (which `resyncAfterReconnect` now re-runs — see the store).
   */
  const liveSubagent = useOrbital((s) =>
    panel ? s.sessions[panel.sessionId]?.subagents.find((a) => a.id === panel.subagent.id) : undefined
  )
  const subagent = panel ? (liveSubagent ?? panel.subagent) : null

  // Two pre-return, hook-safe values (every hook here must run on every
  // render regardless of whether a panel is open, so nothing driving them
  // can sit behind the `!panel` check below). Neither is treated as this
  // component's real "current state" — `taskState` is computed again, for
  // real, once `panel` is known non-null.
  //
  // `panelKey` identifies WHICH agent (if any) is open, `runningWhileOpen`
  // whether it is currently ticking. Both are needed, and neither alone is
  // enough (task 7 review, finding 2):
  //
  // - `runningWhileOpen` alone, with a null-panel fallback of `false`, stops
  //   the interval correctly on close — but swapping directly from one
  //   RUNNING agent to another (one `openSubagent` call replacing the slot
  //   outright — `subagentPanel` never passes through null) leaves this
  //   value `true` on both sides of the swap, so the effect never re-runs
  //   and the new agent's first render shows the OLD agent's `nowMs` for up
  //   to a second.
  // - `panelKey` alone would reset correctly on every swap, but a null
  //   panel is also a stable (if degenerate) key, and nothing would ever
  //   stop the interval once started against a panel that is now closed.
  //
  // Together: `panelKey` changing re-triggers the effect on every open/close/
  // swap, and `runningWhileOpen` (re-read inside the effect body on every
  // one of those triggers) decides whether that re-trigger starts a fresh
  // interval or leaves none running.
  const panelKey = panel && subagent ? `${panel.sessionId}:${subagent.id}` : null
  const runningWhileOpen =
    panel && subagent ? taskStateFor(subagent, panel.found) === 'running' : false

  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!runningWhileOpen) return
    // Reset immediately, not just on the next tick: this fires on every
    // open/swap into a running agent, and `nowMs` may be long stale — read
    // for whatever was open (or nothing) a moment ago — until the interval
    // below ticks for the first time.
    setNowMs(Date.now())
    const timer = setInterval(() => setNowMs(Date.now()), ELAPSED_TICK_MS)
    return () => clearInterval(timer)
  }, [panelKey, runningWhileOpen])

  // `⎋` closes the panel (task 9 brief item 4/keyboard). Through the app's
  // shared escape stack, not a listener of this component's own — the brief
  // is explicit that this "must cooperate with the existing escape layer
  // rather than adding a competing global listener" (see `ui/escapeLayer`'s
  // own doc for why a second one can never win the race against it anyway).
  useEscapeLayer(panel !== null, closeSubagent)

  if (!panel || !subagent) return null

  const taskState = taskStateFor(subagent, panel.found)

  const { messages, droppedCount } = panel
  const elapsedMs = taskState === 'stream_lost' ? undefined : elapsedMsFor(subagent, messages, nowMs)
  // `elapsedMsFor` itself can also come back `undefined` for a terminal
  // agent that never published one timestamped message — see its doc. Both
  // read the same "elapsed unknown", canvas 11c's own wording, and neither
  // is ever a fabricated zero.
  const elapsedLabel = elapsedMs === undefined ? 'elapsed unknown' : formatToolDuration(elapsedMs)

  const agentType = subagentTypeFrom(parentMessages, subagent.toolUseId)
  const rawModel = subagentModelFrom(messages)
  const modelLabel = rawModel ? modelNameForId(rawModel, models) : undefined

  const sessionTag = parentSession ? primaryTag(parentSession.tagIds, tags) : undefined

  // Spec § 8, "No user bubbles": a subagent has exactly one instruction and
  // it is already shown as the heading below, so the leading turn is
  // suppressed here rather than duplicated into the transcript body.
  const bodyMessages = withoutLeadingUserFrame(messages)

  return (
    <Panel
      side="subagent"
      widthPx={widthPx}
      fill={inWindow}
      className="relative flex h-full flex-col overflow-hidden"
    >
      {/* Top-edge seam (task 8: spec § 8 "Layout", "three cues separate the
          two panels"). The session panel's own top hairline (`DetailPanel`)
          is a SOLID accent gradient; canvas 11b draws this panel's as a
          DASHED one instead — same position, same 1px height, different
          stroke — so the pair is tellable apart by the seam alone, with no
          colour difference required. Values verbatim from 11b/11d's own
          `repeating-linear-gradient`, not eyeballed (web/CLAUDE.md). */}
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-px"
        style={{
          background:
            'repeating-linear-gradient(90deg, rgba(150,205,255,.4) 0 4px, transparent 4px 10px)',
        }}
      />

      {/* Header — canvas 11b: 16px/18px padding, one step tighter than the
          detail panel's 12px/22px/16px at every level. Docked in the main
          window, its top lies under the drag band (canvas `Feature - Main
          window chrome` 24a), so its controls opt out of it. */}
      <div className="orbital-band-controls border-b border-[rgba(150,205,255,.1)] px-[18px] pb-4 pt-4">
        {/* In a detached window the row carries on the detail panel's title
            bar (22b): it reaches out over the header's top and side padding
            so the whole top band drags the window, and collapse stays clickable
            (`orbital-drag-region`). */}
        <div
          className={[
            'flex items-center gap-2',
            inWindow ? 'orbital-drag-region -mx-[18px] -mt-4 h-[38px] px-[18px] pt-4' : 'h-[22px]',
          ].join(' ')}
        >
          <span className="font-mono text-[9.5px] tracking-[0.18em] text-[rgba(160,190,225,.55)]">
            SUBAGENT · READ-ONLY
          </span>
          <span aria-hidden className="flex-1" />
          {/* The detail header's collapse chevron (canvas `Feature - Header
              actions` 23b), so both panels say "slide away" the same way
              rather than one of them "close something". Its own name for a
              screen reader: with both panels open, two "Collapse panel"
              buttons would not say which is which. */}
          <Tooltip variant="name" title="Collapse panel" align="right" delayMs={PIN_TOOLTIP_DELAY_MS}>
            <UtilityButton aria-label="Collapse the subagent panel" onClick={closeSubagent}>
              <CollapseGlyph />
            </UtilityButton>
          </Tooltip>
        </div>

        {/* The parent session's name (task 7 brief's own anatomy list) —
            canvas 11b only draws this as part of the 11d back-control,
            which the spec defers past v1 (§ "The sub-1010 px layout"). The
            brief still asks for the name itself, so it gets a plain
            breadcrumb line rather than the deferred `↖` control. */}
        {parentSession && (
          <div className="mt-1 truncate font-mono text-[10px] text-text-muted">
            {parentSession.title || 'Untitled session'}
          </div>
        )}

        <div className="mt-2.5 line-clamp-2 text-pretty text-[15px] font-semibold leading-[1.34] tracking-[-0.005em] text-text-bright">
          {subagent.name}
        </div>

        <div className="mt-3 flex items-center gap-[7px]">
          {/* Canvas 11b: "the 1e resting chip, unfilled" — `Chip` with no
              `hue`/`dot`/`onClick` is exactly that. Omitted (never a
              fabricated label) when the parent transcript hasn't surfaced a
              real `subagent_type` yet — see `subagentTypeFrom`. */}
          {agentType && <Chip label={agentType} />}
          <span aria-hidden className="flex-1" />
          <Badge
            variant="task"
            value={taskState}
            truncated={droppedCount > 0}
            hue={sessionTag?.hue}
          />
        </div>

        <div className="mt-[11px] flex items-center gap-2 font-mono text-[10.5px] text-[rgba(160,190,225,.6)]">
          {modelLabel && <span>{modelLabel}</span>}
          <span aria-hidden className="flex-1" />
          <span data-elapsed className="text-[rgba(200,225,255,.85)]">
            {elapsedLabel}
          </span>
        </div>
      </div>

      {/* TRUNCATED marker (canvas 11c): a filled chip, not a hairline — it
          has to survive a fast scroll. `TranscriptView` owns its own single
          scroll container with no slot for a pinned leading row (and its
          props are frozen for this task — see the brief), so this sits as
          its own always-visible strip ABOVE the scroller rather than as the
          scroller's first child: stronger than "pinned", since it can never
          scroll away at all. */}
      {droppedCount > 0 && (
        <div
          data-truncated-marker
          className="border-b border-[rgba(150,205,255,.1)] px-[18px] py-3"
        >
          <div className="flex flex-col gap-[7px] rounded-[9px] border border-[rgba(150,205,255,.26)] bg-[rgba(150,205,255,.07)] px-3 py-[11px]">
            <div className="flex items-center gap-2 font-mono text-[9.5px] tracking-[0.16em] text-[rgba(210,230,250,.9)]">
              <span aria-hidden className="h-px w-3 bg-[rgba(210,230,250,.6)]" />
              TRUNCATED
              <span aria-hidden className="flex-1" />
              <span className="text-[rgba(160,190,225,.6)]">
                buffer {messages.length.toLocaleString()} steps
              </span>
            </div>
            <div className="text-pretty text-[12px] leading-[1.55] text-[rgba(228,238,250,.88)]">
              The first {droppedCount.toLocaleString()} steps of this run were dropped. What
              follows is the tail of the record, not the whole of it.
            </div>
          </div>
        </div>
      )}

      {/* Body */}
      <div className="min-h-0 flex-1">
        {taskState === 'stream_lost' ? (
          <StreamLostBody />
        ) : (
          <TranscriptView
            messages={bodyMessages}
            isWorking={taskState === 'running'}
            models={models}
            resetKey={`${panel.sessionId}:${subagent.id}`}
            // The PARENT session's id — `QuestionCard` needs a real session
            // to read `pendingDecisions` off, and the panel has no session
            // of its own to give it.
            sessionId={panel.sessionId}
            compact
            // NOT inferred from ids: `decide()` (`server/src/runner/runner.ts`)
            // does not read the SDK's `opts.agentID`, so a subagent-originated
            // `AskUserQuestion` can land in `pendingDecisions[panel.sessionId]`
            // keyed by the subagent's own toolUseId — exactly the id
            // `QuestionCard`'s `isPending` check would otherwise match. This
            // prop is what makes the panel read-only regardless of whether
            // that ever happens (fix: subagent-question-ignores-agent-id).
            readOnly
          />
        )}
      </div>

      {/* Footer — canvas 11b: the permanent read-only strip. No composer, no
          send control, no stop control: a subagent takes no input, ever
          (spec § "Read-only means read-only"). */}
      <div
        data-subagent-footer
        className="flex items-center gap-2 border-t border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.4)] px-[18px] py-3 font-mono text-[10px] tracking-[0.06em] text-[rgba(160,190,225,.5)]"
      >
        <span>read-only · a subagent takes no input</span>
        <span aria-hidden className="flex-1" />
        <span>⎋ close</span>
      </div>
    </Panel>
  )
}
