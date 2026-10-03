import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { command, matches } from '../lib/keymap'
import { reportError } from '../lib/errors'
import { shortenPath } from '../lib/format'
import { canChooseDirectory, chooseDirectory } from '../lib/desktop'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Composer } from './Composer'
import { useAttachments } from './useAttachments'
import { useImageDrop } from './useImageDrop'
import { promptWithFiles } from '../lib/attachedFiles'
import { Chip } from '../ui/Chip'
import { ModeCards } from '../ui/ModeCards'
import { ModelCards } from '../ui/ModelCards'
import { CustomModelField } from '../ui/CustomModelField'
import { modelByValue, modelByAnyId } from '../lib/models'
import { permissionMode as permissionModeDescriptor } from '../lib/permissionModes'
import type { PermissionMode } from '../lib/types'

export interface NewSessionDialogProps {
  open: boolean
  onClose: () => void
}

/** Delay before firing `previewRule` after cwd/mode settle — avoids a
 * request per keystroke while typing a path. */
const PREVIEW_DEBOUNCE_MS = 300

/**
 * What the dialog opens with: the previous launch's choices, read back from
 * the settings table (`new_session_last_*`), falling back to the Settings
 * defaults until something has been launched. The model needs no key of its
 * own — it already follows the directory through `remember_model_per_project`.
 * See `docs/decisions/the-new-session-dialog-remembers-the-last-launch.md`.
 *
 * `bypassPermissions` is never carried over: a mode that never asks is picked
 * on purpose each time, not inherited from the last sandbox. The tag is only
 * stored when it was a manual pick, and belongs to the directory it was picked
 * for — anywhere else the rules decide.
 */
export function lastLaunch(settings: Record<string, string | undefined>): {
  cwd: string
  permissionMode: PermissionMode
  tag: { cwd: string; tagId: number } | null
} {
  const fallbackMode = (settings.default_permission_mode as PermissionMode) || 'acceptEdits'
  const storedMode = settings.new_session_last_mode as PermissionMode | undefined
  const lastCwd = settings.new_session_last_cwd || ''
  const tagId = Number(settings.new_session_last_tag)
  return {
    cwd: lastCwd || settings.default_project_dir || '',
    permissionMode:
      storedMode && storedMode !== 'bypassPermissions' && permissionModeDescriptor(storedMode)
        ? storedMode
        : fallbackMode,
    tag: lastCwd && settings.new_session_last_tag && Number.isInteger(tagId) ? { cwd: lastCwd, tagId } : null,
  }
}

/**
 * What an open starts from: `lastLaunch`, unless a planet is selected — then
 * that session's directory and its tag (the first that still exists), so the
 * new planet lands next to it. The mode stays the last launch's. The planet's
 * tag is not a hand pick (`pickedByHand` is false), so a launch does not store
 * it. A planet without a tag falls back to the remembered tag when the
 * directory is the same, and to the rules otherwise.
 */
export function openingLaunch(
  settings: Record<string, string | undefined>,
  selected: { cwd: string; tagIds: number[] } | null,
  tags: Array<{ id: number }>,
): {
  cwd: string
  permissionMode: PermissionMode
  tag: { cwd: string; tagId: number; pickedByHand: boolean } | null
} {
  const last = lastLaunch(settings)
  const cwd = selected?.cwd || last.cwd
  const planetTagId = selected?.cwd ? selected.tagIds.find((id) => tags.some((t) => t.id === id)) : undefined
  if (planetTagId != null) {
    return { cwd, permissionMode: last.permissionMode, tag: { cwd, tagId: planetTagId, pickedByHand: false } }
  }
  // A tag deleted since the launch is not preselected.
  const remembered =
    last.tag && last.tag.cwd === cwd && tags.some((t) => t.id === last.tag!.tagId)
      ? { ...last.tag, pickedByHand: true }
      : null
  return { cwd, permissionMode: last.permissionMode, tag: remembered }
}

/**
 * Stores a launch's choices for the next open. Fire-and-forget, like the
 * Settings panel's last section: a failed write costs the next open its
 * prefill and nothing else.
 */
function rememberLaunch(patch: Record<string, string>) {
  useOrbital.setState((state) => ({ settings: { ...state.settings, ...patch } }))
  void api.patchSettings(patch).catch(() => {})
}

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
 * Spawns a new session (artboard 1d). cwd is a plain text `Input`; in the
 * desktop app 1d's "Browse…" beside it opens the native folder picker. A
 * browser and the phone have no picker of their own, so they get no button.
 * The tag row auto-matches the cwd/mode against the tag-rule engine via
 * `previewRule`, debounced, and stays in sync with cwd/mode changes until
 * the user manually picks a different tag — after that, the manual choice
 * wins over any further auto-match. The MODEL group
 * (canvas 4b) mirrors that same manual-override pattern for the model pick.
 * Each open starts from the previous launch's choices, or from the selected
 * planet — see `openingLaunch`.
 */
