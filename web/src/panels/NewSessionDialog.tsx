import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { shortenPath } from '../lib/format'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Input, TextArea } from '../ui/Input'
import { Chip } from '../ui/Chip'
import { ModeCards } from '../ui/ModeCards'
import { ModelCards } from '../ui/ModelCards'
import { modelByValue, modelByAnyId } from '../lib/models'
import type { PermissionMode } from '../lib/types'

export interface NewSessionDialogProps {
  open: boolean
  onClose: () => void
}

/** Delay before firing `previewRule` after cwd/mode settle — avoids a
 * request per keystroke while typing a path. */
const PREVIEW_DEBOUNCE_MS = 300

/** Group kicker from canvas 1d: mono 10px, .16em tracking, 8px to the control. */
function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  const className =
    'flex items-center gap-2 font-mono text-[10px] tracking-[0.16em] text-[rgba(160,190,225,.6)]'
  return htmlFor ? (
    <label htmlFor={htmlFor} className={className}>
      {children}
    </label>
  ) : (
    <span className={className}>{children}</span>
  )
}

/**
 * Spawns a new session (artboard 1d). cwd is a plain text `Input` — Browse
 * is deferred to a later version (no filesystem picker in v1; the input
 * alone suffices for pasting/typing a path), so 1d's "Browse…" button is
 * intentionally absent. The tag row auto-matches the cwd/mode against the
 * tag-rule engine via `previewRule`, debounced, and stays in sync with
 * cwd/mode changes until the user manually picks a different tag — after
 * that, the manual choice wins over any further auto-match. The MODEL group
 * (canvas 4b) mirrors that same manual-override pattern for the model pick.
 */
