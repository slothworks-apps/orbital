import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
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
import { ModeReadout } from '../ui/ModeDot'
import { Chip } from '../ui/Chip'
import { Select } from '../ui/Select'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Transcript } from './Transcript'
import { StopDialog } from './StopDialog'
import { ClearDialog } from './ClearDialog'
import { ModelSwitcher } from './ModelSwitcher'
import { shortenPath, formatContextWindow } from '../lib/format'
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

/** Placeholder for a stat the session has no data for. Terminal sessions
 * never report `turn_result` usage, so the grid renders em dashes rather
 * than vanishing (or, worse, inventing numbers). */
const NO_VALUE = '—'

interface UsageTokens {
  input: number
  output: number
  cacheRead: number
  /** Everything billed into the context window, incl. cache creation. */
  total: number
}

function extractUsageTokens(usage: unknown): UsageTokens | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const u = usage as Record<string, unknown>
  const num = (key: string) => (typeof u[key] === 'number' ? (u[key] as number) : 0)
  const input = num('input_tokens')
  const output = num('output_tokens')
  const cacheRead = num('cache_read_input_tokens')
  return {
    input,
    output,
    cacheRead,
    total: input + cacheRead + num('cache_creation_input_tokens') + output,
  }
}

/**
 * Compact token count in the export's own notation — "142.3k", "28.9k",
 * "116k" (canvas 1b's usage grid and context read-out). Counts under 1k
 * are shown verbatim; a trailing ".0" is dropped.
 */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
}

/** One cell of the header's INPUT / OUTPUT / CACHE READ grid (canvas 1b:
 * 9.5px mono label tracked out .16em over a 15px mono value). */
function UsageStat({ label, value }: { label: string; value: string }) {
  return (
    <div data-usage-stat={label}>
      <div className="font-mono text-[9.5px] tracking-[0.16em] text-[rgba(160,190,225,.55)]">{label}</div>
      <div className="mt-[3px] font-mono text-[15px] text-text-bright">{value}</div>
    </div>
  )
}

