import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { command, matches } from '../lib/keymap'
import { reportError } from '../lib/errors'
import { shortenPath } from '../lib/format'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Composer } from './Composer'
import { useAttachments } from './useAttachments'
import { useImageDrop } from './useImageDrop'
import { Chip } from '../ui/Chip'
import { ModeCards } from '../ui/ModeCards'
import { ModelCards } from '../ui/ModelCards'
import { CustomModelField } from '../ui/CustomModelField'
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
  /**
   * The Other card is selected. `model` then stays null until the field
   * validates an id, and Launch waits for it.
   */
  const [otherActive, setOtherActive] = useState(false)
  /** A remembered custom id the field starts from, already trusted. */
  const [customInitial, setCustomInitial] = useState<string | null>(null)
  const [projects, setProjects] = useState<Array<{ cwd: string; lastModel: string | null }>>([])
  const [pending, setPending] = useState(false)

  // Image intake, the same pair the detail panel mounts (spec:
  // 2026-09-20-composer-design § Image intake; canvas 9d-D). `null` is the
  // session id: this dialog has none until Launch, so the bytes go through
  // `POST /api/attachments` instead — the same handler, one route up. The drop
  // TARGET is the dialog surface rather than the well, for 9c-1's reason ("a
  // 418 px well is too small a thing to aim at while holding a file"), so the
  // ref goes to `Dialog`.
  const attachments = useAttachments(null)
  const { armed: dropArmed, ref: dropTargetRef } = useImageDrop((files) =>
    attachments.accept(files, 'file'),
  )
  /** Stable across renders (`useAttachments` memoises it), so it can be an effect dep. */
  const resetAttachments = attachments.reset

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
      setOtherActive(false)
      setCustomInitial(null)
      setPending(false)
      api
        .listProjects()
        .then(setProjects)
        .catch(() => {
          // Recent-dirs chips are a convenience; the cwd input still works without them.
        })
    }
    // Closing drops the chips and aborts whatever was still uploading — a
    // dialog that was dismissed is not a turn that will be sent. The chips a
    // LAUNCH took are already gone from the list by then, so a queued launch
    // waiting on its uploads is untouched by this.
    if (!open && wasOpenRef.current) resetAttachments()
    wasOpenRef.current = open
  }, [open, settings.default_project_dir, settings.default_permission_mode, resetAttachments])

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
  //
  // An id no catalog row names — a model picked through Other that has run
  // here, or a custom Settings default — preselects Other with that id
  // already trusted: it has run or been validated before, so it is not
  // probed again.
  useEffect(() => {
    if (!open || modelOverridden || models.length === 0) return
    const preferred = (rememberPerProject ? lastModelHere : null) || settings.default_model || null
    const row = modelByAnyId(preferred, models)
    if (preferred && !row) {
      setOtherActive(true)
      setCustomInitial(preferred)
      setModel(preferred)
    } else {
      setOtherActive(false)
      setModel((row ?? models[0]).value)
    }
  }, [open, modelOverridden, models, rememberPerProject, lastModelHere, settings.default_model])

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

  /** Other is selected but no id has validated yet. */
  const awaitingCustomModel = otherActive && model === null

  const handleLaunch = useCallback(async () => {
    if (!cwd.trim() || pending || awaitingCustomModel) return
    setPending(true)
    try {
      // The queued launch — the dialog's version of the panel's queued send
      // (spec § Send). The refs have to travel in the launch request itself, so
      // an upload still in flight is WAITED for rather than dropped:
      // `takeForSend` empties the well now and resolves with whatever landed. A
      // failed chip is not in the turn and stays behind, so this is skipped
      // entirely when nothing is armed.
      const images = attachments.armed ? await attachments.takeForSend() : []
      const refs = images.map((image) => image.entry.ref)
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
        // Omitted rather than sent empty: absent and `[]` mean the same thing to
        // the server, and every existing body assertion stays true.
        ...(refs.length > 0 ? { attachments: refs } : {}),
      }, images)
      onClose()
      await select(sessionId)
    } catch (err) {
      reportError(err, 'Failed to launch session')
    } finally {
      setPending(false)
    }
  }, [cwd, prompt, permissionMode, tagId, model, pending, awaitingCustomModel, onClose, select, launchSession, attachments])

  // `composer.start` launches from anywhere in the dialog.
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matches(command('composer.start').chords[0], e)) {
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
  // What the launch would actually carry, which is what the footer promises: a
  // failed chip is not in the turn (it says so itself, on the chip), and a chip
  // mid-exit is already gone as far as the summary is concerned.
  const chipCount = attachments.items.filter((c) => c.state !== 'failed' && !c.exiting).length

  return (
    <Dialog
      open={open}
      title="New session"
      eyebrow="LAUNCH"
      size="lg"
      onClose={onClose}
      surfaceRef={dropTargetRef}
      dropArmed={dropArmed}
      footerCaption={
        // canvas 4b: unconditional summary line — `Sonnet 4.5 · acceptEdits · search-indexer`.
        // 9d-D puts the attachment count in front of it (`1 image · spawns a new
        // planet in WORK`): the footer is where the session's shape is
        // summarised, and what it is carrying is part of that shape. The count
        // leads because it is the part that just changed.
        <>
          {/* One template string, not JSX text: a trailing space before a
              newline is stripped by JSX, which would run the count straight
              into the model name. */}
          {chipCount > 0 && `${chipCount} image${chipCount === 1 ? '' : 's'} · `}
          {modelByValue(model, models)?.shortVersion ?? (otherActive && model ? model : 'default model')} · {permissionMode}
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
            disabled={pending || !cwd.trim() || awaitingCustomModel}
          >
            Launch session <span className="font-mono text-[10px] opacity-70">⌘⏎</span>
          </Button>
        </>
      }
    >
      {/* 20px between field groups, 8px inside one (canvas 1d). */}
      <div className="flex flex-col gap-5">
        {/* Everything but FIRST PROMPT steps back to .35 while a drop is armed —
            9c-1's "the transcript drops to 35 % so nothing competes", read into
            this mount: the marker is the only lit thing, and the field it
            replaces is the only group that keeps its brightness. The groups are
            wrapped rather than dimmed one by one so the 20px rhythm survives. */}
        <div
          data-content-dim
          className={['flex flex-col gap-5', dropArmed ? 'opacity-35' : ''].join(' ')}
        >
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
                setOtherActive(false)
                setModel(next)
              }}
              other={{
                active: otherActive,
                onSelect: () => {
                  if (otherActive) return
                  setModelOverridden(true)
                  setOtherActive(true)
                  setCustomInitial(null)
                  setModel(null)
                },
              }}
            />
            {otherActive && (
              <CustomModelField
                // Remounts when preselection swaps in another remembered id.
                key={customInitial ?? ''}
                size="lg"
                initial={customInitial ? { id: customInitial, trusted: true } : undefined}
                onValidated={(id) => setModel(id)}
                onCleared={() => setModel(null)}
              />
            )}
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
        </div>

        <div className="flex flex-col gap-2">
          <FieldLabel htmlFor="new-session-prompt">FIRST PROMPT</FieldLabel>
          {/* The same control the detail panel mounts (canvas 9d), image intake
              included (9d-D shows a chip in this very field). Four differences,
              all props: ⏎ newlines here because a first prompt is written in
              paragraphs and Start is two inches away; the popup opens BELOW,
              since this field has room under it; completions resolve against the
              chosen directory, which is the only thing the dialog has to teach
              it; and the drop target is the dialog surface, which is why
              `dropArmed` arrives from a hook mounted up there rather than here.
              ⌘⏎ still launches from anywhere — the document listener above
              handles it, and neither the composer nor its popup touches an
              Enter carrying a modifier.

              The uploads go through `POST /api/attachments`, the sessionless
              door: this dialog's session does not exist until Launch, and the
              refs travel in that same launch request. */}
          <Composer
            id="new-session-prompt"
            aria-label="First prompt"
            sessionKey={{ cwd: cwd.trim() }}
            value={prompt}
            onChange={setPrompt}
            enter="newline"
            placement="below"
            variant="dialog"
            hint="⏎ newline · ⌘⏎ start session · ⌘V paste image"
            placeholder="What should this session do?"
            attachments={attachments}
            dropArmed={dropArmed}
          />
        </div>
      </div>
    </Dialog>
  )
}
