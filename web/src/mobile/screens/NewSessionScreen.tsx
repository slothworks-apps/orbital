import { useEffect, useMemo, useRef, useState } from 'react'
import type { DeviceOption } from '../../lib/devices'
import { KindGlyph } from '../../ui/KindGlyph'
import { useShallow } from 'zustand/react/shallow'
import { api } from '../../lib/api'
import { type OrbitalModel, type PermissionMode, type SessionDefaults } from '../../lib/types'
import { timeAgo } from '../../lib/format'
import { useClaudeDirModels } from '../../lib/useClaudeDirModels'
import { useNow } from '../../lib/useNow'
import { Composer, type ComposerControl } from '../../panels/Composer'
import { useAttachments } from '../../panels/useAttachments'
import type { SentAttachment } from '../../store/store'
import { useOrbital } from '../../store/store'
import { ModeCards } from '../../ui/ModeCards'
import { CLOCK_TICK_MS } from '../constants'
import { basename } from '../format'
import { searchDirectories } from '../../lib/directorySearch'
import { Marked } from '../../ui/Marked'
import {
  launchRequest, noSuchDirectory, prefillClaudeDir, preselectMode, preselectModel, startFailureLine,
  type DirectoryRow,
} from '../newSession'
import { deviceAsleep, openingSettles, phoneDeviceOptions, phoneOpeningDevice, rememberDevice, rememberedDevice } from '../deviceList'
import { isMacAsleep, useMobile } from '../state'
import { BottomSheet, FieldLabel, MobileScreen, PrimaryButton, SecondaryButton, SheetPresence } from '../ui'
import { ClaudeDirPicker } from './ClaudeDirPicker'
import { McpjsonSheet } from './McpjsonSheet'
import { PhotoButtons, SlashButton, attachPhoto } from './ComposerButtons'
import { MissingDirectorySheet } from './MissingDirectorySheet'
import { blocksLaunch, directoryLine, useDirectoryState } from '../../lib/useDirectoryState'
import { defaultSupports, deviceSupports } from '../version'
import { undecidedBeforeLaunch, type McpjsonAnswers, type McpjsonDecisions, type McpjsonServer } from '../../lib/mcpjson'

/** The device sheet's ages are in minutes at the finest. */
const MINUTE_MS = 60_000

/**
 * 9d (spec § 6.4): a session started from the phone. Directory, mode, model
 * and a first prompt; nothing typed here outlives the screen.
 */
