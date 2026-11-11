import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useOrbital } from '../store/store'
import { api, ApiError } from '../lib/api'
import { reportError } from '../lib/errors'
import type { HarnessLaunch, HarnessTemplate, LaunchHarnessTemplates } from '../lib/types'
import { Input } from '../ui/Input'
import { Marker, ScopeMark } from './harness/parts'
import { SwitchTrack } from '../ui/Switch'
import { GroupHead, TemplateRow, gateCount, isOptional, missingInputs, plural, templateMeta } from './harness/templates'

/**
 * New session's step 2, With a harness (spec
 * 2026-11-09-harness-from-new-session-design § The dialog; canvas `Feature -
 * New session harness` 65a–65c): the templates offered for the directory
 * step 1 chose, and the picked one's inputs, Feeling lucky and steps.
 */

type Load =
  | { key: string; status: 'loading' }
  | { key: string; status: 'ready'; answer: LaunchHarnessTemplates }
  /** Another member's Orbital predates the route: it has to be updated first. */
  | { key: string; status: 'outdated' }
  /** Another member has Harness switched off: it has to be turned on there first. */
  | { key: string; status: 'off' }
  | { key: string; status: 'failed' }

const NO_INPUTS: Record<string, string> = {}

/** The route's refusal while the answering device has Harness switched off. */
function harnessOff(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 403) return false
  try {
    return (JSON.parse(err.message) as { error?: unknown }).error === 'harness_disabled'
  } catch {
    return false
  }
}

