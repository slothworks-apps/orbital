import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { api } from '../../lib/api'
import { promptWithFiles } from '../../lib/attachedFiles'
import { tagColor, type OrbitalModel, type PermissionMode, type SessionDefaults } from '../../lib/types'
import { timeAgo } from '../../lib/format'
import { useClaudeDirModels } from '../../lib/useClaudeDirModels'
import { useNow } from '../../lib/useNow'
import { Composer } from '../../panels/Composer'
import { useAttachments } from '../../panels/useAttachments'
import type { SentAttachment } from '../../store/store'
import { useOrbital } from '../../store/store'
import { ModeCards } from '../../ui/ModeCards'
import { CLOCK_TICK_MS } from '../constants'
import { basename, homePath } from '../format'
import {
  filterDirectories, noSuchDirectory, prefillClaudeDir, preselectMode, preselectModel, startFailureLine,
  type DirectoryRow,
} from '../newSession'
import { isMacAsleep, useMobile } from '../state'
import { FieldLabel, MobileScreen, PrimaryButton, SheetPresence } from '../ui'
import { ClaudeDirPicker } from './ClaudeDirPicker'
import { McpjsonSheet } from './McpjsonSheet'
import { undecidedBeforeLaunch, type McpjsonAnswers, type McpjsonDecisions, type McpjsonServer } from '../../lib/mcpjson'

/** 9d: past this many rows the directory list folds to a window, "Show all N" under it. */
const COLLAPSED_ROWS = 3
/** The folded window's height: three and a half rows, so the cut reads as "more below". */
const COLLAPSED_LIST_PX = 196

/**
 * 9d (spec § 6.4): a session started from the phone. Directory, mode, model
 * and a first prompt; nothing typed here outlives the screen.
 */