export function NewSessionDialog({ open, onClose }: NewSessionDialogProps) {
  const settings = useOrbital(useShallow((s) => s.settings))
  const tags = useOrbital(useShallow((s) => s.tags))
  const rules = useOrbital(useShallow((s) => s.rules))
  const models = useOrbital(useShallow((s) => s.models))
  const select = useOrbital((s) => s.select)
  const launchSession = useOrbital((s) => s.launchSession)

  const [cwd, setCwd] = useState('')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('acceptEdits')
  const [prompt, setPrompt] = useState('')
  const [tagId, setTagId] = useState<number | null>(null)
  const [manualOverride, setManualOverride] = useState(false)
  const [matchedTagId, setMatchedTagId] = useState<number | null>(null)
  const [matchedRuleId, setMatchedRuleId] = useState<number | null>(null)
  const [model, setModel] = useState<string | null>(null)
  /** Once the user picks a model, a later cwd change must not move it. */
  const [modelOverridden, setModelOverridden] = useState(false)
  const [projects, setProjects] = useState<Array<{ cwd: string; lastModel: string | null }>>([])
  const [pending, setPending] = useState(false)

  // Reset + prefill from settings on the false -> true transition only (not
  // on every re-render while already open, which would clobber typing).
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setCwd(settings.default_project_dir ?? '')
      setPermissionMode(((settings.default_permission_mode as PermissionMode) || 'acceptEdits'))
      setPrompt('')
      setTagId(null)
      setManualOverride(false)
      setMatchedTagId(null)
      setMatchedRuleId(null)
      setModel(null)
      setModelOverridden(false)
      setPending(false)
      api
        .listProjects()
        .then(setProjects)
        .catch(() => {
          // Recent-dirs chips are a convenience; the cwd input still works without them.
        })
    }
    wasOpenRef.current = open
  }, [open, settings.default_project_dir, settings.default_permission_mode])

  // Preselection, in the order 4b describes: this project's last model when
  // the toggle allows it, otherwise the Settings default, otherwise the first
  // row the catalog offers (the default may name a model this install does
  // not have). A manual pick wins over all of it.
  const rememberPerProject = settings.remember_model_per_project !== 'false'
  const lastModelHere = projects.find((p) => p.cwd === cwd.trim())?.lastModel ?? null
  // A terminal-launched session only ever has a `resolved_model` (`GET
  // /api/projects` returns it honestly, never the SDK `value`), so this has
  // to accept either kind of id — see `modelByAnyId`.
  const lastModelRow = modelByAnyId(lastModelHere, models)
  useEffect(() => {
    if (!open || modelOverridden || models.length === 0) return
    const remembered = rememberPerProject ? lastModelRow : undefined
    const fromSettings = modelByValue(settings.default_model, models)
    setModel((remembered ?? fromSettings ?? models[0]).value)
  }, [open, modelOverridden, models, rememberPerProject, lastModelRow, settings.default_model])

  // Debounced auto-match: re-preview whenever cwd or permission mode
  // changes, and (unless the user has manually overridden) adopt the match.
  useEffect(() => {
    if (!open || !cwd.trim()) {
      setMatchedTagId(null)
      setMatchedRuleId(null)
      return
    }
    const timer = setTimeout(() => {
      api
        .previewRule({ cwd, title: '', permissionMode })
        .then(({ tagId: matched, ruleId }) => {
          setMatchedTagId(matched)
          setMatchedRuleId(ruleId)
          if (!manualOverride) setTagId(matched)
        })
        .catch(() => {
          // Preview is best-effort; leave whatever tag selection stands.
        })
    }, PREVIEW_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [open, cwd, permissionMode, manualOverride])

  function handleSelectTag(id: number) {
    setManualOverride(true)
    setTagId((current) => (current === id ? current : id))
  }

  const handleLaunch = useCallback(async () => {
    if (!cwd.trim() || pending) return
    setPending(true)
    try {
      // Through the store, not `api.createSession` directly: the launch has to
      // subscribe to the new session's topic before its request goes out, and
      // the socket is the store's to reach.
      // See `docs/fixes/first-turn-can-outrun-the-ws-subscription.md`.
      const sessionId = await launchSession({
        cwd: cwd.trim(),
        prompt,
        permissionMode,
        tagId: tagId ?? undefined,
        model: model ?? undefined,
      })
      onClose()
      await select(sessionId)
    } catch (err) {
      reportError(err, 'Failed to launch session')
    } finally {
      setPending(false)
    }
  }, [cwd, prompt, permissionMode, tagId, model, pending, onClose, select, launchSession])

  // ⌘↵ / Ctrl+↵ launches from anywhere in the dialog.
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        void handleLaunch()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, handleLaunch])

  const matchedRule = matchedRuleId != null ? rules.find((r) => r.id === matchedRuleId) : undefined
  const showAutoCaption = !manualOverride && matchedTagId != null && tagId === matchedTagId
  const selectedTag = tagId != null ? tags.find((t) => t.id === tagId) : undefined
  const fallbackTag = tags.find((t) => t.is_default === 1)
  const footerTagName = (selectedTag ?? fallbackTag)?.name

  return (
    <Dialog
      open={open}
      title="New session"
      eyebrow="LAUNCH"
      size="lg"
      onClose={onClose}
      footerCaption={
        // canvas 4b: unconditional summary line — `Sonnet 4.5 · acceptEdits · search-indexer`.
        <>
          {modelByValue(model, models)?.shortVersion ?? 'default model'} · {permissionMode}
          {footerTagName ? <> · <span className="text-text-soft">{footerTagName.toUpperCase()}</span></> : null}
        </>
      }
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="lg"
            onClick={() => void handleLaunch()}
            disabled={pending || !cwd.trim()}
          >
            Launch session <span className="font-mono text-[10px] opacity-70">⌘⏎</span>
          </Button>
        </>
      }
    >
      {/* 20px between field groups, 8px inside one (canvas 1d). */}
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <FieldLabel htmlFor="new-session-cwd">PROJECT DIRECTORY</FieldLabel>
          <Input
            id="new-session-cwd"
            font="mono"
            size="lg"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/path/to/project"
          />
          {projects.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Recent directories">
              <span className="mr-0.5 shrink-0 font-mono text-[10px] tracking-[0.08em] text-[rgba(160,190,225,.5)]">
                RECENT
              </span>
              {/* Recent paths are mono pills in 1d (3px/9px, 10.5px), not the
                  sans tag chips the TAG row uses — kept as plain buttons. */}
              {projects.slice(0, 4).map(({ cwd: dir }) => (
                <button
                  key={dir}
                  type="button"
                  title={dir}
                  data-active={dir === cwd}
                  onClick={() => setCwd(dir)}
                  className="rounded-full border border-panel-border px-[9px] py-[3px] font-mono text-[10.5px] text-[rgba(200,220,245,.75)] transition-colors hover:border-accent/40 data-[active=true]:border-accent/50 data-[active=true]:text-text-bright"
                >
                  {shortenPath(dir)}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <FieldLabel>
            MODEL
            <span aria-hidden className="flex-1" />
            {rememberPerProject && lastModelRow && (
              // canvas 4b: right-hand note, .06em tracking. Renders the
              // matched row's shortVersion (never a raw id) and only when
              // something actually matched — F1.
              <span className="tracking-[0.06em] text-[rgba(160,190,225,.5)]">
                last used here: {lastModelRow.shortVersion}
              </span>
            )}
          </FieldLabel>
          <ModelCards
            models={models}
            value={model}
            defaultValue={settings.default_model ?? null}
            onChange={(next) => {
              setModelOverridden(true)
              setModel(next)
            }}
          />
        </div>

        <div className="flex flex-col gap-2">
          <FieldLabel>PERMISSION MODE</FieldLabel>
          <ModeCards value={permissionMode} onChange={setPermissionMode} />
        </div>

        <div className="flex flex-col gap-2">
          <FieldLabel>
            TAG
            {showAutoCaption && (
              <span className="tracking-[0.04em] text-[rgba(160,190,225,.45)]">
                · auto-matched by rule{matchedRule ? ` ${matchedRule.pattern}` : ''}
              </span>
            )}
          </FieldLabel>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Tag">
            {tags.map((tag) => (
              <Chip
                key={tag.id}
                label={tag.name}
                hue={tag.hue}
                active={tagId === tag.id}
                onClick={() => handleSelectTag(tag.id)}
              />
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <FieldLabel htmlFor="new-session-prompt">FIRST PROMPT</FieldLabel>
          <TextArea
            id="new-session-prompt"
            aria-label="First prompt"
            size="lg"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should this session do?"
            rows={4}
            className="min-h-24 resize-y"
          />
        </div>
      </div>
    </Dialog>
  )
}
