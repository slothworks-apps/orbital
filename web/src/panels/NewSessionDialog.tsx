import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { command, matches, shortcutLabel } from '../lib/keymap'
import { reportError } from '../lib/errors'
import { blocksLaunch, directoryLine, useDirectoryState } from '../lib/useDirectoryState'
import { shortenPath } from '../lib/format'
import { canChooseDirectory, chooseDirectory } from '../lib/desktop'
import { Dialog } from '../ui/Dialog'
import { useEscapeLayer } from '../ui/escapeLayer'
import { isDemo } from '../lib/demo'
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
import { claudeDirPrefill, nextClaudeDir } from '../lib/claudeDirs'
import { useClaudeDirMonograms } from '../ui/ClaudeDirMark'
import {
  CLAUDE_DIR_SEGMENTS_MAX,
  ClaudeDirHeaderControl,
  ClaudeDirSegments,
  claudeDirOriginHint,
  type ClaudeDirOrigin,
} from './ClaudeDirChoice'
import { useClaudeDirModels } from '../lib/useClaudeDirModels'
import { permissionMode as permissionModeDescriptor } from '../lib/permissionModes'
import type { PermissionMode, Tag } from '../lib/types'
import {
  answerSummary,
  decisionsOf,
  questionTitle,
  undecidedBeforeLaunch,
  type McpjsonAnswers,
  type McpjsonDecisions,
  type McpjsonServer,
} from '../lib/mcpjson'
import { McpjsonIntro, McpjsonRows } from './McpjsonQuestion'
import { ProjectFileViewer } from './FileViewer'
import { FolderChooser } from './FolderChooser'
import {
  LOCAL_DEVICE, deviceChips, deviceOf, deviceOptions, localTagOf, openingDevice, showDeviceRow,
} from '../lib/devices'
import { Select } from '../ui/Select'
import { KindGlyph } from '../ui/KindGlyph'

export interface NewSessionDialogProps {
  open: boolean
  onClose: () => void
}

/** Delay before firing `previewRule` after cwd/mode settle — avoids a
 * request per keystroke while typing a path. */
const PREVIEW_DEBOUNCE_MS = 300

/**
 * The device the last launch from this dialog went to (canvas 50g: the
 * DEVICE field defaults to it). Kept in this browser rather than in the
 * settings table: a device id means something only to the device reading it.
 */
const LAST_DEVICE_KEY = 'orbital.newSession.device'

function rememberedDevice(): string | null {
  try {
    return globalThis.localStorage?.getItem(LAST_DEVICE_KEY) ?? null
  } catch {
    return null
  }
}

