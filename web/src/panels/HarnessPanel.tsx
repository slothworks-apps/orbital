import { useEffect, useState } from 'react'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { eventLine, rewindCountFor, stepTone } from '../lib/harness'
import type { HarnessTemplate, SessionHarness, StepState } from '../lib/types'
import { pickRewindTarget } from '../store/rewind'
import { stateToneColor } from '../lib/stateStyle'
import { Panel, WINDOW_STRIP_INSET_PX } from '../ui/Panel'
import { Button } from '../ui/Button'
import { Select } from '../ui/Select'
import { Input } from '../ui/Input'
import { Toggle } from '../ui/Checkbox'
import { CollapseGlyph, UtilityButton } from '../ui/UtilityButton'
import { Tooltip } from '../ui/Tooltip'
import { useEscapeLayer } from '../ui/escapeLayer'
import { PIN_TOOLTIP_DELAY_MS } from './UtilityStrip'
import { BackToSession, type SubagentPanelProps } from './SubagentPanel'

const LABEL = 'font-mono text-[9.5px] tracking-[0.16em] text-[rgba(160,190,225,.55)]'
const MUTED = 'text-[rgba(160,190,225,.6)]'

const STATUS_WORD: Record<string, string> = {
  pending: 'PENDING',
  active: 'ACTIVE',
  awaiting_approval: 'NEEDS YOUR OK',
  done: 'DONE',
}

/** Picking a template and filling its inputs; Start puts it into the session. */
function AttachForm({ sessionId }: { sessionId: string }) {
  const [templates, setTemplates] = useState<HarnessTemplate[] | null>(null)
  const [templateId, setTemplateId] = useState<number | null>(null)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api
      .listHarnessTemplates()
      .then(({ templates }) => {
        setTemplates(templates)
        setTemplateId((id) => id ?? templates[0]?.id ?? null)
      })
      .catch((err) => reportError(err, 'Failed to load harness templates'))
  }, [])

  const template = templates?.find((t) => t.id === templateId)

  async function start() {
    if (!template) return
    setBusy(true)
    try {
      const { harness } = await api.attachHarness(sessionId, template.id, inputs)
      useOrbital.setState((s) => ({ harnesses: { ...s.harnesses, [sessionId]: harness } }))
      void useOrbital.getState().loadHarness(sessionId)
    } catch (err) {
      reportError(err, 'Failed to start the harness')
    } finally {
      setBusy(false)
    }
  }

  if (!templates) return <div className={`text-[12px] ${MUTED}`}>Loading templates…</div>
  if (templates.length === 0) {
    return <div className={`text-[12px] ${MUTED}`}>No templates yet. Create one in Settings → Harness templates.</div>
  }
  return (
    <div className="flex flex-col gap-3">
      <div className={LABEL}>TEMPLATE</div>
      <Select
        options={templates.map((t) => ({ value: t.id, label: t.name }))}
        value={templateId ?? templates[0].id}
        onChange={(id: number) => {
          setTemplateId(id)
          setInputs({})
        }}
        font="sans"
      />
      {template?.description && <div className={`text-[12px] leading-[1.45] ${MUTED}`}>{template.description}</div>}
      {template?.inputs.map((input) => (
        <label key={input.key} className="flex flex-col gap-1.5">
          <span className={LABEL}>{input.label.toUpperCase()}</span>
          <Input
            value={inputs[input.key] ?? ''}
            placeholder={input.hint}
            onChange={(e) => setInputs({ ...inputs, [input.key]: e.target.value })}
          />
        </label>
      ))}
      {template && (
        <div className={`text-[11px] leading-[1.45] ${MUTED}`}>
          {template.steps.length} steps · {template.steps.filter((s) => s.mode === 'gate').length} wait for your OK
        </div>
      )}
      <Button variant="primary" size="md" disabled={!template || busy} onClick={() => void start()}>
        Start harness
      </Button>
    </div>
  )
}

const shortSha = (sha: string) => sha.slice(0, 8)

/**
 * "Go back here": the checklist reopens from the step, and the conversation
 * rewinds to the message that began it (the existing rewind; the composer
 * then holds that message to send again). Files are the user's to reset.
 */