export function NewSessionScreen() {
  const launchSession = useOrbital((s) => s.launchSession)
  const { allAsleep, macName, macVersion, link, rechecking, devices, members } = useMobile(
    useShallow((s) => ({
      allAsleep: isMacAsleep(s), macName: s.macName, macVersion: s.macVersion,
      link: s.link, rechecking: s.rechecking, devices: s.devices, members: s.members,
    })),
  )
  const goBack = useMobile((s) => s.goBack)
  const openSession = useMobile((s) => s.openSession)
  const now = useNow(true, CLOCK_TICK_MS)

  // Canvas 50j DEVICE PICKER: with two or more devices that host sessions,
  // the session runs on the one chosen here; with one, the screen is 9d's.
  // The sheet's "seen 2 h ago" says minutes at the finest: the options follow the minute, not each tick.
  const minute = Math.floor(now / MINUTE_MS) * MINUTE_MS
  const options = useMemo(
    () => phoneDeviceOptions({ link, rechecking, devices }, members, minute),
    [link, rechecking, devices, members, minute],
  )
  const several = devices.length >= 2
  const [remembered] = useState(rememberedDevice)
  const opening = phoneOpeningDevice(options, remembered)
  const settles = openingSettles({ link, rechecking, devices }, options, remembered)
  /** Chosen in the sheet, or held once settled; until then the opening device, which follows the devices as they come up. */
  const [pickedDevice, setPickedDevice] = useState<string | null>(null)
  const [deviceSheet, setDeviceSheet] = useState(false)
  // Held once settled, so a device waking or sleeping meanwhile does not move the form under the user.
  useEffect(() => {
    if (pickedDevice === null && opening !== null && settles) setPickedDevice(opening)
  }, [pickedDevice, opening, settles])
  /** The device every request about the new session names: the federation routes by it. */
  const machine = pickedDevice ?? opening
  const chosen = options.find((o) => o.id === machine)
  const mac = chosen?.name || macName || 'Your Mac'
  /**
   * Start waits: in a group, the chosen device cannot take the session now
   * (asleep, too old, linking); with one device, as 9d had it, it is asleep.
   */
  const asleep = several && chosen ? chosen.inert : allAsleep
  const chosenAsleep = several ? machine !== null && deviceAsleep({ link, rechecking, devices }, machine) : allAsleep

  /** `undefined` while the two reads run; `null` when the defaults could not be read. */
  const [defaults, setDefaults] = useState<SessionDefaults | null | undefined>(undefined)
  const [projects, setProjects] = useState<DirectoryRow[]>([])
  const [cwd, setCwd] = useState('')
  /** A permission mode picked by hand: kept across a change of device, unlike its directory and model. */
  const [pickedMode, setPickedMode] = useState<PermissionMode | null>(null)
  const mode = pickedMode ?? (defaults ? preselectMode(defaults) : 'acceptEdits')
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
  /** What a photo for the first prompt raised: a refused camera, a failed pick. */
  const [photoError, setPhotoError] = useState<string | null>(null)
  const composer = useRef<ComposerControl>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  /** 1d: the directory field has focus; the suggestion list hangs from it then. */
  const [dirFocused, setDirFocused] = useState(false)
  /** What was typed in the field, while it is still what the field holds; null until then. */
  const [dirTyped, setDirTyped] = useState<string | null>(null)
  const dirInput = useRef<HTMLInputElement>(null)
  /**
   * The `.mcp.json` question (spec 2026-10-08-mcpjson-approval-design; canvas
   * 47c/47d): the servers Start found undecided and the answers so far. Set,
   * it is a sheet over this form, which stays as it was underneath.
   */
  const [question, setQuestion] = useState<{ servers: McpjsonServer[]; answers: McpjsonAnswers } | null>(null)
  /**
   * Start found the directory missing (spec
   * 2026-10-12-new-session-missing-directory-design § 2): the path, `~`
   * expanded, that *Create and start* makes. Set, it is a sheet over the form.
   */
  const [missingDir, setMissingDir] = useState<string | null>(null)
  /**
   * An older Mac has no `/api/directory`; against it Start's `no_such_directory` is all there is.
   * The chosen device's version decides; with none known yet, the default member's.
   */
  const checksDir = machine !== null ? deviceSupports('directoryCheck', machine, devices) : defaultSupports('directoryCheck', macVersion)
  // The same for where the picker's sheet sends you to manage profiles.
  const profilesSection = machine !== null ? deviceSupports('profileLogin', machine, devices) : defaultSupports('profileLogin', macVersion)
  const dirState = useDirectoryState(cwd, checksDir && !asleep, machine ?? undefined)

  // The chosen device's defaults and recent directories (canvas 50j: they
  // follow the device); its Claude directory ids are its own, so a choice
  // made on another device is dropped with it.
  useEffect(() => {
    let current = true
    setDefaults(undefined)
    setProjects([])
    setPickedDir(null)
    setPickedModel(null)
    void Promise.allSettled([api.sessionDefaults(machine ?? undefined), api.listProjects(machine ?? undefined)]).then(([d, p]) => {
      if (!current) return
      if (p.status === 'fulfilled') {
        setProjects(p.value)
        // 1d AT REST: an empty field opens on the device's last directory, as the desktop's does.
        setCwd((typed) => (typed.trim() ? typed : (p.value[0]?.cwd ?? '')))
      }
      setDefaults(d.status === 'fulfilled' ? d.value : null)
    })
    return () => {
      current = false
    }
  }, [machine])

  const loaded = defaults !== undefined
  const dirs = defaults?.claudeDirs ?? []
  const choosesDir = dirs.length >= 2
  const prefill = choosesDir && defaults ? prefillClaudeDir(defaults) : null
  const claudeDirId = choosesDir ? (pickedDir ?? prefill?.id ?? null) : null
  /** 44d's hint beside the row: where the choice came from. */
  const claudeDirHint =
    pickedDir !== null && pickedDir !== prefill?.id ? 'changed' : prefill?.from === 'last' ? 'last launch' : 'default'
  /** The chosen directory's catalog: each account has its own models. */
  const models = useClaudeDirModels(claudeDirId, true, machine ?? undefined)

  // A directory picked or prefilled is not a query: until something is typed the list is the recent ones.
  const dirQuery = dirTyped !== null && dirTyped === cwd ? dirTyped : ''
  const rows = useMemo(() => searchDirectories(projects, dirQuery), [projects, dirQuery])
  const listShown = dirFocused && rows.length > 0
  const project = projects.find((p) => p.cwd === cwd.trim())
  const autoModel = defaults ? preselectModel({ defaults, project, models }) : (models[0]?.value ?? null)
  const model = pickedModel ?? autoModel

  const editCwd = (next: string) => {
    setCwd(next)
    setDirTyped(null)
    setNotFound(false)
    setFailure(null)
  }

  // An upload still in flight holds Start back: the launch sends only what has landed.
  const canStart =
    Boolean(cwd.trim() && prompt.trim()) && !pending && !asleep && !attachments.uploading && !blocksLaunch(dirState)

  /**
   * Start: asks about the project's undecided `.mcp.json` servers first, when
   * it has any (47e "Trigger"); a project without starts as it always did.
   */
  const start = async () => {
    if (!canStart) return
    setPending(true)
    setFailure(null)
    if (checksDir) {
      // Asked again rather than read off the line, which may be stale. A
      // failed ask starts anyway: `requireDirectory` still refuses.
      const dir = await api.directoryState(cwd.trim(), machine ?? undefined).catch(() => null)
      if (dir && dir.state !== 'directory') {
        setPending(false)
        if (dir.state === 'missing') setMissingDir(dir.path)
        return
      }
    }
    const servers = await undecidedBeforeLaunch(cwd.trim(), claudeDirId ?? undefined, machine ?? undefined)
    if (servers.length > 0) {
      setPending(false)
      setQuestion({ servers, answers: {} })
      return
    }
    await launch()
  }

  /** *Create and start*: a directory just made has no `.mcp.json` to ask about. */
  const createAndStart = async () => {
    if (!missingDir) return
    setPending(true)
    try {
      await api.createDirectory(missingDir, machine ?? undefined)
    } catch (err) {
      setMissingDir(null)
      setFailure(startFailureLine(err, mac))
      setPending(false)
      return
    }
    setMissingDir(null)
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
        launchRequest({ cwd, prompt, files, mode, model, claudeDirId, refs, mcpjson, machine }),
        images,
      )
      // The next New session opens on it (canvas 50j).
      if (machine !== null) rememberDevice(machine)
      attachments.reset()
      openSession(sessionId)
    } catch (err) {
      // The refusal is said on the form, under its field or its Start.
      setQuestion(null)
      // Said here, never through `reportError`: its `/api/errors` POST is not the phone's to make.
      if (noSuchDirectory(err)) setNotFound(true)
      else setFailure(startFailureLine(err, mac))
      setPending(false)
    }
  }

  const header = (
    <div className="flex h-13 items-center gap-1.5 px-1.5">
      <button
        type="button"
        aria-label="Close"
        onClick={() => goBack()}
        className="grid h-11 w-11 place-items-center fs-22 text-ink-200/85"
      >
        ×
      </button>
      <h1 className="flex-1 fs-17 font-bold">New session</h1>
      {/* Canvas 50j: with a DEVICE field the header names no device. */}
      {!several && (
        <span className="flex min-w-0 items-center gap-1.5 pr-3.5 font-mono fs-11 text-ink-900/70">
          <span
            aria-hidden
            className={[
              'block h-1.5 w-1.5 shrink-0 rounded-full',
              asleep ? 'border border-ink-600/60' : 'bg-accent',
            ].join(' ')}
          />
          <span className="truncate">{mac}</span>
        </span>
      )}
    </div>
  )

  const startLabel = chosenAsleep ? `Start · needs ${mac} awake` : several ? `Start on ${mac}` : 'Start session'

  const footer = (
    <div className="border-t border-line/8 px-4 pb-1.5 pt-2.5">
      <PrimaryButton onClick={() => void start()} disabled={!canStart}>
        {startLabel}
      </PrimaryButton>
      {failure && (
        <p role="alert" className="mt-2 text-center fs-13 text-[var(--state-input)]">
          {failure}
        </p>
      )}
    </div>
  )

  const typed = dirQuery.trim() !== ''
  // 1d's hint beside DIRECTORY: only while the list is in play.
  const hint = !dirFocused
    ? ''
    : !typed
      ? several ? `on ${mac}` : 'ten most recent'
      : rows.length === 0 ? 'no match · used as typed' : `${rows.length} on ${mac}`
  const dirLine = notFound ? null : directoryLine(dirState, mac)
  const focusBorder = 'border-accent/55 shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent)_10%,transparent)]'
  // An open list carries the field's accent down its sides (1d), so the field keeps it too.
  const fieldBorder = listShown
    ? focusBorder
    : notFound
      ? 'border-[oklch(70%_.14_25/.7)]'
      : dirLine
        ? 'border-warning/60'
        : dirFocused
          ? focusBorder
          : 'border-line/18'

  return (
    <MobileScreen header={header} footer={footer}>
      <div className="flex flex-col gap-[18px] px-4 py-3.5">
        {several && (
          <div className="flex flex-col gap-2">
            <FieldLabel>DEVICE</FieldLabel>
            <DeviceField option={chosen ?? null} onOpen={() => setDeviceSheet(true)} />
          </div>
        )}
        {/* Relative and above the groups after it: the suggestion list hangs over them (1d). */}
        <div className="relative z-[2] flex flex-col gap-2">
          <FieldLabel hint={hint}>DIRECTORY</FieldLabel>
          <div className="relative">
            <div
              className={[
                'flex h-13 items-center gap-2 border bg-space/60 pl-3.5 pr-1.5',
                // 1d SAME LIST, OVER THE FORM: open, the field's lower corners go square
                // and its bottom border drops to the hairline the list continues from.
                listShown ? 'rounded-t-[14px] rounded-b-none border-b-line/10' : 'rounded-[14px]',
                fieldBorder,
              ].join(' ')}
            >
              <input
                ref={dirInput}
                aria-label="Directory"
                role="combobox"
                aria-expanded={listShown}
                aria-autocomplete="list"
                value={cwd}
                onChange={(e) => {
                  editCwd(e.target.value)
                  setDirTyped(e.target.value)
                }}
                onFocus={() => setDirFocused(true)}
                onBlur={() => {
                  setDirFocused(false)
                  setDirTyped(null)
                }}
                placeholder="Search or type a path"
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="h-full min-w-0 flex-1 bg-transparent font-mono fs-13 text-ink-100 outline-none placeholder:text-ink-900/70"
              />
              {cwd && (
                <button
                  type="button"
                  aria-label="Clear"
                  // pointerdown, not click: the field keeps its focus and its list.
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => {
                    editCwd('')
                    dirInput.current?.focus()
                  }}
                  className="grid h-11 w-11 shrink-0 place-items-center fs-18 text-ink-900/70"
                >
                  ×
                </button>
              )}
            </div>
            {listShown && (
              <div
                role="listbox"
                aria-label="Directories"
                className="absolute left-0 right-0 top-13 z-[5] overflow-hidden rounded-b-[14px] border border-t-0 border-accent/55 bg-panel-solid shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent)_10%,transparent),0_16px_32px_color-mix(in_oklab,var(--color-shadow)_45%,transparent)] [clip-path:inset(0_-4px_-48px_-4px)]"
              >
                <div className="max-h-[364px] overflow-y-auto overscroll-contain">
                  {rows.map((m, i) => (
                    <button
                      key={m.row.cwd}
                      type="button"
                      role="option"
                      aria-selected={m.row.cwd === cwd.trim()}
                      // The field must not blur before the tap lands: the list would be gone.
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={() => {
                        editCwd(m.row.cwd)
                        // 1d PICKED: the list and the keyboard go.
                        dirInput.current?.blur()
                      }}
                      className={[
                        'flex min-h-14 w-full items-center gap-3 px-3.5 py-2 text-left active:bg-line/12',
                        i > 0 ? 'border-t border-line/7' : '',
                      ].join(' ')}
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                        <span className="truncate fs-14 font-bold text-ink-100">
                          <Marked text={m.name} marks={m.nameMarks} />
                        </span>
                        <span className="truncate font-mono fs-11 text-ink-900/65">
                          <Marked text={m.path} marks={m.pathMarks} bright />
                        </span>
                      </span>
                      {m.row.lastAt !== null && (
                        <span className="shrink-0 font-mono fs-10.5 text-ink-900/50">{timeAgo(m.row.lastAt, now)}</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          {notFound && (
            <p className="flex items-center gap-2 px-1 fs-12.5 text-danger-soft">
              <span aria-hidden className="font-mono fs-11">
                !
              </span>
              Directory not found on {mac}
            </p>
          )}
          {dirLine && (
            // Copy and colour provisional until the canvas draws the line.
            <p className="flex items-center gap-2 px-1 fs-12.5 text-warning">
              <span aria-hidden className="font-mono fs-11">
                !
              </span>
              {dirLine}
            </p>
          )}
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
                profilesSection={profilesSection}
                onChange={(id) => {
                  // A model picked from another account's catalog may not be in this one.
                  if (id !== claudeDirId) setPickedModel(null)
                  setPickedDir(id)
                }}
              />
            )}
            <div className="flex flex-col gap-1.5">
              <FieldLabel>PERMISSION MODE</FieldLabel>
              <ModeCards value={mode} onChange={setPickedMode} touch />
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
          sessionKey={{
            cwd: cwd.trim(),
            ...(claudeDirId !== null ? { claudeDir: claudeDirId } : {}),
            ...(machine !== null ? { machine } : {}),
          }}
          value={prompt}
          onChange={setPrompt}
          enter="newline"
          placement="below"
          variant="dialog"
          hint=""
          placeholder="What should Claude do?"
          attachments={attachments}
          control={composer}
        />
        {/* The session composer's photos and slash (9b), under the field. */}
        <div className="flex items-center gap-0.5">
          <PhotoButtons
            disabled={pending || asleep}
            onPhoto={(source) => attachPhoto(source, attachments, () => mounted.current, setPhotoError)}
          />
          <SlashButton disabled={pending || asleep || !cwd.trim()} onSlash={() => composer.current?.startCommand()} />
        </div>
        {photoError && (
          <div role="alert" className="px-1 font-mono fs-11 text-[var(--state-input)]">
            {photoError}
          </div>
        )}
        </div>
      </div>
      <SheetPresence>
        {deviceSheet && (
          <DeviceSheet
            options={options}
            value={machine}
            onPick={(id) => {
              setPickedDevice(id)
              setDeviceSheet(false)
            }}
            onClose={() => setDeviceSheet(false)}
          />
        )}
      </SheetPresence>
      <SheetPresence>
        {missingDir && (
          <MissingDirectorySheet
            path={missingDir}
            project={basename(missingDir)}
            macName={mac}
            pending={pending}
            onCreate={() => void createAndStart()}
            onBack={() => setMissingDir(null)}
          />
        )}
      </SheetPresence>
      <SheetPresence>
        {question && (
          <McpjsonSheet
            servers={question.servers}
            answers={question.answers}
            project={basename(cwd.trim())}
            macName={chosen?.name || macName || 'your Mac'}
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

/** Canvas 50j DEVICE: the chosen device, a 56 px field that opens the sheet. */
function DeviceField({ option, onOpen }: { option: DeviceOption | null; onOpen: () => void }) {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={onOpen}
      className="flex min-h-14 items-center gap-3 rounded-[14px] border border-line/18 bg-space/60 pl-3.5 pr-2.5 text-left"
    >
      <span className="flex text-ink-100">
        <KindGlyph kind={option?.kind ?? 'desktop'} untitled />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate fs-15 font-semibold text-ink-100">{option?.name ?? 'Choose a device'}</span>
        {option && <span className="truncate font-mono fs-10.5 text-ink-900/60">{option.sub}</span>}
      </span>
      <span aria-hidden className="grid h-11 w-8 shrink-0 place-items-center fs-10 text-ink-900/60">
        ▾
      </span>
    </button>
  )
}

/** Canvas 50j `Run it on`: every device; the inert ones carry their reason and take no tap. */
function DeviceSheet({
  options,
  value,
  onPick,
  onClose,
}: {
  options: DeviceOption[]
  value: string | null
  onPick: (id: string) => void
  onClose: () => void
}) {
  return (
    <BottomSheet label="Run it on" onDismiss={onClose} variant="device">
      <div className="flex flex-col gap-3 pb-2">
        <h2 className="fs-18 font-bold">Run it on</h2>
        <div role="radiogroup" aria-label="Device" className="overflow-hidden rounded-[14px] border border-line/12 bg-space/50">
          {options.map((o, i) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={o.id === value}
              aria-disabled={o.inert}
              onClick={() => {
                if (!o.inert) onPick(o.id)
              }}
              className={[
                'flex min-h-14 w-full items-center gap-3 px-3.5 text-left',
                i > 0 ? 'border-t border-line/8' : '',
                o.inert ? 'cursor-default text-ink-900/50' : 'text-ink-100',
              ].join(' ')}
            >
              <span className="flex">
                <KindGlyph kind={o.kind} untitled />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate fs-14.5 font-semibold">{o.name}</span>
                <span className="truncate font-mono fs-10.5 text-ink-900/60">{o.sub}</span>
              </span>
              <span aria-hidden className={['font-mono fs-13 text-accent', o.id === value ? '' : 'opacity-0'].join(' ')}>
                ✓
              </span>
            </button>
          ))}
        </div>
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
      </div>
    </BottomSheet>
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
      <p className="rounded-[12px] border border-line/18 bg-space/50 px-3.5 py-3 fs-11.5 leading-[1.4] text-ink-900/70">
        The model list could not be read. The session uses whatever model Claude Code is set to.
      </p>
    )
  }
  return (
    <div
      role="radiogroup"
      aria-label="Model"
      className="grid grid-cols-4 gap-px overflow-hidden rounded-[12px] border border-line/18 bg-line/12"
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
              'h-11 min-w-0 truncate px-1 font-mono fs-12.5',
              active
                ? 'bg-[color-mix(in_oklab,var(--color-accent)_10%,var(--color-space))] font-semibold text-accent'
                : 'bg-space text-ink-200/85',
            ].join(' ')}
          >
            {m.shortVersion}
          </button>
        )
      })}
      {/* Fill the last row so the separators do not show through as a block. */}
      {Array.from({ length: (4 - (models.length % 4)) % 4 }, (_, i) => (
        <span key={`pad-${i}`} aria-hidden className="bg-space" />
      ))}
    </div>
  )
}