function rememberDevice(id: string) {
  try {
    globalThis.localStorage?.setItem(LAST_DEVICE_KEY, id)
  } catch {
    // A lost default costs the next open its device, nothing else.
  }
}

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
    'flex items-center gap-2 font-mono fs-10 tracking-[0.16em] text-ink-900/60'
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
  const claudeDirs = useOrbital(useShallow((s) => s.claudeDirs))
  const defaultClaudeDir = useOrbital((s) => s.defaultClaudeDir)
  const lastClaudeDir = useOrbital((s) => s.lastClaudeDir)
  const select = useOrbital((s) => s.select)
  const selectedSession = useOrbital((s) => (s.ui.selectedId ? (s.sessions[s.ui.selectedId] ?? null) : null))
  /** The selected planet when it runs here: another device's Claude directory ids mean nothing on this one. */
  const localPlanet = selectedSession && !selectedSession.machine ? selectedSession : null
  const launchSession = useOrbital((s) => s.launchSession)
  // The roster only while the dialog is open: `remote` is replaced on every
  // status publish, and a closed dialog has no picker to keep current.
  const members = useOrbital((s) => (open ? s.remote?.group?.members : undefined))

  const [cwd, setCwd] = useState('')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('acceptEdits')
  const [prompt, setPrompt] = useState('')
  const [tagId, setTagId] = useState<number | null>(null)
  const [manualOverride, setManualOverride] = useState(false)
  const [matchedTagId, setMatchedTagId] = useState<number | null>(null)
  /** + New tag's name field while it is open (canvas `Feature - Tag chips` 80c), and the tag it made this time. */
  const [newTagDraft, setNewTagDraft] = useState<string | null>(null)
  const [madeTagId, setMadeTagId] = useState<number | null>(null)
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
  const [projects, setProjects] = useState<Array<{ cwd: string; lastModel: string | null; lastAt: number | null }>>([])
  /** Where the session runs (canvas 50g): `LOCAL_DEVICE` or a member's id. */
  const [device, setDevice] = useState<string>(LOCAL_DEVICE)
  /** The folder chooser of another device is open over the fields (50g). */
  const [chooserOpen, setChooserOpen] = useState(false)
  const [pending, setPending] = useState(false)
  /**
   * The tag the dialog opened with and the directory it belongs to: the
   * previous launch's manual pick or the selected planet's tag.
   */
  const [rememberedTag, setRememberedTag] = useState<{ cwd: string; tagId: number; pickedByHand: boolean } | null>(
    null,
  )
  /**
   * The Claude directory the session runs under (spec
   * 2026-10-04-multiple-claude-directories-design § 3). Only offered with two
   * or more configured; null when the server named none.
   */
  const [claudeDirId, setClaudeDirId] = useState<number | null>(null)
  /** What prefilled the choice as the dialog opened — the hint beside its label says so (canvas 44c). */
  const [claudeDirPrefilled, setClaudeDirPrefilled] = useState<Omit<ClaudeDirOrigin, 'changed'> & { id: number | null }>(
    { id: null, from: 'default' },
  )
  /**
   * The `.mcp.json` question (spec 2026-10-08-mcpjson-approval-design; canvas
   * 47a/47b): the servers Launch found undecided and the answers so far. Set,
   * it takes the dialog's place; the form stays mounted underneath, so Back
   * finds every field as it was.
   */
  const [question, setQuestion] = useState<{ servers: McpjsonServer[]; answers: McpjsonAnswers } | null>(null)
  /**
   * Launch found the directory missing (spec
   * 2026-10-12-new-session-missing-directory-design § 2): the path, `~`
   * expanded, that *Create and launch* makes. Set, it takes the dialog's
   * place like the `.mcp.json` question does.
   */
  const [missingDir, setMissingDir] = useState<string | null>(null)
  /** The project file a question row's *View file* opened (canvas 2d). */
  const [viewing, setViewing] = useState<{ name: string; file: string } | null>(null)
  // Canvas 50g: the DEVICE field shows only once a second device can host
  // sessions; with one device the dialog is exactly as it was.
  const deviceRow = showDeviceRow(deviceChips(members))
  // Re-read on each open too, so `seen 2h ago` is not as old as the roster.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const options = useMemo(() => deviceOptions(members, Date.now()), [members, open])
  const remote = device !== LOCAL_DEVICE
  /** The `machine` every request about the new session names; absent for this device. */
  const machine = remote ? device : undefined
  const deviceName = options.find((o) => o.id === device)?.name ?? device
  const showDevice = deviceRow || remote
  // Another device's Claude directories are its own: ids from here mean
  // nothing there, so the choice is offered for this device only.
  const choosesDir = claudeDirs.length >= 2 && !remote
  const claudeDirMonograms = useClaudeDirMonograms()
  const claudeDirName = claudeDirs.find((d) => d.id === claudeDirId)?.name ?? null
  const claudeDirOrigin: ClaudeDirOrigin = {
    from: claudeDirPrefilled.from,
    planet: claudeDirPrefilled.planet,
    changed: claudeDirId !== claudeDirPrefilled.id,
  }
  /** The chosen directory's catalog: each account has its own models; another device's default one's there. */
  const models = useClaudeDirModels(remote ? null : claudeDirId, open, machine)

  const canBrowse = canChooseDirectory()
  /** Only the last request's projects land: switching device twice quickly must not show the first's. */
  const projectsTicket = useRef(0)
  /**
   * The chosen device's recent directories (canvas 50g RECENT PER DEVICE).
   * `fill` puts the most recent one into an empty field, or `fallback` when
   * the device has none.
   */
  const loadProjects = useCallback((id: string, fill: false | { fallback: string }) => {
    const ticket = ++projectsTicket.current
    api
      .listProjects(id === LOCAL_DEVICE ? undefined : id)
      .then((list) => {
        if (ticket !== projectsTicket.current) return
        setProjects(list)
        if (fill) setCwd((typed) => (typed.trim() ? typed : (list[0]?.cwd ?? fill.fallback)))
      })
      .catch(() => {
        // Recent-dirs chips are a convenience; the cwd input still works without them.
        if (ticket === projectsTicket.current && fill) setCwd((typed) => (typed.trim() ? typed : fill.fallback))
      })
  }, [])

  /** Switching device swaps the recent directories and resets the field to that device's last one (50g). */
  const switchDevice = useCallback(
    (id: string) => {
      setDevice(id)
      setChooserOpen(false)
      setProjects([])
      setCwd('')
      // A model picked by hand was picked from the last device's catalog; the
      // next one's may not have it. Dropping the override re-runs the
      // preselection below, which sets the model and Other again — now and
      // once the device's own catalog lands.
      setModelOverridden(false)
      loadProjects(id, { fallback: id === LOCAL_DEVICE ? lastLaunch(settings).cwd : '' })
    },
    [loadProjects, settings],
  )
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
      const planetDevice = selectedSession?.cwd ? deviceOf(selectedSession) : undefined
      const startDevice = deviceRow ? openingDevice(options, rememberedDevice(), planetDevice) : LOCAL_DEVICE
      // The selected planet lends its directory only on its own device; the
      // last launch's directory is this device's.
      const planet = planetDevice === startDevice ? selectedSession : null
      const opening = openingLaunch(settings, planet, tags)
      const startCwd = planet || startDevice === LOCAL_DEVICE ? opening.cwd : ''
      setDevice(startDevice)
      setChooserOpen(false)
      setCwd(startCwd)
      setPermissionMode(opening.permissionMode)
      setPrompt('')
      setRememberedTag(opening.tag)
      setTagId(opening.tag?.tagId ?? null)
      setManualOverride(false)
      setMatchedTagId(null)
      setMatchedRuleId(null)
      setNewTagDraft(null)
      setMadeTagId(null)
      setModel(null)
      setModelOverridden(false)
      setOtherActive(false)
      setCustomInitial(null)
      setPending(false)
      setQuestion(null)
      setMissingDir(null)
      setViewing(null)
      const prefill = claudeDirPrefill({
        dirs: claudeDirs,
        planet: localPlanet?.claudeDirId,
        last: lastClaudeDir,
        fallback: defaultClaudeDir,
      })
      setClaudeDirId(prefill?.id ?? null)
      setClaudeDirPrefilled({
        id: prefill?.id ?? null,
        from: prefill?.from ?? 'default',
        planet: prefill?.from === 'planet' ? localPlanet?.title : undefined,
      })
      setProjects([])
      // Another device without a planet to start from opens on its most recent directory.
      loadProjects(startDevice, startDevice !== LOCAL_DEVICE && !startCwd ? { fallback: '' } : false)
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

  // A dialog opened before the directory list arrived (a reload with the
  // dialog in the URL) had nothing to prefill from on the open transition;
  // prefill once the list lands, unless the user already chose.
  useEffect(() => {
    if (!open || claudeDirId !== null || claudeDirs.length === 0) return
    const prefill = claudeDirPrefill({
      dirs: claudeDirs,
      planet: localPlanet?.claudeDirId,
      last: lastClaudeDir,
      fallback: defaultClaudeDir,
    })
    if (!prefill) return
    setClaudeDirId(prefill.id)
    setClaudeDirPrefilled({
      id: prefill.id,
      from: prefill.from,
      planet: prefill.from === 'planet' ? localPlanet?.title : undefined,
    })
  }, [open, claudeDirId, claudeDirs, localPlanet, lastClaudeDir, defaultClaudeDir])

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
    let live = true
    const timer = setTimeout(() => {
      // Another device's rules decide its sessions' tags: its answer names its
      // own tag, read here as this device's tag of the same name, and its own
      // rule, which this device's list does not hold.
      const preview = machine
        ? Promise.all([api.previewRule({ cwd, title: '', permissionMode, machine }), api.listTags(machine)]).then(
            ([answer, theirs]) => ({ tagId: localTagOf(answer.tagId, theirs, tags), ruleId: null }),
          )
        : api.previewRule({ cwd, title: '', permissionMode })
      preview
        .then(({ tagId: matched, ruleId }) => {
          if (!live) return
          setMatchedTagId(matched)
          setMatchedRuleId(ruleId)
          if (manualOverride) return
          setTagId(rememberedTag?.cwd === cwd.trim() ? rememberedTag.tagId : matched)
        })
        .catch(() => {
          // Preview is best-effort; leave whatever tag selection stands.
        })
    }, PREVIEW_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [open, cwd, permissionMode, manualOverride, rememberedTag, machine, tags])

  function handleSelectTag(id: number) {
    setManualOverride(true)
    setTagId((current) => (current === id ? current : id))
  }

  /** Other is selected but no id has validated yet. */
  const awaitingCustomModel = otherActive && model === null

  const dirState = useDirectoryState(cwd, open, machine)
  const dirLine = directoryLine(dirState, remote ? deviceName : 'this Mac')

  /** The launch itself, with the question's answers when it was asked. */
  const launch = useCallback(async (mcpjson?: McpjsonDecisions) => {
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
        // A directory gone between Launch's check and the spawn is refused,
        // not written as a session that never runs.
        requireDirectory: true,
        // Only when the choice was offered: with one directory nothing changes.
        ...(choosesDir && claudeDirId !== null ? { claudeDirId } : {}),
        // Omitted rather than sent empty: absent and `[]` mean the same thing to
        // the server, and every existing body assertion stays true.
        ...(refs.length > 0 ? { attachments: refs } : {}),
        ...(mcpjson ? { mcpjson } : {}),
        ...(machine ? { machine } : {}),
      }, images)
      // A tag is remembered only when it was the user's pick — this launch's,
      // or the previous one's left standing — never a rule's match or the
      // selected planet's tag.
      const pickedTag =
        tagId != null &&
        (manualOverride ||
          (rememberedTag?.pickedByHand && rememberedTag.cwd === cwd.trim() && rememberedTag.tagId === tagId))
      // The directory and its tag are this device's to remember: another
      // device's path would prefill a field that asks this one.
      rememberLaunch(
        remote
          ? { new_session_last_mode: permissionMode }
          : {
              new_session_last_cwd: cwd.trim(),
              new_session_last_mode: permissionMode,
              new_session_last_tag: pickedTag ? String(tagId) : '',
            },
      )
      if (showDevice) rememberDevice(device)
      // The server stores the directory choice itself (the phone cannot write
      // settings); the store only learns it for the next open.
      if (choosesDir && claudeDirId !== null) useOrbital.setState({ lastClaudeDir: claudeDirId })
      onClose()
      await select(sessionId)
    } catch (err) {
      reportError(err, 'Failed to launch session')
    } finally {
      setPending(false)
    }
  }, [cwd, prompt, permissionMode, tagId, manualOverride, rememberedTag, model, choosesDir, claudeDirId, onClose, select, launchSession, attachments, machine, remote, showDevice, device])

  /**
   * Launch: asks about the project's undecided `.mcp.json` servers first,
   * when it has any; a project without launches as it always did. Nothing
   * spawns until the question is answered (47e "Trigger").
   */
  const handleLaunch = useCallback(async () => {
    if (!cwd.trim() || pending || awaitingCustomModel) return
    setPending(true)
    setChooserOpen(false)
    // Asked again rather than read off the line: the field may have changed
    // since its answer, and a folder may have been made meanwhile. A failed
    // ask launches, and `requireDirectory` still refuses a missing directory.
    const dir = await api.directoryState(cwd.trim(), machine).catch(() => null)
    if (dir && dir.state !== 'directory') {
      setPending(false)
      if (dir.state === 'missing') setMissingDir(dir.path)
      return
    }
    const servers = await undecidedBeforeLaunch(
      cwd.trim(),
      choosesDir && claudeDirId !== null ? claudeDirId : undefined,
      machine,
    )
    if (servers.length > 0) {
      setPending(false)
      setQuestion({ servers, answers: {} })
      return
    }
    await launch()
  }, [cwd, pending, awaitingCustomModel, choosesDir, claudeDirId, launch, machine])

  /**
   * *Create and launch*. A directory just made has no `.mcp.json` to ask
   * about, so the launch goes straight out.
   */
  const handleCreateAndLaunch = useCallback(async () => {
    if (!missingDir || pending) return
    setPending(true)
    try {
      await api.createDirectory(missingDir, machine)
    } catch (err) {
      setPending(false)
      reportError(err, 'Could not create the folder')
      return
    }
    setMissingDir(null)
    await launch()
  }, [missingDir, pending, launch, machine])

  const decisions = question ? decisionsOf(question.servers, question.answers) : null

  /** Start session: only once every server has an answer (47e). */
  const handleStart = useCallback(async () => {
    if (!decisions || pending) return
    await launch(decisions)
  }, [decisions, pending, launch])

  /** ← Back and esc: the launch is cancelled, the form is where it was (47e "Back / dismiss"). */
  const backToForm = useCallback(() => {
    setQuestion(null)
    setMissingDir(null)
    setViewing(null)
  }, [])

  // `composer.start` launches from anywhere in the dialog, and
  // `composer.next-claude-dir` steps to the next Claude directory in Settings
  // order, skipping missing ones (canvas 44f "Keyboard").
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matches(command('composer.start').chords[0], e)) {
        e.preventDefault()
        void (missingDir ? handleCreateAndLaunch() : question ? handleStart() : handleLaunch())
      } else if (!question && !missingDir && choosesDir && matches(command('composer.next-claude-dir').chords[0], e)) {
        e.preventDefault()
        setClaudeDirId((current) => nextClaudeDir(claudeDirs, current))
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, question, missingDir, handleLaunch, handleStart, handleCreateAndLaunch, choosesDir, claudeDirs])

  const matchedRule = matchedRuleId != null ? rules.find((r) => r.id === matchedRuleId) : undefined
  const showAutoCaption = !manualOverride && matchedTagId != null && tagId === matchedTagId
  // Canvas `Feature - Tag chips` 80c: while + New tag is a field the caption says what Enter does.
  const tagHint =
    newTagDraft != null
      ? existingTag(tags, newTagDraft)
        ? '· already a tag · Enter picks it'
        : '· Enter creates · esc cancels'
      : madeTagId != null && tagId === madeTagId
        ? '· new tag · no rules yet'
        : showAutoCaption
          ? `· auto-matched by rule${matchedRule ? ` ${matchedRule.pattern}` : ''}`
          : null
  const selectedTag = tagId != null ? tags.find((t) => t.id === tagId) : undefined
  const fallbackTag = tags.find((t) => t.is_default === 1)
  const footerTagName = (selectedTag ?? fallbackTag)?.name
  // What the launch would actually carry, which is what the footer promises: a
  // failed chip is not in the turn (it says so itself, on the chip), and a chip
  // mid-exit is already gone as far as the summary is concerned.
  const chipCount = attachments.items.filter((c) => c.state !== 'failed' && !c.exiting).length

  const projectName = cwd.trim().replace(/\/+$/, '').split('/').pop() ?? ''

  const ready = decisions !== null
  // The question swaps the dialog's content in the same shell (47a): the
  // header, the footer and the body change; the frame does not move.
  const questionShell = question
    ? {
        title: questionTitle(question.servers.length),
        // 47a: the launch's eyebrow, naming the project.
        eyebrow: `LAUNCH · ${projectName.toUpperCase()}`,
        onClose: backToForm,
        headerAction: undefined,
        headerMeta: question.servers.length > 1 ? `${question.servers.length} servers` : undefined,
        lead: <McpjsonIntro count={question.servers.length} where={remote ? deviceName : undefined} />,
        bodyInset: 'list' as const,
        footerLead: (
          <Button variant="ghost" size="lg" onClick={backToForm}>
            ← Back
          </Button>
        ),
        footerCaption: answerSummary(question.servers, question.answers),
        footer: (
          <Button
            variant={ready ? 'primary' : 'primary-unready'}
            size="lg"
            aria-disabled={!ready || undefined}
            disabled={pending}
            onClick={() => void handleStart()}
          >
            Start session
            {/* 47a/47e: the keycap inside the button — a dark wash on the
                accent fill, a hairline on the outline. */}
            <span
              className={[
                'rounded-[5px] font-mono fs-13 font-medium tracking-[0.04em]',
                ready ? 'bg-space-deep/14 px-1.5 py-0.5' : 'border border-line/12 px-[5px] py-px',
              ].join(' ')}
            >
              {shortcutLabel('composer.start')}
            </span>
          </Button>
        ),
      }
    : null

  // The missing-directory question, in the same shell (spec
  // 2026-10-12-new-session-missing-directory-design § 2). Copy and layout
  // provisional until the canvas draws it.
  const missingDirShell = missingDir
    ? {
        title: 'Create this folder?',
        eyebrow: `LAUNCH · ${projectName.toUpperCase()}`,
        onClose: backToForm,
        headerAction: undefined,
        footerLead: (
          <Button variant="ghost" size="lg" onClick={backToForm}>
            ← Back
          </Button>
        ),
        footerCaption: undefined,
        footer: (
          <Button variant="primary" size="lg" disabled={pending} onClick={() => void handleCreateAndLaunch()}>
            Create and launch <span className="font-mono fs-10 opacity-70">{shortcutLabel('composer.start')}</span>
          </Button>
        ),
      }
    : null

  return (
    <>
      <Dialog
        open={open}
        title="New session"
        eyebrow="LAUNCH"
        size="lg"
        onClose={onClose}
        surfaceRef={dropTargetRef}
        dropArmed={dropArmed && !question && !missingDir}
        headerAction={
          choosesDir && claudeDirs.length > CLAUDE_DIR_SEGMENTS_MAX ? (
            <ClaudeDirHeaderControl
              dirs={claudeDirs}
              monograms={claudeDirMonograms}
              value={claudeDirId}
              defaultId={defaultClaudeDir}
              origin={claudeDirOrigin}
              onChange={setClaudeDirId}
            />
          ) : undefined
        }
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
            {/* 50g `gFoot`: the device, once there is a choice of one. */}
            {showDevice ? ` · on ${remote ? deviceName : 'this device'}` : null}
            {choosesDir && claudeDirName ? ` · under ${claudeDirName}` : null}
            {footerTagName ? <> · <span className="text-ink-300">{footerTagName.toUpperCase()}</span></> : null}
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
              disabled={pending || !cwd.trim() || awaitingCustomModel || blocksLaunch(dirState)}
            >
              Launch session <span className="font-mono fs-10 opacity-70">⌘⏎</span>
            </Button>
          </>
        }
        {...questionShell}
        {...missingDirShell}
      >
        {/* Hidden rather than unmounted while the question is up, so Back
            finds every field — the custom model's text included — as it was. */}
        <div hidden={question !== null || missingDir !== null}>
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
              {showDevice && (
                // Canvas 50g DEVICE FIRST: above the directory, which only
                // means something on a device.
                <div className="flex flex-col gap-2">
                  <FieldLabel>
                    <span id="new-session-device">DEVICE</span>
                    <span aria-hidden className="flex-1" />
                    <span className="tracking-[0.06em] text-ink-900/50">where the session runs</span>
                  </FieldLabel>
                  <Select
                    variant="device"
                    aria-labelledby="new-session-device"
                    className="w-full"
                    value={device}
                    onChange={switchDevice}
                    footer="PHONES DRIVE SESSIONS · THEY DON'T RUN THEM"
                    options={options.map((o) => ({
                      value: o.id,
                      label: o.label,
                      sub: o.sub,
                      inert: o.inert,
                      glyph: <KindGlyph kind={o.kind} untitled />,
                    }))}
                  />
                </div>
              )}

              {/* Relative and above the groups after it: the folder chooser hangs over them (50g). */}
              <div className="relative z-[2] flex flex-col gap-2">
                <FieldLabel htmlFor="new-session-cwd">
                  PROJECT DIRECTORY
                  {remote && <span className="tracking-[0.04em] text-ink-900/60">on {deviceName}</span>}
                </FieldLabel>
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
                  {remote ? (
                    // Only this desktop has a system dialog; another device gets the chooser (50g).
                    <Button
                      variant="ghost"
                      size="field"
                      title={`Browses ${deviceName}’s folders`}
                      aria-expanded={chooserOpen}
                      onClick={() => setChooserOpen((o) => !o)}
                    >
                      Browse {deviceName}…
                    </Button>
                  ) : (
                    canBrowse && (
                      <Button variant="ghost" size="field" onClick={browse}>
                        Browse…
                      </Button>
                    )
                  )}
                </div>
                {dirLine && (
                  // Copy and colour provisional until the canvas draws the line.
                  <p className="flex items-center gap-2 px-0.5 fs-12 text-[oklch(80%_.1_70)]">
                    <span aria-hidden className="font-mono fs-11">!</span>
                    {dirLine}
                  </p>
                )}
                {projects.length > 0 && (
                  <div
                    className={['flex flex-wrap items-center gap-1.5', chooserOpen ? 'invisible' : ''].join(' ')}
                    role="group"
                    aria-label="Recent directories"
                  >
                    <span className="mr-0.5 shrink-0 font-mono fs-10 tracking-[0.08em] text-ink-900/50">
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
                        className="rounded-full border border-line/14 px-[9px] py-[3px] font-mono fs-10.5 text-ink-500/75 transition-colors hover:border-accent/40 data-[active=true]:border-accent/50 data-[active=true]:text-ink-100"
                      >
                        {shortenPath(dir)}
                      </button>
                    ))}
                  </div>
                )}
                {chooserOpen && remote && (
                  <FolderChooser
                    // A fresh chooser per device: it opens where that device's field points.
                    key={device}
                    machine={device}
                    name={deviceName}
                    kind={options.find((o) => o.id === device)?.kind ?? 'headless'}
                    start={cwd}
                    recents={projects}
                    onChoose={(path) => {
                      setCwd(path)
                      setChooserOpen(false)
                    }}
                    onCancel={() => setChooserOpen(false)}
                  />
                )}
              </div>

              {/* Canvas 44c: two or three directories sit in the form, between the
                  project and the model, because the directory decides which models
                  are offered. Four or more move to the header control. */}
              {choosesDir && claudeDirs.length <= CLAUDE_DIR_SEGMENTS_MAX && (
                <div className="flex flex-col gap-2">
                  <FieldLabel>
                    <span className="shrink-0 whitespace-nowrap">PROFILE</span>
                    <span className="min-w-0 truncate tracking-[0.04em] text-ink-900/60">
                      · {claudeDirOriginHint(claudeDirOrigin)}
                    </span>
                    <span aria-hidden className="flex-1" />
                    {/* Plain text, never a keycap box: a box would read as a second mark (44f). */}
                    <span
                      title="Next profile — skips missing ones"
                      className="shrink-0 whitespace-nowrap tracking-[0.04em] text-ink-900/50"
                    >
                      {shortcutLabel('composer.next-claude-dir')} next
                    </span>
                  </FieldLabel>
                  <ClaudeDirSegments dirs={claudeDirs} value={claudeDirId} onChange={setClaudeDirId} />
                </div>
              )}

              <div className="flex flex-col gap-2">
                <FieldLabel>
                  MODEL
                  {choosesDir && claudeDirName && (
                    <span className="tracking-[0.04em] text-ink-900/60">· offered by {claudeDirName}’s account</span>
                  )}
                  <span aria-hidden className="flex-1" />
                  {rememberPerProject && lastModelRow && (
                    // canvas 4b: right-hand note, .06em tracking. Renders the
                    // matched row's shortVersion (never a raw id) and only when
                    // something actually matched — F1.
                    <span className="tracking-[0.06em] text-ink-900/50">
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
                    // Remounts when preselection swaps in another remembered id, or the
                    // directory changes: the same id is checked again under the new account.
                    key={`${claudeDirId ?? ''}:${customInitial ?? ''}`}
                    size="lg"
                    initial={customInitial ? { id: customInitial, trusted: true } : undefined}
                    onValidated={(id) => setModel(id)}
                    onCleared={() => setModel(null)}
                    claudeDir={choosesDir && claudeDirId !== null ? claudeDirId : undefined}
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
                  {tagHint && <span className="tracking-[0.04em] text-ink-900/60">{tagHint}</span>}
                </FieldLabel>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Tag">
                  {tags.map((tag) => (
                    <Chip
                      key={tag.id}
                      size="field"
                      label={tag.name}
                      hue={tag.hue}
                      active={tagId === tag.id}
                      onClick={() => handleSelectTag(tag.id)}
                    />
                  ))}
                  {/* Not in the website's demo, whose fake server keeps no tags it did not start with. */}
                  {!isDemo() && <NewTagChip
                    draft={newTagDraft}
                    onDraft={setNewTagDraft}
                    tags={tags}
                    onPick={handleSelectTag}
                    onMade={(id) => {
                      setMadeTagId(id)
                      handleSelectTag(id)
                    }}
                  />}
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
                sessionKey={
                  machine
                    ? { cwd: cwd.trim(), machine }
                    : choosesDir && claudeDirId !== null
                      ? { cwd: cwd.trim(), claudeDir: claudeDirId }
                      : { cwd: cwd.trim() }
                }
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
        </div>
        {missingDir && (
          <div className="flex flex-col gap-3">
            <p className="break-all rounded-[10px] border border-line/14 bg-space/50 px-3.5 py-3 font-mono fs-13 text-ink-100">
              {missingDir}
            </p>
            <p className="fs-13 leading-[1.5] text-ink-600/88">
              This folder doesn't exist yet. Orbital can create it, with any missing folders above it, and launch the
              session there — or go back and change the path.
            </p>
          </div>
        )}
        {question && (
          <McpjsonRows
            servers={question.servers}
            answers={question.answers}
            onAnswer={(name, answer) => setQuestion((q) => (q ? { ...q, answers: { ...q.answers, [name]: answer } } : q))}
            onViewFile={(server) => setViewing({ name: server.name, file: server.file })}
          />
        )}
      </Dialog>
      <ProjectFileViewer cwd={cwd.trim()} server={viewing} onClose={() => setViewing(null)} machine={machine} />
    </>
  )
}