async function goBack(sessionId: string, index: number, state: StepState): Promise<void> {
  const uuid = state.startMessageUuid
  if (!uuid) return
  const reset = state.startHead ? `\n\nFiles stay as they are. To drop this step's changes too: git reset --hard ${shortSha(state.startHead)}` : ''
  if (!window.confirm(`Rewind the conversation to the start of this step and reopen the checklist from it?${reset}`)) return
  const store = useOrbital.getState()
  // The message may sit in history the transcript has not paged in yet.
  let messages = store.transcripts[sessionId] ?? []
  for (let page = 0; page < 20 && !messages.some((m) => m.uuid === uuid); page++) {
    const older = await store.loadOlder(sessionId)
    if (!older || older.length === 0) break
    messages = useOrbital.getState().transcripts[sessionId] ?? []
  }
  const message = messages.find((m) => m.uuid === uuid)
  if (!message) {
    useOrbital.setState({ toast: { kind: 'error', message: 'The message that began this step is no longer in the conversation.' } })
    return
  }
  try {
    const { harness } = await api.reopenHarnessStep(sessionId, index)
    useOrbital.setState((s) => ({ harnesses: { ...s.harnesses, [sessionId]: harness } }))
  } catch {
    // The step was still active: nothing to reopen, the rewind alone goes back.
  }
  pickRewindTarget(sessionId, message, rewindCountFor(messages, uuid) ?? 0)
}

/** What happened in a step and why: the agent's record, the reviews, the git range. */
function StepRecord({ sessionId, index, state }: { sessionId: string; index: number; state: StepState }) {
  const [diff, setDiff] = useState<{ range: string; stat: string; patch: string } | null>(null)
  const [diffOpen, setDiffOpen] = useState(false)

  async function toggleDiff() {
    if (diffOpen) return setDiffOpen(false)
    setDiffOpen(true)
    if (diff) return
    try {
      setDiff(await api.getHarnessStepDiff(sessionId, index))
    } catch (err) {
      setDiffOpen(false)
      reportError(err, 'Failed to load the step\'s diff')
    }
  }

  const summary = state.summary ?? state.evidence
  return (
    <div className="flex flex-col gap-2">
      {summary && <div className="text-text-bright">{summary}</div>}
      {state.decisions && state.decisions.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className={LABEL}>DECISIONS</span>
          {state.decisions.map((d, i) => (
            <div key={i}>
              <span className="text-text-bright">{d.what}</span>
              <span className={MUTED}> — {d.why}</span>
              {d.alternatives && <span className={MUTED}> (instead of: {d.alternatives})</span>}
            </div>
          ))}
        </div>
      )}
      {state.openQuestions && state.openQuestions.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className={LABEL}>TO LOOK AT</span>
          {state.openQuestions.map((q, i) => (
            <div key={i} style={{ color: stateToneColor('input') }}>{q}</div>
          ))}
        </div>
      )}
      {(state.reviews ?? []).map((review, i) => (
        <div key={i} className="flex flex-col gap-1 rounded-[6px] border border-[rgba(150,205,255,.1)] px-2.5 py-2">
          <span
            className="font-mono text-[9px] tracking-[0.14em]"
            style={{ color: stateToneColor(review.verdict === 'approve' ? 'done' : 'input') }}
          >
            REVIEWER · {review.verdict === 'approve' ? 'APPROVED' : 'SENT BACK'}
            {review.uncertain ? ' · UNCERTAIN' : ''} ·{' '}
            {new Date(review.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
          </span>
          <div className="text-text-bright">{review.reasoning}</div>
          {review.findings.map((f, j) => (
            <div key={j} className={MUTED}>• {f}</div>
          ))}
          {review.checked.length > 0 && <div className={`text-[11px] ${MUTED}`}>Checked: {review.checked.join(' · ')}</div>}
        </div>
      ))}
      {state.approvedBy && (
        <div className={`text-[11px] ${MUTED}`}>Approved by {state.approvedBy === 'reviewer' ? 'the reviewer' : 'you'}</div>
      )}
      {(state.startHead || state.startMessageUuid) && (
        <div className="flex flex-wrap items-center gap-2">
          {state.startHead && state.endHead && (
            <>
              <span className={`font-mono text-[10.5px] ${MUTED}`}>
                {shortSha(state.startHead)}..{shortSha(state.endHead)}
              </span>
              <Button variant="ghost" size="sm" onClick={() => void toggleDiff()}>
                {diffOpen ? 'Hide diff' : 'Show diff'}
              </Button>
            </>
          )}
          {state.startMessageUuid && (
            <Button variant="ghost" size="sm" onClick={() => void goBack(sessionId, index, state)}>
              Go back here
            </Button>
          )}
        </div>
      )}
      {diffOpen && diff && (
        <pre className="max-h-[360px] overflow-auto whitespace-pre rounded-[6px] border border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.5)] p-2 font-mono text-[10.5px] leading-[1.45] text-text-bright">
          {diff.stat}
          {'\n\n'}
          {diff.patch || '(no changes)'}
        </pre>
      )}
    </div>
  )
}

