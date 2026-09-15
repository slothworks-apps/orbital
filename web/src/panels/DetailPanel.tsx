import { useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { Panel } from '../ui/Panel'
import { Badge } from '../ui/Badge'
import { Chip } from '../ui/Chip'
import { Button } from '../ui/Button'
import { Input, TextArea } from '../ui/Input'
import { Transcript } from './Transcript'
import { StopDialog } from './StopDialog'
import { ClearDialog } from './ClearDialog'
import { shortenPath } from '../lib/format'

/** Roughly Claude's context window, in tokens — the denominator for the
 * header's context-usage bar. Not read from settings/the API; it's a fixed
 * budget the bar is scaled against. */
const CONTEXT_BUDGET = 200_000

function extractUsageTokens(usage: unknown): { total: number } | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const u = usage as Record<string, unknown>
  const num = (key: string) => (typeof u[key] === 'number' ? (u[key] as number) : 0)
  return { total: num('input_tokens') + num('cache_read_input_tokens') + num('output_tokens') }
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
  const id = useOrbital((s) => s.ui.selectedId)
  const session = useOrbital((s) => (id ? s.sessions[id] : undefined))
  const tags = useOrbital(useShallow((s) => s.tags))
  const usage = useOrbital((s) => (id ? s.usage[id] : undefined))
  const subagents = useOrbital(useShallow((s) => (id ? (s.subagents[id] ?? []) : [])))
  const settings = useOrbital(useShallow((s) => s.settings))
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

  if (!id) return null

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

  function toggleTag(tagId: number) {
    if (!id || !session) return
    const previousTagIds = session.tagIds
    const nextIds = previousTagIds.includes(tagId)
      ? previousTagIds.filter((t) => t !== tagId)
      : [...previousTagIds, tagId]
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
      reportError(err, 'Failed to update tags')
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
  const contextPercent =
    usageTokens !== undefined ? Math.min(100, Math.round((usageTokens.total / CONTEXT_BUDGET) * 100)) : undefined
  const isTerminalLive = session?.source === 'terminal' && session.status !== 'ended'
  const promptPlaceholder = session?.status === 'ended' ? 'Continue conversation…' : 'Send a message…'

  return (
    <Panel side="right" className="flex h-full flex-col gap-3 overflow-hidden p-4">
      <div className="flex flex-col gap-2 border-b border-panel-border pb-3">
        <div className="flex items-center gap-2">
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
            className="min-w-0 flex-1"
          />
          {lineage && lineage.length > 0 && (
            <span aria-label="Lineage" className="flex shrink-0 items-center gap-1">
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
        </div>

        {session && (
          <>
            <div className="truncate font-mono text-[11px] text-text-muted">{shortenPath(session.cwd)}</div>

            <div className="flex flex-wrap items-center gap-1.5">
              {session.permissionMode && <Badge variant="mode" value={session.permissionMode} />}
              <Badge variant="status" value={session.status} />
            </div>

            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Tags">
                {tags.map((tag) => (
                  <Chip
                    key={tag.id}
                    label={tag.name}
                    hue={tag.hue}
                    active={session.tagIds.includes(tag.id)}
                    onClick={() => toggleTag(tag.id)}
                  />
                ))}
              </div>
            )}

            {usageTokens !== undefined && contextPercent !== undefined && (
              <div className="flex flex-col gap-1" aria-label="Context usage">
                <div className="flex items-center justify-between font-mono text-[11px] text-text-muted">
                  <span>{usageTokens.total.toLocaleString()} tokens</span>
                  <span>{contextPercent}%</span>
                </div>
                <div
                  role="progressbar"
                  aria-label="Context usage"
                  aria-valuenow={contextPercent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  className="h-1 w-full overflow-hidden rounded-full bg-white/10"
                >
                  <div className="h-full rounded-full bg-text-soft" style={{ width: `${contextPercent}%` }} />
                </div>
              </div>
            )}

            {subagents.length > 0 && (
              <div className="flex flex-wrap gap-1.5" aria-label="Subagents">
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

      <div className="border-t border-panel-border pt-3">
        {isTerminalLive ? (
          <div className="rounded-md border border-panel-border bg-white/5 px-3 py-2 text-center font-mono text-xs text-text-muted">
            runs in terminal — read-only
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <TextArea
              aria-label="Prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handlePromptKeyDown}
              placeholder={promptPlaceholder}
              rows={2}
            />
            <div className="flex justify-end gap-2">
              {session?.status === 'working' && (
                <Button variant="danger" onClick={() => setDialog('stop')}>
                  Stop
                </Button>
              )}
              <Button variant="primary" onClick={handleSend} disabled={!prompt.trim()}>
                Send
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
  )
}
