import { useState, type ReactNode } from 'react'
import { useOrbital } from '../../store/store'
import { api } from '../../lib/api'
import { copyToClipboard } from '../../lib/clipboard'
import type { HarnessEvent, SessionHarness, StepState } from '../../lib/types'
import { MENU_SEPARATOR, MenuButton, type MenuEntry } from '../../ui/Menu'
import { act } from './actions'
import { RemoveDialog } from './dialogs'
import { recordMarkdown } from './markdown'
import {
  MARKER,
  PAUSE_LABEL,
  clock,
  eventsOfHarness,
  eventsOfStep,
  footerLine,
  headerStatus,
  inputsLine,
  isDone,
  isGateShape,
  opensByDefault,
  pauseHint,
  railItems,
  scopeChip,
  shortSha,
  stepKind,
  stepMeta,
  stepWho,
  type StepKind,
} from './model'
import { AccentLink, FilledButton, HeadButton, HeaderBlock, Kicker, Label, Marker, OutlineButton, ScopeChip, Switch, type Chrome } from './parts'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const BOX = 'flex flex-col rounded-[9px] px-3 py-[11px]'
const BODY = 'text-pretty text-[12px] leading-[1.55] text-[rgba(220,232,248,.88)]'

/** INSTRUCTIONS / DONE WHEN / VERIFY · RUNS AFTER EACH TICK (30d, the active step). */
function Instructions({ step }: { step: SessionHarness['steps'][number] }) {
  return (
    <div className={`${BOX} gap-2.5 border border-[rgba(150,205,255,.14)] bg-[rgba(4,8,16,.5)]`}>
      <div>
        <Label>INSTRUCTIONS</Label>
        <div className={`mt-[5px] whitespace-pre-wrap ${BODY}`}>{step.instructions}</div>
      </div>
      {step.doneWhen && (
        <div>
          <Label>DONE WHEN</Label>
          <div className={`mt-[5px] ${BODY}`}>{step.doneWhen}</div>
        </div>
      )}
      {step.verify && (
        <div>
          <Label>VERIFY · RUNS AFTER EACH TICK</Label>
          <div className="mt-[5px] whitespace-pre-wrap break-all rounded-[6px] bg-[rgba(2,4,9,.7)] px-[9px] py-[7px] font-mono text-[10.5px] leading-[1.5] text-[rgba(214,230,248,.9)]">
            $ {step.verify}
          </div>
        </div>
      )}
    </div>
  )
}

/** A left-ruled note over the instructions: why the step is active again (30d B). */
function BackNote({ head, children }: { head: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-[5px] border-l border-[rgba(220,235,255,.3)] pl-2.5">
      <div className="font-mono text-[9px] tracking-[0.18em] text-[rgba(200,220,245,.75)]">{head}</div>
      <div className={`${BODY} leading-[1.55]`}>{children}</div>
    </div>
  )
}

interface StepProps {
  sessionId: string
  harness: SessionHarness
  index: number
  kind: StepKind
  state: StepState
  own: HarnessEvent[]
  open: boolean
  last: boolean
  readOnly: boolean
  onToggle: () => void
  onRecord: () => void
}