function Checklist({ sessionId, harness }: { sessionId: string; harness: SessionHarness }) {
  const events = useOrbital((s) => s.harnessEvents[sessionId]) ?? []
  const [open, setOpen] = useState<number | null>(null)
  const activeIndex = harness.state.findIndex((s) => s.status !== 'done')
  const done = harness.state.filter((s) => s.status === 'done').length

  const act = async (label: string, call: () => Promise<{ harness: SessionHarness } | void>) => {
    try {
      const result = await call()
      if (result) useOrbital.setState((s) => ({ harnesses: { ...s.harnesses, [sessionId]: result.harness } }))
      void useOrbital.getState().loadHarness(sessionId)
    } catch (err) {
      reportError(err, label)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className={`font-mono text-[10.5px] ${MUTED}`}>
          {done}/{harness.steps.length} done
        </span>
        <span aria-hidden className="flex-1" />
        <span className={LABEL}>AUTO-CONTINUE</span>
        <Toggle
          checked={!harness.paused}
          onChange={() => void act('Failed to pause the harness', () => api.setHarnessPaused(sessionId, !harness.paused))}
        />
      </div>
      <div className="flex items-center gap-3">
        <span className={`text-[11.5px] leading-[1.4] ${MUTED}`}>
          {harness.options.lucky ? 'A reviewer decides the gates for you.' : 'Gates wait for you.'}
        </span>
        <span aria-hidden className="flex-1" />
        <span className={LABEL}>FEELING LUCKY</span>
        <Toggle
          checked={harness.options.lucky}
          onChange={() =>
            void act('Failed to change the harness', () => api.setHarnessOptions(sessionId, { lucky: !harness.options.lucky }))
          }
        />
      </div>
      {harness.paused && harness.pauseReason && (
        <div className="text-[12px] leading-[1.45]" style={{ color: stateToneColor('input') }}>
          Paused: {harness.pauseReason}
        </div>
      )}

      <ol className="flex flex-col gap-2">
        {harness.steps.map((step, i) => {
          const state = harness.state[i] ?? { status: 'pending' as const }
          const color = stateToneColor(stepTone(state.status))
          const expanded = open === i || (open === null && i === activeIndex)
          return (
            <li key={step.id} className="rounded-[7px] border border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.35)] px-3 py-2.5">
              <button
                type="button"
                className="flex w-full items-start gap-2.5 text-left"
                onClick={() => setOpen(expanded ? -1 : i)}
              >
                <span className={`w-4 shrink-0 pt-px font-mono text-[10.5px] ${MUTED}`}>{i + 1}</span>
                <span className="min-w-0 flex-1 text-[13px] font-semibold leading-[1.35] text-text-bright">{step.title}</span>
                <span className="shrink-0 pt-0.5 font-mono text-[9px] tracking-[0.14em]" style={{ color }}>
                  {step.mode === 'gate' && state.status === 'pending' ? 'GATE' : STATUS_WORD[state.status]}
                </span>
              </button>
              {expanded && (
                <div className="mt-2 flex flex-col gap-2 pl-[26px] text-[12px] leading-[1.45]">
                  <div className="whitespace-pre-wrap text-text-bright">{step.instructions}</div>
                  <div className={MUTED}>Done when: {step.doneWhen}</div>
                  {step.verify && <div className={`font-mono text-[11px] ${MUTED}`}>$ {step.verify}</div>}
                  <StepRecord sessionId={sessionId} index={i} state={state} />
                </div>
              )}
              {(state.status === 'awaiting_approval' || state.status === 'done') && (
                <div className="mt-2 flex gap-2 pl-[26px]">
                  {state.status === 'awaiting_approval' && (
                    <Button
                      variant="warning"
                      size="sm"
                      onClick={() => void act('Failed to approve the step', () => api.approveHarnessStep(sessionId, i))}
                    >
                      Approve
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void act('Failed to reopen the step', () => api.reopenHarnessStep(sessionId, i))}
                  >
                    Reopen
                  </Button>
                </div>
              )}
            </li>
          )
        })}
      </ol>

      {events.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className={LABEL}>LOG</div>
          {events.slice(0, 12).map((event) => (
            <div key={event.id} className={`text-[11.5px] leading-[1.4] ${MUTED}`}>
              <span className="font-mono text-[10.5px]">
                {new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
              </span>{' '}
              {eventLine(event, harness.steps)}
            </div>
          ))}
        </div>
      )}

      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (!window.confirm('Remove the harness from this session? The conversation stays.')) return
            void act('Failed to remove the harness', () => api.removeHarness(sessionId))
          }}
        >
          Remove harness
        </Button>
      </div>
    </div>
  )
}