export function NewSessionScreen() {
  const tags = useOrbital((s) => s.tags)
  const sessions = useOrbital((s) => s.sessions)
  const launchSession = useOrbital((s) => s.launchSession)
  const { asleep, macName } = useMobile(useShallow((s) => ({ asleep: isMacAsleep(s), macName: s.macName })))
  const goBack = useMobile((s) => s.goBack)
  const openSession = useMobile((s) => s.openSession)
  const now = useNow(true, CLOCK_TICK_MS)
  const mac = macName ?? 'Your Mac'

  /** `undefined` while the two reads run; `null` when the defaults could not be read. */
  const [defaults, setDefaults] = useState<SessionDefaults | null | undefined>(undefined)
  const [projects, setProjects] = useState<DirectoryRow[]>([])
  const [cwd, setCwd] = useState('')
  const [mode, setMode] = useState<PermissionMode>('acceptEdits')
  /** A model picked by hand; until then the preselection follows the directory. */
  const [pickedModel, setPickedModel] = useState<string | null>(null)
  /** A Claude directory picked by hand; until then the Mac's prefill (`prefillClaudeDir`). */
  const [pickedDir, setPickedDir] = useState<number | null>(null)
  const [prompt, setPrompt] = useState('')
  const [pending, setPending] = useState(false)
  const [notFound, setNotFound] = useState(false)
  /** Any other refused Start, in words (provisional copy). */
  const [failure, setFailure] = useState<string | null>(null)
  const attachments = useAttachments(null)
  const [listOpen, setListOpen] = useState(false)
  /**
   * The `.mcp.json` question (spec 2026-10-08-mcpjson-approval-design; canvas
   * 47c/47d): the servers Start found undecided and the answers so far. Set,
   * it is a sheet over this form, which stays as it was underneath.
   */
  const [question, setQuestion] = useState<{ servers: McpjsonServer[]; answers: McpjsonAnswers } | null>(null)

  useEffect(() => {
    let current = true
    void Promise.allSettled([api.sessionDefaults(), api.listProjects()]).then(([d, p]) => {
      if (!current) return
      if (p.status === 'fulfilled') setProjects(p.value)
      const read = d.status === 'fulfilled' ? d.value : null
      if (read) setMode(preselectMode(read))
      setDefaults(read)
    })
    return () => {
      current = false
    }
  }, [])

  const loaded = defaults !== undefined
  const dirs = defaults?.claudeDirs ?? []
  const choosesDir = dirs.length >= 2
  const prefill = choosesDir && defaults ? prefillClaudeDir(defaults) : null
  const claudeDirId = choosesDir ? (pickedDir ?? prefill?.id ?? null) : null
  /** 44d's hint beside the row: where the choice came from. */
  const claudeDirHint =
    pickedDir !== null && pickedDir !== prefill?.id ? 'changed' : prefill?.from === 'last' ? 'last launch' : 'default'
  /** The chosen directory's catalog: each account has its own models. */
  const models = useClaudeDirModels(claudeDirId)

  const list = useMemo(() => filterDirectories(projects, cwd), [projects, cwd])
  const project = projects.find((p) => p.cwd === cwd.trim())
  const autoModel = defaults ? preselectModel({ defaults, project, models }) : (models[0]?.value ?? null)
  const model = pickedModel ?? autoModel

  /** The tag dot of a session the phone holds in each directory. */
  const hueByCwd = useMemo(() => {
    const hues = new Map<string, number>()
    for (const s of Object.values(sessions)) {
      const tag = tags.find((t) => t.id === s.tagIds[0])
      if (tag && !hues.has(s.cwd)) hues.set(s.cwd, tag.hue)
    }
    return hues
  }, [sessions, tags])

  const editCwd = (next: string) => {
    setCwd(next)
    setNotFound(false)
    setFailure(null)
  }

  // An upload still in flight holds Start back: the launch sends only what has landed.
  const canStart = Boolean(cwd.trim() && prompt.trim()) && !pending && !asleep && !attachments.uploading

  /**
   * Start: asks about the project's undecided `.mcp.json` servers first, when
   * it has any (47e "Trigger"); a project without starts as it always did.
   */
  const start = async () => {
    if (!canStart) return
    setPending(true)
    setFailure(null)
    const servers = await undecidedBeforeLaunch(cwd.trim(), claudeDirId ?? undefined)
    if (servers.length > 0) {
      setPending(false)
      setQuestion({ servers, answers: {} })
      return
    }
    await launch()
  }

  const launch = async (mcpjson?: McpjsonDecisions) => {
    setPending(true)
    // Read off the chips, not taken out of the well: a refused directory
    // leaves them where they are, and the next Start sends them again.
    const images: SentAttachment[] = []
    const files: string[] = []
    for (const chip of attachments.items) {
      if (chip.state !== 'uploaded' || !chip.entry || chip.exiting) continue
      if ('ref' in chip.entry) images.push({ entry: chip.entry, name: chip.name, source: chip.source })
      else files.push(chip.entry.path)
    }
    try {
      const refs = images.map((image) => image.entry.ref)
      const sessionId = await launchSession(
        {
          cwd: cwd.trim(),
          prompt: promptWithFiles(prompt, files),
          permissionMode: mode,
          model: model ?? undefined,
          requireDirectory: true,
          // Only when the choice was offered; the Mac remembers it for the next prefill.
          ...(claudeDirId !== null ? { claudeDirId } : {}),
          ...(refs.length > 0 ? { attachments: refs } : {}),
          ...(mcpjson ? { mcpjson } : {}),
        },
        images,
      )
      attachments.reset()
      openSession(sessionId)
    } catch (err) {
      // The refusal is said on the form, under its field or its Start.
      setQuestion(null)
      // Said here, never through `reportError`: its `/api/errors` POST is not the phone's to make.
      if (noSuchDirectory(err)) setNotFound(true)
      else setFailure(startFailureLine(err, macName))
      setPending(false)
    }
  }

  const header = (
    <div className="flex h-13 items-center gap-1.5 px-1.5">
      <button
        type="button"
        aria-label="Close"
        onClick={() => goBack()}
        className="grid h-11 w-11 place-items-center text-[22px] text-[rgba(220,235,255,.85)]"
      >
        ×
      </button>
      <h1 className="flex-1 text-[17px] font-bold">New session</h1>
      <span className="flex min-w-0 items-center gap-1.5 pr-3.5 font-mono text-[11px] text-[rgba(160,190,225,.7)]">
        <span
          aria-hidden
          className={[
            'block h-1.5 w-1.5 shrink-0 rounded-full',
            asleep ? 'border border-[rgba(200,215,235,.6)]' : 'bg-[oklch(85%_.12_205)]',
          ].join(' ')}
        />
        <span className="truncate">{mac}</span>
      </span>
    </div>
  )

  const footer = (
    <div className="border-t border-[rgba(150,205,255,.08)] px-4 pb-1.5 pt-2.5">
      <PrimaryButton onClick={() => void start()} disabled={!canStart}>
        {asleep ? `Start · needs ${mac} awake` : 'Start session'}
      </PrimaryButton>
      {failure && (
        <p role="alert" className="mt-2 text-center text-[13px] text-[var(--state-input)]">
          {failure}
        </p>
      )}
    </div>
  )

  /** The row the field already names wears the ✓ (9d). */
  const chosen = cwd.trim()
  const check = (path: string) => (
    <span aria-hidden className={['w-3 shrink-0 font-mono text-[12px] text-[oklch(85%_.12_205)]', path === chosen ? '' : 'opacity-0'].join(' ')}>
      ✓
    </span>
  )
  const picked = (path: string) => (path === chosen ? 'bg-[oklch(85%_.12_205/.08)]' : '')

  const typed = cwd.trim() !== ''
  const rows = list.kind === 'rows' ? list.rows : []
  const canExpand = rows.length > COLLAPSED_ROWS
  const hint = !typed ? 'ten most recent' : list.kind === 'use-as-is' ? 'no match · typed path' : `${rows.length} on ${mac}`
  const fieldBorder = notFound
    ? 'border-[oklch(70%_.14_25/.7)]'
    : typed
      ? 'border-[oklch(85%_.12_205/.55)]'
      : 'border-[rgba(150,205,255,.18)]'

  return (
    <MobileScreen header={header} footer={footer}>
      <div className="flex flex-col gap-[18px] px-4 py-3.5">
        <div className="flex flex-col gap-2">
          <FieldLabel hint={hint}>DIRECTORY</FieldLabel>
          <div className={['flex h-13 items-center gap-2 rounded-[14px] border bg-[rgba(4,8,16,.6)] pl-3.5 pr-1.5', fieldBorder].join(' ')}>
            <input
              aria-label="Directory"
              value={cwd}
              onChange={(e) => editCwd(e.target.value)}
              placeholder="Search or type a path"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="h-full min-w-0 flex-1 bg-transparent font-mono text-[13px] text-text-bright outline-none placeholder:text-text-muted"
            />
            {cwd && (
              <button
                type="button"
                aria-label="Clear"
                onClick={() => editCwd('')}
                className="grid h-11 w-11 shrink-0 place-items-center text-[18px] text-[rgba(160,190,225,.7)]"
              >
                ×
              </button>
            )}
          </div>
          {notFound && (
            <p className="flex items-center gap-2 px-1 text-[12.5px] text-[oklch(80%_.1_25)]">
              <span aria-hidden className="font-mono text-[11px]">
                !
              </span>
              Directory not found on {mac}
            </p>
          )}

          {/* 9d: one panel; past COLLAPSED_ROWS it folds to a window with "Show all N" under it. */}
          <div className="overflow-hidden rounded-[14px] border border-[rgba(150,205,255,.12)] bg-[rgba(10,16,28,.6)]">
            <div
              className="overflow-y-auto overscroll-contain transition-[max-height] duration-[320ms] ease-[cubic-bezier(.2,.8,.25,1)]"
              style={{ maxHeight: listOpen || !canExpand ? undefined : COLLAPSED_LIST_PX }}
            >
              {rows.map((row, i) => {
                const hue = hueByCwd.get(row.cwd)
                return (
                  <button
                    key={row.cwd}
                    type="button"
                    onClick={() => editCwd(row.cwd)}
                    className={[
                      'flex min-h-14 w-full items-center gap-3 px-3.5 py-2 text-left',
                      i > 0 ? 'border-t border-[rgba(150,205,255,.08)]' : '',
                      picked(row.cwd),
                    ].join(' ')}
                  >
                    <span
                      aria-hidden
                      className="block h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: hue !== undefined ? tagColor(hue) : 'var(--state-neutral)' }}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-[14px] font-bold text-text-bright">{basename(row.cwd)}</span>
                      <span className="truncate font-mono text-[11px] text-[rgba(160,190,225,.65)]">{homePath(row.cwd)}</span>
                    </span>
                    {row.lastAt !== null && (
                      <span className="shrink-0 font-mono text-[10.5px] text-[rgba(160,190,225,.5)]">{timeAgo(row.lastAt, now)}</span>
                    )}
                    {check(row.cwd)}
                  </button>
                )
              })}
              {list.kind === 'use-as-is' && (
                <button
                  type="button"
                  onClick={() => editCwd(list.path)}
                  className={['flex min-h-15 w-full items-center gap-3 px-3.5 py-2.5 text-left', picked(list.path)].join(' ')}
                >
                  <span aria-hidden className="block h-1.5 w-1.5 shrink-0 rounded-full border-[1.3px] border-[rgba(200,215,235,.55)]" />
                  <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                    <span className="truncate text-[14px] font-semibold text-text-bright">
                      Use <span className="font-mono text-[12.5px] font-normal">{list.path}</span> as is
                    </span>
                    <span className="text-[11.5px] leading-[1.4] text-[rgba(160,190,225,.6)]">{mac} checks it exists when the session starts</span>
                  </span>
                  {check(list.path)}
                </button>
              )}
              {list.kind === 'no-match' && (
                <div className="flex flex-col gap-[3px] p-3.5">
                  <span className="text-[14px] font-semibold text-[rgba(232,238,248,.85)]">No directory matches “{list.query}”</span>
                  <span className="text-[11.5px] text-[rgba(160,190,225,.6)]">Type a full path (~/… or /…) to use any directory.</span>
                </div>
              )}
            </div>
            {canExpand && (
              <button
                type="button"
                aria-expanded={listOpen}
                onClick={() => setListOpen(!listOpen)}
                className="flex h-11 w-full items-center justify-center gap-2 border-t border-[rgba(150,205,255,.12)] bg-[rgba(4,8,16,.5)] font-mono text-[11px] text-[rgba(200,220,245,.8)]"
              >
                <span aria-hidden className="text-[9px] text-[rgba(160,190,225,.6)]">
                  {listOpen ? '▴' : '▾'}
                </span>
                {listOpen ? 'Show less' : `Show all ${rows.length}`}
              </button>
            )}
          </div>
        </div>

        {/* The cards wait for the Mac's defaults, with nothing drawn in their place (calm). */}
        {loaded && (
          <>
            {/* Canvas 44d: right under DIRECTORY and before the mode and the
                model, because the directory's account decides which models are
                offered. Only with two or more. */}
            {choosesDir && (
              <ClaudeDirPicker
                dirs={dirs}
                value={claudeDirId}
                hint={claudeDirHint}
                onChange={(id) => {
                  // A model picked from another account's catalog may not be in this one.
                  if (id !== claudeDirId) setPickedModel(null)
                  setPickedDir(id)
                }}
              />
            )}
            <div className="flex flex-col gap-1.5">
              <FieldLabel>PERMISSION MODE</FieldLabel>
              <ModeCards value={mode} onChange={setMode} touch />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel>MODEL</FieldLabel>
              <ModelSegments models={models} value={model} onChange={setPickedModel} />
            </div>
          </>
        )}

        <div className="flex flex-col gap-1.5">
          <FieldLabel>FIRST PROMPT</FieldLabel>
        <Composer
          aria-label="First prompt"
          sessionKey={claudeDirId !== null ? { cwd: cwd.trim(), claudeDir: claudeDirId } : { cwd: cwd.trim() }}
          value={prompt}
          onChange={setPrompt}
          enter="newline"
          placement="below"
          variant="dialog"
          hint=""
          placeholder="What should Claude do?"
          attachments={attachments}
        />
        </div>
      </div>
      <SheetPresence>
        {question && (
          <McpjsonSheet
            servers={question.servers}
            answers={question.answers}
            project={basename(cwd.trim())}
            macName={macName ?? 'your Mac'}
            pending={pending}
            onAnswer={(name, answer) => setQuestion((q) => (q ? { ...q, answers: { ...q.answers, [name]: answer } } : q))}
            onStart={(decisions) => void launch(decisions)}
            onBack={() => setQuestion(null)}
          />
        )}
      </SheetPresence>
    </MobileScreen>
  )
}