const andJoin = (words: string[]) =>
  words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`

export interface LaunchHarness {
  /** What the launch carries, or null while it cannot launch with a harness. */
  launch: HarnessLaunch | null
  /** The footer summary's harness part: what Launch waits for, or what it starts. */
  summary: string
  /** Launch with harness waits: no template, or a required input empty. */
  blocked: boolean
  view: HarnessStepView
  reset: () => void
}

interface HarnessStepView {
  load: Load | null
  selected: HarnessTemplate | undefined
  inputs: Record<string, string>
  lucky: boolean
  dirNote: string | null
  pick: (t: HarnessTemplate) => void
  setInput: (key: string, value: string) => void
  setLucky: (on: boolean) => void
}

/**
 * Step 2's state. It loads while `active`, again whenever the directory or
 * the device changes, and only the latest answer lands. A pick, its inputs
 * and its Feeling lucky are kept per template, so going back to step 1 and
 * returning, or trying another template, loses nothing typed.
 */
export function useLaunchHarness({
  active,
  cwd,
  machine,
  deviceName,
  hasNote,
}: {
  active: boolean
  cwd: string
  machine: string | undefined
  deviceName: string
  hasNote: boolean
}): LaunchHarness {
  const [load, setLoad] = useState<Load | null>(null)
  const [selectedId, setSelectedIdState] = useState<number | null>(null)
  /** The pick as of now, for an answer landing after it. */
  const selectedIdRef = useRef<number | null>(null)
  const setSelectedId = useCallback((id: number | null) => {
    selectedIdRef.current = id
    setSelectedIdState(id)
  }, [])
  const [inputsById, setInputsById] = useState<Record<number, Record<string, string>>>({})
  const [luckyById, setLuckyById] = useState<Record<number, boolean>>({})
  const [dirNote, setDirNote] = useState<string | null>(null)
  /** The picked template as last answered, to say why it is gone when another directory drops it. */
  const pickedRef = useRef<HarnessTemplate | null>(null)
  const ticket = useRef(0)

  const dir = cwd.trim()
  const key = `${machine ?? ''}\u0000${dir}`

  useEffect(() => {
    if (!active || !dir) return
    const mine = ++ticket.current
    setLoad((current) => (current?.key === key && current.status === 'ready' ? current : { key, status: 'loading' }))
    api
      .listHarnessTemplatesForLaunch(dir, machine)
      .then((answer) => {
        if (mine !== ticket.current) return
        setLoad({ key, status: 'ready', answer })
        const offered = (id: number | null) => id != null && answer.templates.some((t) => t.id === id)
        const current = selectedIdRef.current
        if (offered(current)) return
        const before = pickedRef.current
        setDirNote(
          before && current != null && before.scope.kind === 'project' && answer.project
            ? `${before.name} belongs to ${before.scope.name}, so it isn’t offered for ${answer.project.name}.`
            : null,
        )
        setSelectedId(offered(answer.lastUsedId) ? answer.lastUsedId : (answer.templates[0]?.id ?? null))
      })
      .catch((err: unknown) => {
        if (mine !== ticket.current) return
        // Another member answering 404 runs an Orbital without the route.
        if (machine && err instanceof ApiError && err.status === 404) {
          setLoad({ key, status: 'outdated' })
          return
        }
        // Its Harness switch is off: a setting to change there, not a failure.
        if (machine && harnessOff(err)) {
          setLoad({ key, status: 'off' })
          return
        }
        setLoad({ key, status: 'failed' })
        reportError(err, 'Failed to load harness templates')
      })
  }, [active, dir, key, machine, setSelectedId])

  const answer = load?.key === key && load.status === 'ready' ? load.answer : null
  const shownLoad = load?.key === key ? load : dir ? { key, status: 'loading' as const } : null
  const selected = answer?.templates.find((t) => t.id === selectedId)
  useEffect(() => {
    if (selected) pickedRef.current = selected
  }, [selected])
  const inputs = (selected && inputsById[selected.id]) || NO_INPUTS
  const lucky = selected ? (luckyById[selected.id] ?? selected.options.lucky) : false
  const missing = selected ? missingInputs(selected, inputs) : []

  const pick = useCallback(
    (t: HarnessTemplate) => {
      setSelectedId(t.id)
      setDirNote(null)
    },
    [setSelectedId],
  )
  const setInput = useCallback(
    (inputKey: string, value: string) => {
      if (!selected) return
      const id = selected.id
      setInputsById((all) => ({ ...all, [id]: { ...all[id], [inputKey]: value } }))
    },
    [selected],
  )
  const setLucky = useCallback(
    (on: boolean) => {
      if (!selected) return
      const id = selected.id
      setLuckyById((all) => ({ ...all, [id]: on }))
    },
    [selected],
  )
  const reset = useCallback(() => {
    ticket.current++
    pickedRef.current = null
    setLoad(null)
    setSelectedId(null)
    setInputsById({})
    setLuckyById({})
    setDirNote(null)
  }, [setSelectedId])

  const blocked = !selected || missing.length > 0
  // Only what was filled in, trimmed: an empty optional input is left to the template.
  const launch = useMemo<HarnessLaunch | null>(
    () =>
    selected && !blocked
      ? {
          templateId: selected.id,
          inputs: Object.fromEntries(
            selected.inputs.flatMap((input) => {
              const value = inputs[input.key]?.trim()
              return value ? [[input.key, value]] : []
            }),
          ),
          lucky,
        }
      : null,
    [selected, blocked, inputs, lucky],
  )

  // Canvas 65a/65b's summary: what is missing first; once ready, the harness
  // leads so it survives the cut at the end.
  const none = answer !== null && answer.templates.length === 0
  const summary =
    shownLoad?.status === 'outdated'
      ? `Update Orbital on ${deviceName} to launch with a harness`
      : shownLoad?.status === 'off'
        ? `Harness is off on ${deviceName} · turn it on there to launch with one`
        : shownLoad?.status === 'failed'
          ? 'No harness templates could be read · ‹ Back launches without one'
          : !answer
            ? 'Reading the harness templates…'
            : none
              ? 'No harness templates here · ‹ Back launches without one'
              : !selected
                ? 'Pick a template to launch with a harness'
                : missing.length > 0
                  ? `Fill ${andJoin(missing.map((m) => m.label))} to launch`
                  : `Starts harness ${selected.name}, ${plural(selected.steps.length, 'step')}${lucky ? ', feeling lucky' : ''}${hasNote ? ' + your note' : ''}`

  return {
    launch,
    summary,
    blocked,
    view: { load: shownLoad, selected, inputs, lucky, dirNote, pick, setInput, setLucky },
    reset,
  }
}

/** Kicker inside the step (65a): mono 10, .16em, the muted ink. */
function Kicker({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-2 font-mono fs-10 tracking-[0.16em] text-ink-900/60">{children}</div>
}

/** 30c's dashed block, in the list (65a/65c). */
function EmptyBlock({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-col gap-2 rounded-[9px] border border-dashed border-line/18 bg-space/30 p-3">
      {children}
    </div>
  )
}

/**
 * Step 2's body (65a): TEMPLATES on the left, the picked template on the
 * right. Both columns scroll on their own; the note under them and the
 * footer stay where they are.
 */
export function HarnessStep({
  view,
  remote,
  deviceName,
}: {
  view: HarnessStepView
  remote: boolean
  deviceName: string
}) {
  const openTemplates = useOrbital((s) => s.openHarnessTemplates)
  const { load, selected, inputs, lucky, dirNote, pick, setInput, setLucky } = view
  const answer = load?.status === 'ready' ? load.answer : null
  const project = answer?.project ?? null
  const templates = answer?.templates ?? []
  const projectTemplates = templates.filter((t) => t.scope.kind === 'project')
  const globalTemplates = templates.filter((t) => t.scope.kind === 'global')
  const none = answer !== null && templates.length === 0
  // Settings belong to the device the templates live on; another one's are edited there.
  const openSettings = remote ? undefined : () => openTemplates({ project: project ?? undefined })

  // 65b: the first required input left empty holds the focus, so a pasted link lands in it.
  const firstMissing = selected?.inputs.find((input) => !isOptional(input.hint) && !inputs[input.key]?.trim())
  const firstMissingRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    firstMissingRef.current?.focus()
    // On a new pick only: typing must not move the focus to the next empty field.
  }, [selected?.id])

  const row = (t: HarnessTemplate) => (
    <TemplateRow
      key={t.id}
      layout="stacked"
      template={t}
      selected={t.id === selected?.id}
      onPick={() => pick(t)}
      note={answer?.lastUsedId === t.id ? 'last used here' : undefined}
    />
  )

  const list = () => {
    if (load?.status === 'outdated') {
      return (
        <EmptyBlock>
          <div className="text-pretty fs-12 leading-[1.5] text-ink-100/88">
            Orbital on {deviceName} is too old to offer harness templates here. Update it first, or go ‹ Back and
            launch without one.
          </div>
        </EmptyBlock>
      )
    }
    if (load?.status === 'off') {
      return (
        <EmptyBlock>
          <div className="text-pretty fs-12 leading-[1.5] text-ink-100/88">
            Harness is off on {deviceName}. Turn it on there in Settings → Harness, or go ‹ Back and launch without
            one.
          </div>
        </EmptyBlock>
      )
    }
    if (load?.status === 'failed') {
      return (
        <EmptyBlock>
          <div className="text-pretty fs-12 leading-[1.5] text-ink-100/88">
            The harness templates could not be read. Go ‹ Back and launch without one, or try again.
          </div>
        </EmptyBlock>
      )
    }
    if (!answer) return null
    const where = project?.name
    if (none) {
      return (
        <>
          {where && <GroupHead kind="project">{`${where.toUpperCase()} · THIS PROJECT`}</GroupHead>}
          <EmptyBlock>
            <div className="text-pretty fs-12 leading-[1.5] text-ink-100/88">
              No harness templates {where ? `for ${where} ` : ''}yet, and no global ones. A project template shows
              only in this project’s sessions; a global one everywhere.
              {remote ? ` Make one in Orbital on ${deviceName}: Settings → Harness templates.` : ''}
            </div>
            {openSettings && (
              <button
                type="button"
                onClick={openSettings}
                className="self-start rounded-[7px] border border-line/20 px-[11px] py-1.5 fs-12 font-semibold text-ink-200/90 hover:border-line/35"
              >
                Open Settings → Harness templates
              </button>
            )}
          </EmptyBlock>
        </>
      )
    }
    return (
      <>
        {where && (
          <>
            <GroupHead kind="project">{`${where.toUpperCase()} · THIS PROJECT`}</GroupHead>
            {projectTemplates.length > 0 ? (
              projectTemplates.map(row)
            ) : (
              <EmptyBlock>
                <div className="text-pretty fs-12 leading-[1.5] text-ink-100/88">
                  No templates for {where} yet. A project template shows only in this project’s sessions.
                </div>
              </EmptyBlock>
            )}
          </>
        )}
        {globalTemplates.length > 0 && (
          <>
            <div className={where ? 'pt-1' : ''}>
              <GroupHead kind="global">GLOBAL</GroupHead>
            </div>
            {globalTemplates.map(row)}
          </>
        )}
      </>
    )
  }

  const gates = selected ? gateCount(selected) : 0
  const scope = selected?.scope

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5">
      {dirNote && <div className="shrink-0 fs-12 leading-[1.45] text-ink-900/75">{dirNote}</div>}
      <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)] gap-7">
        <div className="flex min-h-0 flex-col gap-2">
          <Kicker>
            TEMPLATES
            <span aria-hidden className="flex-1" />
            {answer && !none && (
              <span className="tracking-[0.04em] text-ink-900/45">
                {templates.length}
                {project ? ` for ${project.name}` : ''}
              </span>
            )}
          </Kicker>
          <div
            role="radiogroup"
            aria-label="Templates"
            className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-0.5 [scrollbar-width:thin]"
          >
            {list()}
          </div>
          {openSettings && (
            <div className="shrink-0 border-t border-line/8 pt-2">
              <button type="button" onClick={openSettings} className="font-mono fs-10 text-sky hover:brightness-110">
                Settings → Harness templates ↗
              </button>
            </div>
          )}
        </div>

        <div className="flex min-h-0 flex-col gap-[18px] overflow-y-auto pr-1 [scrollbar-width:thin]">
          {selected && scope ? (
            <>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-[9px]">
                  <ScopeMark kind={scope.kind} />
                  <span className="fs-16 font-bold tracking-[-0.005em] text-ink-100">{selected.name}</span>
                </div>
                <div className="font-mono fs-10.5 text-ink-900/60">
                  {scope.kind === 'project' ? `▢ ${scope.name} · project template` : '◯ global template'} ·{' '}
                  {templateMeta(selected)}
                </div>
                {selected.description && (
                  <div data-selectable className="text-pretty fs-12.5 leading-[1.55] text-ink-400/85">
                    {selected.description}
                  </div>
                )}
              </div>

              {selected.inputs.length > 0 && (
                <div className="flex flex-col gap-3">
                  <Kicker>INPUTS</Kicker>
                  {selected.inputs.map((input) => {
                    const optional = isOptional(input.hint)
                    const waiting = input.key === firstMissing?.key
                    return (
                      <label key={input.key} className="flex min-w-0 flex-col gap-[5px]">
                        <span className="flex items-baseline gap-2">
                          <span className="fs-12.5 font-semibold text-ink-200/92">{input.label}</span>
                          {input.hint && (
                            <span className="min-w-0 truncate font-mono fs-10 text-ink-900/55">{input.hint}</span>
                          )}
                          <span aria-hidden className="flex-1" />
                          <span
                            className={[
                              'shrink-0 font-mono fs-10',
                              !optional && !inputs[input.key]?.trim() ? 'text-ink-100' : 'text-ink-900/50',
                            ].join(' ')}
                          >
                            {optional ? 'optional' : 'required'}
                          </span>
                        </span>
                        <Input
                          ref={waiting ? firstMissingRef : undefined}
                          variant="ringed"
                          font="mono"
                          lit={waiting}
                          spellCheck={false}
                          aria-label={input.label}
                          value={inputs[input.key] ?? ''}
                          onChange={(e) => setInput(input.key, e.target.value)}
                        />
                      </label>
                    )
                  })}
                </div>
              )}

              <button
                type="button"
                role="switch"
                aria-checked={lucky}
                aria-label="Feeling lucky"
                onClick={() => setLucky(!lucky)}
                className="flex w-full items-center gap-3 rounded-[9px] border border-line/12 bg-space/45 px-3 py-2.5 text-left"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="fs-12.5 font-semibold text-ink-100">Feeling lucky</span>
                  <span className="fs-11.5 leading-[1.4] text-ink-900/70">
                    A read-only reviewer decides the gates instead of you.
                  </span>
                </span>
                <span className="font-mono fs-9.5 text-ink-900/50">
                  {lucky !== selected.options.lucky ? 'changed · template: ' : 'template default: '}
                  {selected.options.lucky ? 'on' : 'off'}
                </span>
                <SwitchTrack on={lucky} size="md" />
              </button>

              <div className="flex flex-col gap-1.5">
                <Kicker>
                  STEPS
                  <span className="flex items-center gap-[5px] tracking-[0.04em] text-ink-900/45">
                    · {plural(selected.steps.length, 'step')}
                    {gates > 0 && (
                      <>
                        {' ·'}
                        <span
                          aria-hidden
                          className="block size-[6px] shrink-0 rotate-45 rounded-[1px] border-[1.3px] border-current box-border"
                        />
                        {gates} {gates === 1 ? 'waits' : 'wait'} for you
                      </>
                    )}
                  </span>
                </Kicker>
                <ol className="flex flex-col gap-1.5">
                  {selected.steps.map((step, i) => (
                    <li key={step.id} className="flex items-start gap-[9px] fs-12 leading-[1.45] text-ink-400/88">
                      <span className="w-3 shrink-0 font-mono fs-10 leading-[17px] text-ink-900/50">{i + 1}</span>
                      <span className="mt-[5px]">
                        <Marker kind={step.mode === 'gate' ? 'pendingGate' : 'pending'} gate={step.mode === 'gate'} size={7} />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{step.title}</span>
                      <span className="shrink-0 font-mono fs-9.5 leading-[17px] text-ink-900/50">
                        {step.mode === 'gate' ? 'gate' : 'auto'}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            </>
          ) : (
            answer && (
              <div className="mt-10 flex flex-col items-start gap-1.5 rounded-[10px] border border-dashed border-line/14 px-[18px] py-4">
                <span className="fs-13 font-semibold text-ink-100/85">{none ? 'Nothing to pick here' : 'Pick a template'}</span>
                <span className="text-pretty fs-12 leading-[1.5] text-ink-900/70">
                  {none
                    ? 'Make one in Settings → Harness templates, or go ‹ Back and launch without one.'
                    : 'Its inputs, Feeling lucky and steps show here.'}
                </span>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  )
}