/**
 * Right-hand detail panel (artboard 1b): editable header (title, cwd, tag
 * chips, permission/status badges, token usage + context bar, lineage dots),
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
  const usage = useOrbital((s) => (id ? s.usage[id] : undefined))
  // Off the session itself, like the map's moons — the server keeps it current
  // for every session, not just the open one.
  const subagents = useOrbital(useShallow((s) => (id ? (s.sessions[id]?.subagents ?? []) : [])))
  const settings = useOrbital(useShallow((s) => s.settings))
  const models = useOrbital(useShallow((s) => s.models))
  const dialog = useOrbital((s) => s.ui.dialog)
  const setDialog = useOrbital((s) => s.setDialog)
  const sendPrompt = useOrbital((s) => s.sendPrompt)

  const [titleDraft, setTitleDraft] = useState('')
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [lineageCache, setLineageCache] = useState<Record<string, string[]>>({})

  // Prompt draft is reset ONLY when the selected session actually changes —
  // never on a title/session update for the SAME session (a rename firing
  // mid-draft used to wipe whatever the user had typed; see fix round 2).
  useEffect(() => {
    setPrompt('')
    setIsEditingTitle(false)
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

  function handleSend() {
    const text = prompt.trim()
    if (!text || !id) return
    setPrompt('')
    void sendPrompt(id, text)
  }

  function handlePromptKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const lineage = lineageCache[id]
  const usageTokens = extractUsageTokens(usage)
  const contextWindow = session ? contextWindowFor(session, models) : null
  const contextPercent =
    usageTokens !== undefined && contextWindow !== null
      ? Math.min(100, Math.round((usageTokens.total / contextWindow) * 100))
      : undefined
  // Only the Runner publishes `turn_result`, so a terminal session's
  // INPUT/OUTPUT/CACHE READ and context bar are permanently unmeasurable —
  // not merely unmeasured yet, the way a fresh web session's are. The owner
  // ruled that a number that can never arrive should not sit there as an em
  // dash either ("pokud terminálové sessions tyhle věci vůbec nevidí, tak
  // bych to skryl"), which deliberately overrides canvas 1b's "always
  // rendered" grid — a choice, not a regression.
  const canShowUsage = session?.source !== 'terminal'
  // Same predicate the sidebar badges a row with — one definition, so the
  // mark on the row and the refusal at the composer cannot drift apart.
  const isTerminalLive = session ? isReadOnly(session) : false
  const promptPlaceholder = session?.status === 'ended' ? 'Continue conversation…' : 'Send a message…'

  const sessionTag = session ? primaryTag(session, tags) : undefined
  const headerHue = sessionTag?.hue
  const accent = tagColor(headerHue ?? ACCENT_HUE)
  const accentSoft = `oklch(80% 0.13 ${headerHue ?? ACCENT_HUE} / 0.6)`

  return (
    // 1b paints a faint outer bloom in the session's hue around the panel.
    // Slide wrapper, not `Panel` itself: Panel already declares
    // `transition-[width]`, and a second transition-property utility would
    // resolve by stylesheet order rather than by intent.
    <div
      data-state={presence}
      // Still painted while it slides away, but no longer a live surface.
      inert={presence === 'exiting' || undefined}
      className={[
        'h-full',
        PANEL_TRANSITION,
        presence === 'exiting' ? PANEL_EXIT_DURATION : PANEL_ENTER_DURATION,
        presence === 'entered' ? PANEL_OPEN : PANEL_CLOSED,
        presence === 'exiting' ? EXITING : '',
      ].join(' ')}
    >
    <Panel side="right" glowHue={headerHue ?? ACCENT_HUE} className="relative flex h-full flex-col overflow-hidden">
      {/* Top hairline glint in the session's tag hue (canvas 1b). */}
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-px"
        style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }}
      />

      {/* Header — canvas 1b: padding 20px 22px 16px over a hairline rule. */}
      <div className="border-b border-panel-border px-[22px] pb-4 pt-5">
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
              <Badge variant="status" value={session.status} hue={headerHue} />
            </div>

            {/* Usage grid (1b), rendered for anything that CAN eventually report
                usage. A web session with no turn_result yet shows em dashes
                rather than an absent block; a terminal session never gets
                here at all — see `canShowUsage` above. */}
            {canShowUsage && (
              <div
                data-usage-grid
                data-empty={usageTokens === undefined}
                aria-label="Token usage"
                className="mt-4 grid grid-cols-3 gap-2.5"
              >
                <UsageStat label="INPUT" value={usageTokens ? formatTokens(usageTokens.input) : NO_VALUE} />
                <UsageStat label="OUTPUT" value={usageTokens ? formatTokens(usageTokens.output) : NO_VALUE} />
                <UsageStat
                  label="CACHE READ"
                  value={usageTokens ? formatTokens(usageTokens.cacheRead) : NO_VALUE}
                />
              </div>
            )}

            {/* Context bar + read-out on one line (1b: 3px track, 10px mono).
                Drawn only when the window is actually known — a bar scaled to
                a made-up denominator is worse than no bar (per
                docs/decisions/models-come-from-the-sdk.md). */}
            {canShowUsage && contextWindow !== null && (
              <div className="mt-3 flex items-center gap-2.5 font-mono text-[10px] text-[rgba(160,190,225,.6)]">
                <span className="h-[3px] flex-1 overflow-hidden rounded-[2px] bg-[rgba(150,205,255,.12)]">
                  {contextPercent !== undefined && (
                    <span
                      role="progressbar"
                      aria-label="Context usage"
                      aria-valuenow={contextPercent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      className="block h-full"
                      style={{
                        width: `${contextPercent}%`,
                        background: `linear-gradient(90deg, ${accentSoft}, ${accent})`,
                        boxShadow: `0 0 8px ${accentSoft}`,
                      }}
                    />
                  )}
                </span>
                <span data-context-readout data-testid="context-readout">
                  {usageTokens ? formatTokens(usageTokens.total) : NO_VALUE} / {formatContextWindow(contextWindow)}{' '}
                  ctx
                </span>
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

      <div className="min-h-0 flex-1">
        <Transcript sessionId={id} />
      </div>

      {/* Composer — canvas 1b: padding 14px 16px 16px over a hairline rule. */}
      <div className="border-t border-panel-border px-4 pb-4 pt-3.5">
        {isTerminalLive ? (
          <div className="rounded-[10px] border border-[rgba(150,205,255,.18)] bg-[rgba(4,8,16,.6)] px-3 py-3 text-center font-mono text-[11.5px] text-text-muted">
            runs in terminal — read-only
          </div>
        ) : (
          // One bordered well holding the field and its action row (1b).
          <div className="rounded-[10px] border border-[rgba(150,205,255,.18)] bg-[rgba(4,8,16,.6)] px-3 pb-2.5 pt-3">
            {/* Bare field: the well already draws the border/fill, so this is
                deliberately not `ui/Input`'s bordered TextArea variant. */}
            <textarea
              aria-label="Prompt"
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handlePromptKeyDown}
              placeholder={promptPlaceholder}
              className="block min-h-[36px] w-full resize-none border-0 bg-transparent p-0 font-sans text-[13px] leading-[1.5] text-text-bright placeholder:text-text-muted focus:outline-none"
            />
            <div className="mt-1.5 flex items-center gap-2">
              <span className="font-mono text-[10px] tracking-[0.06em] text-[rgba(160,190,225,.5)]">
                ⏎ send · ⇧⏎ newline
              </span>
              <span aria-hidden className="flex-1" />
              {session?.status === 'working' && (
                <Button variant="warning-outline" size="sm" onClick={() => setDialog('stop')}>
                  <span aria-hidden className="h-2 w-2 rounded-[1px] bg-current" />
                  Stop
                </Button>
              )}
              <Button variant="primary" size="sm" onClick={handleSend} disabled={!prompt.trim()}>
                Send ↑
              </Button>
            </div>
          </div>
        )}
      </div>

      <StopDialog open={dialog === 'stop'} sessionId={id} onClose={() => setDialog(null)} />
      <ClearDialog
        open={dialog === 'clear'}
        sessionId={id}
        onClose={() => setDialog(null)}
        onCleared={invalidateLineage}
      />
    </Panel>
    </div>
  )
}