/**
 * 9d's model picker: segments, not the desktop's cards — the phone names the
 * model and nothing more. 9d draws one row of four; the catalog comes from the
 * SDK and is often longer, so the segments wrap four to a row.
 */
function ModelSegments({ models, value, onChange }: { models: OrbitalModel[]; value: string | null; onChange: (value: string) => void }) {
  if (models.length === 0) {
    return (
      <p className="rounded-[12px] border border-[rgba(150,205,255,.18)] bg-[rgba(4,8,16,.5)] px-3.5 py-3 text-[11.5px] leading-[1.4] text-[rgba(160,190,225,.7)]">
        The model list could not be read. The session uses whatever model Claude Code is set to.
      </p>
    )
  }
  return (
    <div
      role="radiogroup"
      aria-label="Model"
      className="grid grid-cols-4 gap-px overflow-hidden rounded-[12px] border border-[rgba(150,205,255,.18)] bg-[rgba(150,205,255,.12)]"
    >
      {models.map((m) => {
        const active = m.value === value
        return (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(m.value)}
            className={[
              // The 1px gap over the container's fill draws 9d's separators, between rows too.
              'h-11 min-w-0 truncate px-1 font-mono text-[12.5px]',
              active
                ? 'bg-[color-mix(in_oklab,oklch(85%_.12_205)_10%,#070b13)] font-semibold text-[oklch(85%_.12_205)]'
                : 'bg-[#070b13] text-[rgba(220,235,255,.85)]',
            ].join(' ')}
          >
            {m.shortVersion}
          </button>
        )
      })}
      {/* Fill the last row so the separators do not show through as a block. */}
      {Array.from({ length: (4 - (models.length % 4)) % 4 }, (_, i) => (
        <span key={`pad-${i}`} aria-hidden className="bg-[#070b13]" />
      ))}
    </div>
  )
}
