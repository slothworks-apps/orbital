import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { api } from '../../lib/api'
import { promptWithFiles } from '../../lib/attachedFiles'
import { modelByAnyId } from '../../lib/models'
import { tagColor, type PermissionMode, type SessionDefaults } from '../../lib/types'
import { useNow } from '../../lib/useNow'
import { Composer } from '../../panels/Composer'
import { useAttachments } from '../../panels/useAttachments'
import type { SentAttachment } from '../../store/store'
import { useOrbital } from '../../store/store'
import { ModeCards } from '../../ui/ModeCards'
import { ModelCards } from '../../ui/ModelCards'
import { CLOCK_TICK_MS } from '../constants'
import { agoLabel, basename } from '../format'
import {
  filterDirectories, noSuchDirectory, preselectMode, preselectModel, startFailureLine, type DirectoryRow,
} from '../newSession'
import { isMacAsleep, useMobile } from '../state'
import { MobileScreen, PrimaryButton, SectionLabel } from '../ui'

/**
 * 9d (spec § 6.4): a session started from the phone. Directory, mode, model
 * and a first prompt; nothing typed here outlives the screen.
 */
export function NewSessionScreen() {
  const models = useOrbital(useShallow((s) => s.models))
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
  const [prompt, setPrompt] = useState('')
  const [pending, setPending] = useState(false)
  const [notFound, setNotFound] = useState(false)
  /** Any other refused Start, in words (provisional copy). */
  const [failure, setFailure] = useState<string | null>(null)
  const attachments = useAttachments(null)

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
  const list = useMemo(() => filterDirectories(projects, cwd), [projects, cwd])
  const project = projects.find((p) => p.cwd === cwd.trim())
  const autoModel = defaults ? preselectModel({ defaults, project, models }) : (models[0]?.value ?? null)
  const model = pickedModel ?? autoModel
  const defaultModel = modelByAnyId(defaults?.model, models)?.value ?? null

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

  const start = async () => {
    if (!canStart) return
    setPending(true)
    setFailure(null)
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
          ...(refs.length > 0 ? { attachments: refs } : {}),
        },
        images,
      )
      attachments.reset()
      openSession(sessionId)
    } catch (err) {
      // Said here, never through `reportError`: its `/api/errors` POST is not the phone's to make.
      if (noSuchDirectory(err)) setNotFound(true)
      else setFailure(startFailureLine(err, macName))
      setPending(false)
    }
  }

  const header = (
    <div className="flex items-center gap-1 py-1 pl-1 pr-4">
      <button type="button" aria-label="Close" onClick={() => goBack()} className="min-h-11 min-w-11 text-[20px] text-text-soft">
        ×
      </button>
      <h1 className="text-[17px] font-semibold">New session</h1>
      <span className="ml-auto min-w-0 truncate font-mono text-[11px] text-text-muted">{mac}</span>
    </div>
  )

  const footer = (
    <div className="border-t border-panel-border bg-[rgba(5,7,13,.92)] px-4 py-3">
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
  const check = (path: string) =>
    path === chosen ? (
      <span aria-hidden className="shrink-0 text-[14px] text-accent">
        ✓
      </span>
    ) : null

  const count = list.kind === 'rows' ? list.rows.length : 0

  return (
    <MobileScreen header={header} footer={footer}>
      <SectionLabel>DIRECTORY</SectionLabel>
      <div className="px-4">
        <div className="flex items-center rounded-[10px] border border-panel-border bg-[rgba(4,8,16,.4)]">
          <input
            aria-label="Directory"
            value={cwd}
            onChange={(e) => editCwd(e.target.value)}
            placeholder="Search or type a path"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="min-h-11 min-w-0 flex-1 bg-transparent px-3 font-mono text-[14px] text-text-bright outline-none placeholder:text-text-muted"
          />
          {cwd && (
            <button type="button" aria-label="Clear" onClick={() => editCwd('')} className="min-h-11 min-w-11 text-[18px] text-text-muted">
              ×
            </button>
          )}
        </div>
        {notFound && (
          <p className="mt-1.5 flex items-center gap-2 text-[13px] text-[var(--state-input)]">
            <span aria-hidden className="font-mono font-semibold text-text-soft">
              !
            </span>
            Directory not found on {mac}
          </p>
        )}
      </div>

      {/* 9d: the list is one panel, its count line the panel's last row. */}
      <div className="mx-4 mt-2 overflow-hidden rounded-[12px] border border-panel-border bg-[rgba(255,255,255,.025)]">
        {list.kind === 'rows' &&
          list.rows.map((row) => {
            const hue = hueByCwd.get(row.cwd)
            return (
              <button
                key={row.cwd}
                type="button"
                onClick={() => editCwd(row.cwd)}
                className="flex w-full items-center gap-3 px-3.5 py-2 text-left"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    {hue !== undefined && (
                      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tagColor(hue) }} />
                    )}
                    <span className="truncate text-[15px] font-semibold text-text-bright">{basename(row.cwd)}</span>
                  </span>
                  <span className="block truncate font-mono text-[11px] text-text-muted">{row.cwd}</span>
                </span>
                {row.lastAt !== null && (
                  <span className="shrink-0 font-mono text-[11px] text-text-muted">{agoLabel(row.lastAt, now)}</span>
                )}
                {check(row.cwd)}
              </button>
            )
          })}
        {list.kind === 'use-as-is' && (
          <button type="button" onClick={() => editCwd(list.path)} className="flex w-full items-center gap-3 px-3.5 py-2 text-left">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] text-text-bright">
                Use <span className="font-mono">{list.path}</span> as is
              </span>
              <span className="block font-mono text-[11px] text-text-muted">{mac} checks it exists when the session starts</span>
            </span>
            {check(list.path)}
          </button>
        )}
        {list.kind === 'no-match' && (
          <div className="px-3.5 py-2.5">
            <p className="text-[14px] text-text-soft">No directory matches “{list.query}”</p>
            <p className="mt-0.5 font-mono text-[11px] text-text-muted">Type a full path (~/… or /…) to use any directory.</p>
          </div>
        )}
        {list.kind === 'rows' && (
          <p className="border-t border-panel-border px-3.5 py-2 text-center font-mono text-[10.5px] text-text-muted">
            {count} {cwd.trim() ? 'matching' : 'recent'}
          </p>
        )}
      </div>

      {/* The cards wait for the Mac's defaults, with nothing drawn in their place (calm). */}
      {loaded && (
        <>
          <SectionLabel>PERMISSION MODE</SectionLabel>
          <div className="px-4">
            <ModeCards value={mode} onChange={setMode} compact />
          </div>
          <SectionLabel>MODEL</SectionLabel>
          <div className="px-4">
            <ModelCards models={models} value={model} defaultValue={defaultModel} onChange={setPickedModel} compact />
          </div>
        </>
      )}

      <SectionLabel>FIRST PROMPT</SectionLabel>
      <div className="px-4 pb-6">
        <Composer
          aria-label="First prompt"
          sessionKey={{ cwd: cwd.trim() }}
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
    </MobileScreen>
  )
}