export function NewSessionDialog({ open, onClose }: NewSessionDialogProps) {
  const settings = useOrbital(useShallow((s) => s.settings))
  const tags = useOrbital(useShallow((s) => s.tags))
  const rules = useOrbital(useShallow((s) => s.rules))
  const models = useOrbital(useShallow((s) => s.models))
  const select = useOrbital((s) => s.select)
  const selectedSession = useOrbital((s) => (s.ui.selectedId ? (s.sessions[s.ui.selectedId] ?? null) : null))
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
  /**
   * The tag the dialog opened with and the directory it belongs to: the
   * previous launch's manual pick or the selected planet's tag.
   */
  const [rememberedTag, setRememberedTag] = useState<{ cwd: string; tagId: number; pickedByHand: boolean } | null>(
    null,
  )

  const canBrowse = canChooseDirectory()
  const browse = useCallback(() => {
    chooseDirectory(cwd)
      .then((dir) => {
        if (dir) setCwd(dir)
      })
      .catch((err: unknown) => reportError(err, 'Could not open the folder picker'))
  }, [cwd])

  // Image intake, the same pair the detail panel mounts (spec:
  // 2026-09-20-composer-design § Image intake; canvas 9d-D). `null` is the
  // session id: this dialog has none until Launch, so the bytes go through
  // `POST /api/attachments` instead — the same handler, one route up. The drop
  // TARGET is the dialog surface rather than the well, for 9c-1's reason ("a
  // 418 px well is too small a thing to aim at while holding a file"), so the
  // ref goes to `Dialog`.
  const attachments = useAttachments(null)
  const { armed: dropArmed, ref: dropTargetRef } = useImageDrop((files, folders) =>
    attachments.accept(files, 'file', folders),
  )
  /** Stable across renders (`useAttachments` memoises it), so it can be an effect dep. */
  const resetAttachments = attachments.reset

  // Reset + prefill from settings on the false -> true transition only (not
  // on every re-render while already open, which would clobber typing).
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const opening = openingLaunch(settings, selectedSession, tags)
      setCwd(opening.cwd)
      setPermissionMode(opening.permissionMode)
      setPrompt('')
      setRememberedTag(opening.tag)
      setTagId(opening.tag?.tagId ?? null)
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
    // Settings, tags and the selected planet are read on the open transition only: a launch writes
    // its choices back while the dialog is closing, and that must not re-run
    // the reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, resetAttachments])

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
          if (manualOverride) return
          setTagId(rememberedTag?.cwd === cwd.trim() ? rememberedTag.tagId : matched)
        })
        .catch(() => {
          // Preview is best-effort; leave whatever tag selection stands.
        })
    }, PREVIEW_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [open, cwd, permissionMode, manualOverride, rememberedTag])

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
      const { images, files } = attachments.armed
        ? await attachments.takeForSend()
        : { images: [], files: [] }
      const refs = images.map((image) => image.entry.ref)
      // Through the store, not `api.createSession` directly: the launch has to
      // subscribe to the new session's topic before its request goes out, and
      // the socket is the store's to reach.
      // See `docs/fixes/first-turn-can-outrun-the-ws-subscription.md`.
      const sessionId = await launchSession({
        cwd: cwd.trim(),
        prompt: promptWithFiles(prompt, files.map((file) => file.path)),
        permissionMode,
        tagId: tagId ?? undefined,
        model: model ?? undefined,
        // Omitted rather than sent empty: absent and `[]` mean the same thing to
        // the server, and every existing body assertion stays true.
        ...(refs.length > 0 ? { attachments: refs } : {}),
      }, images)
      // A tag is remembered only when it was the user's pick — this launch's,
      // or the previous one's left standing — never a rule's match or the
      // selected planet's tag.
      const pickedTag =
        tagId != null &&
        (manualOverride ||
          (rememberedTag?.pickedByHand && rememberedTag.cwd === cwd.trim() && rememberedTag.tagId === tagId))
      rememberLaunch({
        new_session_last_cwd: cwd.trim(),
        new_session_last_mode: permissionMode,
        new_session_last_tag: pickedTag ? String(tagId) : '',
      })
      onClose()
      await select(sessionId)
    } catch (err) {
      reportError(err, 'Failed to launch session')
    } finally {
      setPending(false)
    }
  }, [cwd, prompt, permissionMode, tagId, manualOverride, rememberedTag, model, pending, awaitingCustomModel, onClose, select, launchSession, attachments])

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
            <div className="flex gap-2">
              <Input
                id="new-session-cwd"
                font="mono"
                size="lg"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="/path/to/project"
                className="min-w-0 flex-1"
              />
              {canBrowse && (
                <Button variant="ghost" size="field" onClick={browse}>
                  Browse…
                </Button>
              )}
            </div>
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