/**
 * The session's harness in the side slot (spec 2026-09-30-session-harness-design
 * § UI): the checklist with its gates, or the form that starts one. The
 * subagent panel's frame; renders nothing while `store.harnessPanel` is null.
 */
export function HarnessPanel({ widthPx, inWindow: inWindowProp = false, swap = false }: SubagentPanelProps) {
  const inWindow = inWindowProp || swap
  const view = useOrbital((s) => s.harnessPanel)
  const close = useOrbital((s) => s.closeHarness)
  const session = useOrbital((s) => (view ? s.sessions[view.sessionId] : undefined))
  const harness = useOrbital((s) => (view ? s.harnesses[view.sessionId] : undefined))

  useEscapeLayer(view !== null, close)

  if (!view) return null

  return (
    <Panel side={swap ? 'right' : 'subagent'} widthPx={widthPx} fill={inWindow} className="flex h-full flex-col overflow-hidden">
      <div className="orbital-band-controls border-b border-[rgba(150,205,255,.1)] px-[18px] pb-[14px] pt-4">
        {swap && (
          <div
            className="orbital-drag-region -mx-[18px] -mt-4 flex h-10 items-center gap-2.5 pt-3 pr-[18px]"
            style={{ paddingLeft: WINDOW_STRIP_INSET_PX }}
          >
            <BackToSession parent={session} onBack={close} />
          </div>
        )}
        <div
          className={[
            'flex items-center gap-2',
            swap ? 'mt-3' : inWindow ? 'orbital-drag-region -mx-[18px] -mt-4 h-[38px] px-[18px] pt-4' : 'h-[22px]',
          ].join(' ')}
        >
          <span className={LABEL}>HARNESS</span>
          <span aria-hidden className="flex-1" />
          {!swap && (
            <Tooltip variant="name" title="Collapse panel" align="right" delayMs={PIN_TOOLTIP_DELAY_MS}>
              <UtilityButton aria-label="Collapse the harness panel" onClick={close}>
                <CollapseGlyph />
              </UtilityButton>
            </Tooltip>
          )}
        </div>
        <div className="mt-2 text-pretty text-[15px] font-semibold leading-[1.34] text-text-bright">
          {harness ? harness.name : 'Follow a checklist'}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-[18px] py-4">
        {harness === undefined ? (
          <div className={`text-[12px] ${MUTED}`}>Loading…</div>
        ) : harness === null ? (
          <AttachForm sessionId={view.sessionId} />
        ) : (
          <Checklist sessionId={view.sessionId} harness={harness} />
        )}
      </div>
    </Panel>
  )
}