/** One step on the rail (30d): marker, title, mono line; the open ones carry their box. */
function StepRow({ sessionId, harness, index, kind, state, own, open, last, readOnly, onToggle, onRecord }: StepProps) {
  const step = harness.steps[index]
  const m = MARKER[kind]
  const who = stepWho(kind, step, state, harness, own)
  const reviews = state.reviews ?? []
  const lastReview = reviews[reviews.length - 1]
  const questions = state.openQuestions?.length ?? 0
  const verified = [...own].reverse().find((e) => e.kind === 'ticked')?.detail.verify === 'passed'
  const range = state.startHead && state.endHead ? `${shortSha(state.startHead)}..${shortSha(state.endHead)}` : null
  const reopenedAt = [...own].reverse().find((e) => e.kind === 'reopened')?.at
  const waitMeta = [questions ? plural(questions, 'open question') : null, verified ? 'verify passed' : null].filter(Boolean).join(' · ')
  const showInstructions = kind === 'active' || kind === 'sentBack' || kind === 'pausedHere' || kind === 'reopened' || kind === 'pending' || kind === 'pendingGate'

  return (
    <div className="flex gap-2.5">
      <div className="flex w-[14px] shrink-0 flex-col items-center">
        <span className="mt-[5px]">
          <Marker kind={kind} gate={isGateShape(kind, step)} />
        </span>
        {!last && <span aria-hidden className="mt-[7px] block w-px flex-1 bg-[rgba(150,205,255,.12)]" />}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-[9px] pb-[15px]">
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex flex-col gap-1 text-left">
          <span className="text-pretty text-[12.5px] font-semibold leading-[1.42]" style={{ color: m.titleInk }}>
            {step.title}
          </span>
          <span className="font-mono text-[10px] tracking-[0.03em]" style={{ color: m.metaInk }}>
            {stepMeta(index, step, who)}
          </span>
        </button>

        {open && kind === 'sentBack' && lastReview && (
          <BackNote head={`REVIEWER SENT THIS BACK · ${clock(lastReview.at)}`}>
            {lastReview.reasoning}
            {state.unsentFindings && (
              <span className="mt-1 block font-mono text-[9.5px] text-[rgba(160,190,225,.55)]">
                held · sent when auto-continue is back on
              </span>
            )}
          </BackNote>
        )}
        {open && kind === 'reopened' && (
          <BackNote head={`REOPENED BY YOU${reopenedAt ? ` · ${clock(reopenedAt)}` : ''}`}>
            Nothing was sent. Write what to change in the composer; the step stays open until the agent ticks it again.
          </BackNote>
        )}
        {open && showInstructions && <Instructions step={step} />}

        {open && kind === 'waiting' && (
          <div className={`${BOX} gap-2.5 border border-[oklch(84%_.113_63_/_.35)] bg-[rgba(4,8,16,.5)]`}>
            {(state.summary ?? state.evidence) && <div className={`${BODY} text-[rgba(220,232,248,.9)]`}>{state.summary ?? state.evidence}</div>}
            {waitMeta && <div className="font-mono text-[10px] text-[rgba(160,190,225,.65)]">{waitMeta}</div>}
            <div className="flex items-center gap-2">
              {!readOnly && (
                <>
                  <FilledButton onClick={() => void act(sessionId, 'Failed to approve the step', () => api.approveHarnessStep(sessionId, index))}>
                    Approve
                  </FilledButton>
                  <OutlineButton onClick={() => void act(sessionId, 'Failed to reopen the step', () => api.reopenHarnessStep(sessionId, index))}>
                    Reopen
                  </OutlineButton>
                </>
              )}
              <span aria-hidden className="flex-1" />
              <AccentLink onClick={onRecord}>RECORD →</AccentLink>
            </div>
            {!readOnly && <div className="font-mono text-[9.5px] text-[rgba(160,190,225,.5)]">Reopen sends nothing. You write what to change.</div>}
          </div>
        )}

        {open && kind === 'reviewing' && (
          <div className={`${BOX} gap-2 border border-dashed border-[rgba(220,235,255,.22)] bg-[rgba(4,8,16,.4)]`}>
            <div className={BODY}>
              The reviewer is reading the step&apos;s record and its changes. It approves, approves unsure, or sends the step
              back with a reason.
            </div>
            <div className="font-mono text-[10px] leading-[1.6] text-[rgba(160,190,225,.6)]">
              reading · {range ? `diff ${range}` : 'the record'}
            </div>
            {!readOnly && (
              <div className="flex gap-3.5 font-mono text-[10px] tracking-[0.06em]">
                <button
                  type="button"
                  onClick={() => void act(sessionId, 'Failed to take the gate', () => api.decideHarnessStepMyself(sessionId, index))}
                  className="shrink-0 text-left text-[oklch(85%_.12_205)] hover:brightness-110"
                >
                  Decide myself
                </button>
                <span className="text-[rgba(160,190,225,.6)]">the reviewer stops, the gate waits for you</span>
              </div>
            )}
          </div>
        )}

        {open && isDone(kind) && (
          <div className="flex flex-col gap-[7px]">
            {(state.summary ?? state.evidence) && (
              <div className="text-pretty text-[12px] leading-[1.55] text-[rgba(200,214,235,.8)]">{state.summary ?? state.evidence}</div>
            )}
            {kind === 'doneUnsure' && (
              <div className="font-mono text-[10px] text-[rgba(220,235,255,.85)]">
                ◇ reviewer unsure{questions ? ` · ${plural(questions, 'thing')} to look at` : ''}
              </div>
            )}
            <div className="flex items-center gap-2 font-mono text-[10px] text-[rgba(160,190,225,.6)]">
              {range && <span>{range}</span>}
              <span aria-hidden className="flex-1" />
              <AccentLink onClick={onRecord}>RECORD →</AccentLink>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** A harness-level event between the steps (30g): a dashed row. */
function EventRow({ text }: { text: string }) {
  return (
    <div className="-mt-1 mb-3.5 flex items-center gap-2 font-mono text-[9.5px] tracking-[0.06em] text-[rgba(160,190,225,.6)]">
      <span className="flex w-[14px] shrink-0 justify-center">
        <span aria-hidden className="block h-[1.4px] w-[7px] bg-[rgba(160,190,225,.6)]" />
      </span>
      <span className="shrink-0">{text}</span>
      <span
        aria-hidden
        className="block h-px flex-1"
        style={{ background: 'repeating-linear-gradient(90deg,rgba(150,205,255,.2) 0 3px,transparent 3px 8px)' }}
      />
    </div>
  )
}

/** Each step's kind and own events, computed once per render for the rail, the bar and the header. */
export function useSteps(harness: SessionHarness, events: readonly HarnessEvent[]) {
  const all = eventsOfHarness(harness, events)
  return harness.steps.map((step, i) => {
    const state: StepState = harness.state[i] ?? { status: 'pending' }
    const own = eventsOfStep(all, step, i, harness.createdAt)
    return { state, own, kind: stepKind(step, state, harness, own) }
  })
}

/** The bar under the title: one segment per step in its state token, never a filling gauge (30a). */
export function Segments({ kinds, className = '' }: { kinds: StepKind[]; className?: string }) {
  return (
    <div className={`flex gap-[3px] ${className}`}>
      {kinds.map((k, i) => (
        <span key={i} className="block h-1 flex-1 rounded-[2px]" style={{ background: MARKER[k].segment }} />
      ))}
    </div>
  )
}

/**
 * The running harness (canvas 30b/30d): header with its readout and the two
 * switches, the step rail with the harness's own events between the steps,
 * and the footer for the switch combination (30f).
 */
export function RunningView({
  sessionId,
  harness,
  events,
  chrome,
  readOnly,
  onRecord,
  onFull,
}: {
  sessionId: string
  harness: SessionHarness
  events: readonly HarnessEvent[]
  chrome: Chrome
  /** A removed harness, read from session stats: no switches, no actions. */
  readOnly: boolean
  onRecord: (index: number) => void
  onFull: (() => void) | null
}) {
  const [toggled, setToggled] = useState<Record<number, boolean>>({})
  const [removing, setRemoving] = useState(false)
  const openTemplates = useOrbital((s) => s.openHarnessTemplates)
  const steps = useSteps(harness, events)
  const kinds = steps.map((s) => s.kind)
  const head = headerStatus(harness, kinds)
  const chip = scopeChip(harness, events)
  const inputs = inputsLine(harness.inputs)
  const auto = !harness.paused

  const templateId = harness.templateId
  const menu: MenuEntry[] = [
    ...(templateId !== null && !chrome.inWindow && !readOnly
      ? [{ key: 'template', label: 'Open template in Settings', onSelect: () => openTemplates({ templateId: templateId ?? undefined }) }]
      : []),
    {
      key: 'copy',
      label: 'Copy record as Markdown',
      onSelect: () => {
        void copyToClipboard(recordMarkdown(harness, events)).then((ok) =>
          useOrbital.setState({ toast: ok ? { kind: 'info', message: 'Record copied as Markdown' } : { kind: 'error', message: 'Could not copy the record' } }),
        )
      },
    },
    ...(readOnly
      ? []
      : ([
          MENU_SEPARATOR,
          {
            key: 'remove',
            label: 'Remove harness…',
            body: (
              <span className="flex flex-col">
                <span>Remove harness…</span>
                <span className="mt-0.5 font-mono text-[10px] text-[rgba(160,190,225,.6)]">the conversation stays</span>
              </span>
            ),
            onSelect: () => setRemoving(true),
          },
        ] as MenuEntry[])),
  ]

  return (
    <>
      <HeaderBlock chrome={chrome}>
        {chrome.row(
          <>
            <Kicker>HARNESS</Kicker>
            {chip && <ScopeChip text={chip} />}
            {readOnly && <ScopeChip text="removed" />}
            <span aria-hidden className="flex-1" />
            <MenuButton
              entries={menu}
              aria-label="Harness actions"
              widthPx={236}
              align="right"
              renderTrigger={(props, isOpen) => (
                <HeadButton label="More" {...props} style={isOpen ? { background: 'rgba(150,205,255,.09)', color: '#e8eef8' } : undefined}>
                  ⋯
                </HeadButton>
              )}
            />
            {onFull && (
              <HeadButton label="Full window" onClick={onFull}>
                ⤢
              </HeadButton>
            )}
            {chrome.close}
          </>,
        )}
        <div className="mt-2 text-[15px] font-semibold leading-[1.34] tracking-[-0.005em] text-text-bright">{harness.name}</div>
        {inputs && <div className="mt-1 truncate font-mono text-[10px] text-[rgba(160,190,225,.6)]">{inputs}</div>}
        <Segments kinds={kinds} className="mt-3" />
        <div className="mt-2 flex items-center gap-2 font-mono text-[10.5px] text-[rgba(160,190,225,.6)]">
          <span className="text-[#e8eef8]">{head.step}</span>
          <span className="text-[rgba(150,205,255,.3)]">·</span>
          <span style={{ color: head.ink }}>{head.status}</span>
          <span aria-hidden className="flex-1" />
          <span>started {clock(harness.createdAt)}</span>
        </div>
        {harness.paused && !readOnly && (
          <div className="mt-3 flex flex-col gap-[5px] rounded-lg border border-[rgba(150,205,255,.2)] bg-[rgba(150,205,255,.05)] px-3 py-2.5">
            <div className="flex items-center gap-[7px] font-mono text-[9.5px] tracking-[0.16em] text-[rgba(220,235,255,.85)]">
              <span aria-hidden className="block size-1.5 rounded-[1px] bg-[rgba(200,220,245,.8)]" />
              PAUSED
              <span aria-hidden className="flex-1" />
              {harness.pauseKind && (
                <span className="tracking-[0.04em] text-[rgba(160,190,225,.6)]">{PAUSE_LABEL[harness.pauseKind]}</span>
              )}
            </div>
            {harness.pauseReason && (
              <div className="text-pretty text-[12px] leading-[1.5] text-[rgba(228,238,250,.9)]">{harness.pauseReason}</div>
            )}
            {pauseHint(harness.pauseKind) && (
              <div className="font-mono text-[9.5px] text-[rgba(160,190,225,.55)]">{pauseHint(harness.pauseKind)}</div>
            )}
          </div>
        )}
        {!readOnly && (
          <div className="mt-3 flex items-center gap-[18px] border-t border-[rgba(150,205,255,.08)] pt-3">
            <Switch
              on={auto}
              label="Auto-continue"
              onChange={(on) => void act(sessionId, 'Failed to change auto-continue', () => api.setHarnessPaused(sessionId, !on))}
            />
            <Switch
              on={harness.options.lucky}
              label="Feeling lucky"
              onChange={(on) => void act(sessionId, 'Failed to change Feeling lucky', () => api.setHarnessOptions(sessionId, { lucky: on }))}
            />
          </div>
        )}
      </HeaderBlock>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-[18px] pb-1 pt-4">
        {railItems(harness, events).map((item, n, items) => {
          if (item.kind === 'event') return <EventRow key={`e${item.event.id}`} text={item.text} />
          const i = item.index
          const s = steps[i]
          const open = toggled[i] ?? opensByDefault(s.kind)
          const last = !items.slice(n + 1).some((x) => x.kind === 'step')
          return (
            <StepRow
              key={harness.steps[i].id}
              sessionId={sessionId}
              harness={harness}
              index={i}
              kind={s.kind}
              state={s.state}
              own={s.own}
              open={open}
              last={last}
              readOnly={readOnly}
              onToggle={() => setToggled((t) => ({ ...t, [i]: !open }))}
              onRecord={() => onRecord(i)}
            />
          )
        })}
      </div>

      <div className="flex items-center gap-2 border-t border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.4)] px-[18px] py-[11px] font-mono text-[10px] tracking-[0.06em] text-[rgba(160,190,225,.5)]">
        <span className="min-w-0">{readOnly ? `removed ${clock(harness.removedAt)} · the record is kept` : footerLine(auto, harness.options.lucky)}</span>
        <span aria-hidden className="flex-1" />
        {!readOnly && <span className="shrink-0">⎋ close</span>}
      </div>

      {!readOnly && (
        <RemoveDialog
          open={removing}
          harness={harness}
          onClose={() => setRemoving(false)}
          onRemove={() => {
            setRemoving(false)
            void act(sessionId, 'Failed to remove the harness', () => api.removeHarness(sessionId))
          }}
        />
      )}
    </>
  )
}

