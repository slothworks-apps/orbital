import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { api } from '../../lib/api'
import { reportError } from '../../lib/errors'
import { isListable } from '../../lib/harnessSession'
import { useNow } from '../../lib/useNow'
import { tagColor, type DraftModel, type KnownHarnessProject, type TemplateScope } from '../../lib/types'
import { holdLaunchSubscription, useOrbital } from '../../store/store'
import { lastLaunch } from '../NewSessionDialog'
import { filterPickerSessions, projectOfCwd, ranAgo, type PickerSession } from './logic'
import { KEY_WARNING, Popover, PRIMARY_BUTTON, ScopeMark, Seg, SegShell } from './parts'
import { ScopePicker } from './ScopePicker'
import type { EditorDraft } from './editorDraft'
import { toEditorDraft } from './editorDraft'

type Tab = 'fill' | 'conversation'

/** 30l's tab chips. */
function TabChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={[
        'whitespace-nowrap rounded-full border px-[11px] py-[5px] text-[11.5px] font-semibold transition-colors',
        active
          ? 'border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)] text-text-bright'
          : 'border-[rgba(150,205,255,.14)] text-[rgba(160,190,225,.7)] hover:bg-white/5',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

/** The mono second line of an example session: ▢ project · tag dots | untagged · ran … (30l). */
function SessionMeta({ session, now }: { session: PickerSession; now: number }) {
  const sep = <span className="text-[rgba(150,205,255,.3)]">·</span>
  return (
    <span className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-[rgba(160,190,225,.62)]">
      <span className="flex items-center gap-[5px] text-[rgba(220,235,255,.85)]">
        <ScopeMark scope="project" />
        {session.project}
      </span>
      {sep}
      {session.tags.length > 0 ? (
        session.tags.map((t) => (
          <span key={t.name} className="flex items-center gap-1">
            <span aria-hidden className="block h-[5px] w-[5px] rounded-full" style={{ background: tagColor(t.hue) }} />
            {t.name}
          </span>
        ))
      ) : (
        <span className="text-[rgba(160,190,225,.45)]">untagged</span>
      )}
      {session.lastAt !== null && (
        <>
          {sep}
          <span>{ranAgo(session.lastAt, now)}</span>
        </>
      )}
    </span>
  )
}

/**
 * 30l's example-session picker: every session but a drafting conversation,
 * ended ones included, from every project; newest run first; search over
 * title, project and tag.
 */
function SessionPicker({
  open,
  anchorRef,
  sessions,
  value,
  onPick,
  onClose,
}: {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  sessions: readonly PickerSession[]
  value: string | null
  onPick: (id: string | null) => void
  onClose: () => void
}) {
  const now = useNow(open, 60_000)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const rows = useMemo(() => filterPickerSessions(sessions, query), [sessions, query])
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setHighlight(0)
  }, [open])

  useEffect(() => {
    rowRefs.current[highlight]?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (rows.length === 0) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => (h + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const row = rows[highlight]
      if (row) onPick(row.id === value ? null : row.id)
    }
  }

  return (
    <Popover open={open} anchorRef={anchorRef} onClose={onClose} width={480} align="left" className="gap-0.5 p-1.5">
      <input
        autoFocus
        value={query}
        placeholder="Search sessions…"
        aria-label="Search sessions"
        onChange={(e) => {
          setQuery(e.target.value)
          setHighlight(0)
        }}
        onKeyDown={onKeyDown}
        className="mx-0.5 mb-1.5 mt-0.5 rounded-[7px] border border-[rgba(150,205,255,.16)] bg-[rgba(4,8,16,.6)] px-2.5 py-[7px] text-[12px] text-text-bright placeholder:text-[rgba(160,190,225,.55)] focus:border-[rgba(150,205,255,.32)] focus:outline-none"
      />
      <div className="px-2.5 pb-1 pt-1.5 font-mono text-[9.5px] tracking-[0.18em] text-[rgba(160,190,225,.6)]">
        RECENT · ALL PROJECTS
      </div>
      <div role="listbox" aria-label="Example session" className="flex max-h-[380px] flex-col gap-0.5 overflow-y-auto">
        {rows.map((s, i) => {
          const selected = s.id === value
          return (
            <button
              key={s.id}
              ref={(el) => {
                rowRefs.current[i] = el
              }}
              type="button"
              role="option"
              aria-selected={selected}
              onMouseEnter={() => setHighlight(i)}
              // Picking the picked one again clears it: the example is optional.
              onClick={() => onPick(selected ? null : s.id)}
              className={[
                'flex items-start gap-2.5 rounded-[7px] px-2.5 py-2 text-left transition-colors',
                selected ? 'bg-[rgba(150,205,255,.08)]' : i === highlight ? 'bg-[rgba(150,205,255,.07)]' : '',
              ].join(' ')}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="line-clamp-2 text-[12.5px] font-semibold leading-[1.38] [text-wrap:pretty]">{s.title}</span>
                <SessionMeta session={s} now={now} />
              </span>
              <span className={['mt-0.5 text-[11px] text-accent', selected ? 'visible' : 'invisible'].join(' ')}>✓</span>
            </button>
          )
        })}
        {rows.length === 0 && (
          <div className="px-2.5 py-2 font-mono text-[10.5px] text-[rgba(160,190,225,.5)]">no session matches</div>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2 border-t border-[rgba(150,205,255,.08)] px-2.5 pb-1 pt-2 font-mono text-[9.5px] tracking-[0.06em] text-[rgba(160,190,225,.45)]">
        ↑↓ move · ↵ pick · ⎋ close
        <span className="flex-1" />
        ended sessions included
      </div>
    </Popover>
  )
}

/**
 * 30l: one "Draft…" popover, two ways. "Fill this editor" asks a model for
 * a template from a description and/or an example session and hands it to
 * the editor unsaved; "In a conversation" starts a session that interviews
 * the user and writes the template into Settings as a draft. The two tabs
 * share the description, the model and the scope.
 */
export function DraftPopover({
  open,
  anchorRef,
  onClose,
  projects,
  scope,
  scopeNote,
  onScopeChange,
  cameFromRoot,
  onFill,
}: {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  projects: readonly KnownHarnessProject[]
  scope: TemplateScope
  /** The mono note after "Saves to": where the scope came from ("from the list filter"). */
  scopeNote: string | null
  onScopeChange: (scope: TemplateScope) => void
  cameFromRoot: string | null
  onFill: (draft: EditorDraft) => void
}) {
  const sessionsById = useOrbital((s) => s.sessions)
  const tags = useOrbital((s) => s.tags)
  const settings = useOrbital((s) => s.settings)
  const now = useNow(open, 60_000)
  const [tab, setTab] = useState<Tab>('fill')
  const [description, setDescription] = useState('')
  const [exampleId, setExampleId] = useState<string | null>(null)
  const [model, setModel] = useState<DraftModel>('opus')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState<'session' | 'scope' | null>(null)
  const exampleRef = useRef<HTMLButtonElement | null>(null)
  const scopeRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) {
      setPicking(null)
      setError(null)
    }
  }, [open])

  // A drafting conversation is listed nowhere, the picker included (spec § Overruled).
  const sessions = useMemo<PickerSession[]>(
    () =>
      Object.values(sessionsById)
        .filter(isListable)
        .map((s) => ({
          id: s.id,
          title: s.title || s.cwd,
          project: projectOfCwd(s.cwd, projects).name,
          tags: s.tagIds.flatMap((id) => {
            const tag = tags.find((t) => t.id === id)
            return tag ? [{ name: tag.name, hue: tag.hue }] : []
          }),
          lastAt: s.lastAt,
        })),
    [sessionsById, tags, projects],
  )
  const example = exampleId ? sessions.find((s) => s.id === exampleId) ?? null : null

  // Where the conversation runs: the scope's project, or for a global
  // template the directory the last session was started in.
  const launch = lastLaunch(settings)
  const conversationProject =
    scope.kind === 'project' ? scope.name : launch.cwd ? projectOfCwd(launch.cwd, projects).name : null

  async function fill() {
    setBusy(true)
    setError(null)
    try {
      const { template } = await api.draftHarnessTemplate({
        description: description.trim() || undefined,
        sessionId: exampleId ?? undefined,
        model,
      })
      onFill(toEditorDraft(template))
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to draft the template')
    } finally {
      setBusy(false)
    }
  }

  async function converse() {
    if (scope.kind === 'global' && !launch.cwd) {
      setError('Set a default project directory in Settings → Sessions, or launch a session once, first.')
      return
    }
    setBusy(true)
    setError(null)
    // Minted here and subscribed before the request, as `launchSession` does,
    // so nothing the session says before the subscribe is lost.
    const id = crypto.randomUUID()
    const release = holdLaunchSubscription(id)
    try {
      const { sessionId } = await api.startHarnessInterview({
        sessionId: id,
        model,
        permissionMode: launch.permissionMode,
        scope: scope.kind === 'global' ? { kind: 'global' } : { kind: 'project', root: scope.root },
        ...(scope.kind === 'global' ? { cwd: launch.cwd } : {}),
        description: description.trim() || undefined,
      })
      if (sessionId !== id) release()
      const store = useOrbital.getState()
      onClose()
      store.setDialog(null)
      await store.select(sessionId)
    } catch (err) {
      release()
      reportError(err, 'Failed to start the conversation')
    } finally {
      setBusy(false)
    }
  }

  const canFill = description.trim() !== '' || exampleId !== null
  const fieldLabel = 'text-[12px] font-semibold'

  return (
    <Popover open={open} anchorRef={anchorRef} onClose={onClose} width={440} radius={12}>
      <div className="flex items-center gap-1.5 border-b border-[rgba(150,205,255,.1)] px-3.5 py-3">
        <TabChip active={tab === 'fill'} onClick={() => setTab('fill')}>
          Fill this editor
        </TabChip>
        <TabChip active={tab === 'conversation'} onClick={() => setTab('conversation')}>
          In a conversation
        </TabChip>
      </div>

      <div className="flex flex-col gap-3 p-3.5">
        <label className="flex flex-col gap-[5px]">
          <span className={fieldLabel}>What should it do?</span>
          <textarea
            autoFocus
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="min-h-[76px] resize-none rounded-lg border border-[rgba(150,205,255,.16)] bg-[rgba(4,8,16,.6)] px-2.5 py-[9px] text-[12.5px] leading-[1.55] text-text-bright [field-sizing:content] [text-wrap:pretty] focus:border-accent/50 focus:outline-none"
          />
        </label>

        {tab === 'fill' && (
          <div className="flex flex-col gap-[5px]">
            <span className={fieldLabel}>
              Example session{' '}
              <span className="font-medium text-[rgba(160,190,225,.6)]">optional · it learns the steps from what happened</span>
            </span>
            <button
              ref={exampleRef}
              type="button"
              aria-haspopup="listbox"
              aria-expanded={picking === 'session'}
              onClick={() => setPicking(picking === 'session' ? null : 'session')}
              className={[
                'flex items-center gap-2.5 rounded-lg border bg-[rgba(4,8,16,.6)] px-2.5 py-2 text-left',
                picking === 'session' ? 'border-[rgba(150,205,255,.3)]' : 'border-[rgba(150,205,255,.16)] hover:border-[rgba(150,205,255,.3)]',
              ].join(' ')}
            >
              {example ? (
                <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                  <span className="truncate text-[12px] font-semibold">{example.title}</span>
                  <SessionMeta session={example} now={now} />
                </span>
              ) : (
                <span className="flex-1 text-[12px] text-[rgba(160,190,225,.55)]">None — pick a session it can learn from</span>
              )}
              <span className="text-[9px] text-[rgba(160,190,225,.6)]">{picking === 'session' ? '▴' : '▾'}</span>
            </button>
          </div>
        )}

        <div className="flex items-center gap-2.5">
          <span className={['w-[58px]', fieldLabel].join(' ')}>Model</span>
          <SegShell label="Model" radius={8}>
            <Seg first pad="wide" active={model === 'opus'} onClick={() => setModel('opus')}>
              Opus
            </Seg>
            <Seg pad="wide" active={model === 'sonnet'} onClick={() => setModel('sonnet')}>
              Sonnet
            </Seg>
          </SegShell>
          <span className="font-mono text-[10px] text-[rgba(160,190,225,.55)]">default · Sonnet is cheaper</span>
        </div>

        <div className="flex items-center gap-2.5">
          <span className={['w-[58px]', fieldLabel].join(' ')}>Saves to</span>
          <button
            ref={scopeRef}
            type="button"
            aria-haspopup="listbox"
            aria-expanded={picking === 'scope'}
            onClick={() => setPicking(picking === 'scope' ? null : 'scope')}
            className="flex items-center gap-[7px] rounded-[7px] border border-[rgba(150,205,255,.18)] px-2.5 py-[5px] font-mono text-[11px] text-text-bright hover:bg-white/5"
          >
            <ScopeMark scope={scope} />
            {scope.kind === 'global' ? 'Global' : scope.name}
            <span className="text-[8px] text-[rgba(160,190,225,.6)]">▾</span>
          </button>
          {scopeNote && <span className="font-mono text-[10px] text-[rgba(160,190,225,.55)]">{scopeNote}</span>}
        </div>

        {tab === 'conversation' && (
          <div className="text-[12px] leading-[1.55] text-[rgba(200,214,235,.82)] [text-wrap:pretty]">
            Opens a new session{conversationProject ? ` in ${conversationProject}` : ''} that asks you about the work, step by
            step, and then writes the template into Settings as a draft. Nothing is saved until you open it here and press
            Save.
          </div>
        )}

        {error && <div className="text-[12px] leading-[1.5]" style={{ color: KEY_WARNING }}>{error}</div>}
      </div>

      <div className="flex items-center gap-2.5 border-t border-[rgba(150,205,255,.1)] px-3.5 py-3">
        <span className="font-mono text-[9.5px] text-[rgba(160,190,225,.55)]">
          {tab === 'fill' ? 'unsaved until Save' : 'opens a new session'}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          className="whitespace-nowrap rounded-lg border border-[rgba(150,205,255,.18)] px-3 py-[7px] text-[12px] font-semibold text-[rgba(220,235,255,.9)] hover:bg-white/5"
        >
          Cancel
        </button>
        {tab === 'fill' ? (
          <button type="button" disabled={busy || !canFill} onClick={() => void fill()} className={[PRIMARY_BUTTON, 'text-[12px]'].join(' ')}>
            {busy ? 'Drafting…' : 'Draft into editor'}
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={() => void converse()} className={[PRIMARY_BUTTON, 'text-[12px]'].join(' ')}>
            Open conversation
          </button>
        )}
      </div>

      <SessionPicker
        open={open && picking === 'session'}
        anchorRef={exampleRef}
        sessions={sessions}
        value={exampleId}
        onPick={(id) => {
          setExampleId(id)
          setPicking(null)
        }}
        onClose={() => setPicking(null)}
      />
      <ScopePicker
        open={open && picking === 'scope'}
        anchorRef={scopeRef}
        projects={projects}
        value={scope}
        cameFromRoot={cameFromRoot}
        footer={(s) => `save to ${s.kind === 'global' ? 'Global' : s.name}`}
        onPick={(s) => {
          onScopeChange(s)
          setPicking(null)
        }}
        onClose={() => setPicking(null)}
      />
    </Popover>
  )
}