/** The tag a typed name already names, in any case. */
function existingTag(tags: Tag[], name: string): Tag | undefined {
  const wanted = name.trim().toLowerCase()
  return wanted ? tags.find((t) => t.name.toLowerCase() === wanted) : undefined
}

/**
 * The TAG row's last chip (canvas `Feature - Tag chips` 80c, spec
 * 2026-10-25-tag-toggles-and-order-design § 3): + New tag turns into a name
 * field in place — the active chip with an empty dot, as tall as every chip
 * in the row. Enter creates the tag with the next free hue and picks it by
 * hand; a name that exists already, in any case, picks that tag. Escape,
 * leaving the field or an empty name backs out.
 */
function NewTagChip({ draft, onDraft, tags, onPick, onMade }: {
  draft: string | null
  onDraft: (draft: string | null) => void
  tags: Tag[]
  onPick: (id: number) => void
  onMade: (id: number) => void
}) {
  const createTag = useOrbital((s) => s.createTag)
  const [saving, setSaving] = useState(false)
  useEscapeLayer(draft != null, () => onDraft(null))

  if (draft == null) return <Chip size="field" muted label="+ New tag" onClick={() => onDraft('')} />

  async function commit(name: string) {
    const trimmed = name.trim()
    const existing = existingTag(tags, trimmed)
    if (!trimmed || existing) {
      if (existing) onPick(existing.id)
      onDraft(null)
      return
    }
    setSaving(true)
    try {
      onMade(await createTag(trimmed))
      onDraft(null)
    } catch (err) {
      reportError(err, 'Failed to create tag')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Chip
      size="field"
      active
      label="New tag name"
      input={
        <Input
          variant="chip"
          autoFocus
          spellCheck={false}
          aria-label="New tag name"
          placeholder="tag name"
          value={draft}
          disabled={saving}
          // 80c: the field grows with the name, never under eight characters.
          style={{ width: `${Math.max(8, draft.length + 1)}ch` }}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            void commit(draft)
          }}
          onBlur={() => {
            if (!saving) onDraft(null)
          }}
        />
      }
    />
  )
}
