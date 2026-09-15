import { useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { Panel } from '../ui/Panel'
import { Badge } from '../ui/Badge'
import { Chip } from '../ui/Chip'
import { Button } from '../ui/Button'
import { TextArea } from '../ui/Input'
import { Transcript } from './Transcript'
import { StopDialog } from './StopDialog'
import { ClearDialog } from './ClearDialog'
import { shortenPath } from '../lib/format'

/** Sets the shared toast for a failed fire-and-forget API call kicked off
 * directly from this component (rename/tag-toggle), mirroring the pattern
 * `sendPrompt` already uses in the store for the same class of error. */
function reportError(err: unknown, fallback: string) {
  const message = err instanceof Error ? err.message : fallback
  useOrbital.setState({ toast: { kind: 'error', message } })
}

function extractOutputTokens(usage: unknown): number | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const value = (usage as Record<string, unknown>).output_tokens
  return typeof value === 'number' ? value : undefined
}

/**
 * Right-hand detail panel (artboard 1b): editable header (title, cwd, tag
 * chips, permission/status badges, token usage, lineage dots), the
 * session's transcript + live subagents strip, and a footer that varies by
 * session kind — a prompt composer for web/ended sessions, or a read-only
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
  const [prompt, setPrompt] = useState('')
  const [lineageCache, setLineageCache] = useState<Record<string, string[]>>({})

  // Reseed local edit state whenever the selection (or its title) changes —
  // not on every store update, so mid-edit keystrokes aren't clobbered by
  // e.g. a WS status event for the same session.
  useEffect(() => {
    setTitleDraft(session?.title ?? '')
    setPrompt('')
  }, [id, session?.title])

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

  function commitTitle() {
    if (!id || !session) return
    const next = titleDraft.trim()
    if (!next || next === session.title) {
      setTitleDraft(session.title)
      return
    }
    useOrbital.setState((state) => {
      const current = state.sessions[id]
      if (!current) return state
      return { sessions: { ...state.sessions, [id]: { ...current, title: next } } }
    })
    api.renameSession(id, next).catch((err) => reportError(err, 'Failed to rename session'))
  }

  function toggleTag(tagId: number) {
    if (!id || !session) return
    const nextIds = session.tagIds.includes(tagId)
      ? session.tagIds.filter((t) => t !== tagId)
      : [...session.tagIds, tagId]
    useOrbital.setState((state) => {
      const current = state.sessions[id]
      if (!current) return state
      return { sessions: { ...state.sessions, [id]: { ...current, tagIds: nextIds } } }
    })
    api.setSessionTags(id, nextIds).catch((err) => reportError(err, 'Failed to update tags'))
  }

  function handleClearClick() {
    if (!id) return
    if (settings.confirm_before_clear === 'false') {
      void api.clearSession(id, false).catch((err) => reportError(err, 'Failed to clear session'))
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
  const outputTokens = extractOutputTokens(usage)
  const isTerminalLive = session?.source === 'terminal' && session.status !== 'ended'

  return (
    <Panel side="right" className="flex h-full flex-col gap-3 overflow-hidden p-4">
      <div className="flex flex-col gap-2 border-b border-panel-border pb-3">
        <div className="flex items-center gap-2">
          <input
            aria-label="Session title"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 py-0.5 font-sans text-sm font-semibold text-text-bright focus:border-panel-border focus:outline-none"
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

            {outputTokens !== undefined && (
              <div className="font-mono text-[11px] text-text-muted">Tokens: {outputTokens}</div>
            )}

            {subagents.length > 0 && (
              <div className="flex flex-wrap gap-1.5" aria-label="Subagents">
                {subagents.map((agent) => (
                  <span
                    key={agent.id}
                    className="inline-flex items-center gap-1 rounded-full border border-panel-border px-2 py-0.5 font-mono text-[11px] text-text-soft"
                  >
                    <span
                      aria-hidden
                      className={`h-1.5 w-1.5 rounded-full ${agent.state === 'working' ? 'orbital-pulse bg-text-soft' : 'bg-text-muted'}`}
                    />
                    {agent.name} · {agent.state}
                  </span>
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
              placeholder="Send a message…"
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
      <ClearDialog open={dialog === 'clear'} sessionId={id} onClose={() => setDialog(null)} />
    </Panel>
  )
}
