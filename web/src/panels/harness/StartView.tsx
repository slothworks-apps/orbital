import { useEffect, useState } from 'react'
import { useOrbital } from '../../store/store'
import { api } from '../../lib/api'
import { reportError } from '../../lib/errors'
import type { HarnessProject, HarnessTemplate } from '../../lib/types'
import { HeaderBlock, Kicker, Marker, ScopeMark, Switch, type Chrome } from './parts'

/** "required unless the hint says optional" (30c). */
export const isOptional = (hint: string | undefined) => /optional/i.test(hint ?? '')

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function gates(t: HarnessTemplate) {
  return t.steps.filter((s) => s.mode === 'gate').length
}

/** A template row (30c): radio dot, name, "7 steps · 3 gates". */
function TemplateRow({ template, selected, onPick }: { template: HarnessTemplate; selected: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onPick}
      className="flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left hover:bg-[rgba(150,205,255,.04)]"
      style={{
        borderColor: selected ? 'oklch(85% .12 205 / .6)' : 'rgba(150,205,255,.1)',
        background: selected ? 'oklch(85% .12 205 / .07)' : undefined,
      }}
    >
      <span
        aria-hidden
        className="block size-[10px] shrink-0 box-border rounded-full"
        style={{
          border: `1.4px solid ${selected ? 'oklch(85% .12 205)' : 'rgba(160,190,225,.45)'}`,
          boxShadow: selected ? 'inset 0 0 0 2px rgba(5,8,16,1)' : undefined,
          background: selected ? 'oklch(85% .12 205)' : 'transparent',
        }}
      />
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-text-bright">{template.name}</span>
      <span className="shrink-0 font-mono text-[10px] text-[rgba(160,190,225,.6)]">
        {plural(template.steps.length, 'step')} · {plural(gates(template), 'gate')}
      </span>
    </button>
  )
}

/** The selected template, expanded in place (30c): description, inputs, steps, Feeling lucky. */
function TemplateDetail({
  template,
  inputs,
  setInputs,
  lucky,
  setLucky,
}: {
  template: HarnessTemplate
  inputs: Record<string, string>
  setInputs: (next: Record<string, string>) => void
  lucky: boolean
  setLucky: (on: boolean) => void
}) {
  const [stepsOpen, setStepsOpen] = useState(false)
  return (
    <div className="mb-1.5 mt-1 flex flex-col gap-[9px] rounded-[9px] border border-[rgba(150,205,255,.14)] bg-[rgba(4,8,16,.5)] px-3 py-[11px]">
      {template.description && (
        <div className="text-pretty text-[12px] leading-[1.55] text-[rgba(220,232,248,.88)]">{template.description}</div>
      )}
      {template.inputs.map((input) => (
        <label key={input.key} className="flex flex-col gap-1">
          <span className="text-[11.5px] font-semibold text-[rgba(220,235,255,.9)]">{input.label}</span>
          <input
            value={inputs[input.key] ?? ''}
            onChange={(e) => setInputs({ ...inputs, [input.key]: e.target.value })}
            className="rounded-[7px] border border-[rgba(150,205,255,.16)] bg-[rgba(4,8,16,.7)] px-[9px] py-[5px] font-mono text-[11px] text-[#e8eef8] outline-none focus:border-[rgba(150,205,255,.35)]"
          />
          {input.hint && <span className="font-mono text-[9.5px] text-[rgba(160,190,225,.55)]">{input.hint}</span>}
        </label>
      ))}
      <div className="flex items-center gap-2 border-t border-[rgba(150,205,255,.08)] pt-2.5 font-mono text-[10.5px] text-[#e8eef8]">
        {plural(template.steps.length, 'step')}
        <span className="text-[rgba(150,205,255,.3)]">·</span>
        <span className="flex items-center gap-[5px] text-[rgba(220,235,255,.85)]">
          <span aria-hidden className="block size-[6px] rotate-45 rounded-[1px] border-[1.3px] border-current box-border" />
          {gates(template)} wait for you
        </span>
        <span aria-hidden className="flex-1" />
        <button
          type="button"
          aria-expanded={stepsOpen}
          onClick={() => setStepsOpen(!stepsOpen)}
          className="text-[rgba(160,190,225,.6)] hover:text-[rgba(220,235,255,.85)]"
        >
          steps {stepsOpen ? '▾' : '▸'}
        </button>
      </div>
      {stepsOpen && (
        <ol className="flex flex-col gap-1.5">
          {template.steps.map((step, i) => (
            <li key={step.id} className="flex gap-2 text-[11.5px] leading-[1.4] text-[rgba(200,214,235,.8)]">
              <span className="mt-[4px]">
                <Marker kind={step.mode === 'gate' ? 'pendingGate' : 'pending'} gate={step.mode === 'gate'} size={7} />
              </span>
              <span className="w-4 shrink-0 font-mono text-[10px] text-[rgba(160,190,225,.5)]">{String(i + 1).padStart(2, '0')}</span>
              <span className="min-w-0 flex-1 text-pretty">{step.title}</span>
            </li>
          ))}
        </ol>
      )}
      <div className="flex items-center gap-2">
        <Switch on={lucky} label="Feeling lucky" onChange={setLucky} />
        <span aria-hidden className="flex-1" />
        <span className="font-mono text-[9.5px] text-[rgba(160,190,225,.5)]">
          template default: {template.options.lucky ? 'on' : 'off'}
        </span>
      </div>
    </div>
  )
}

function GroupHead({ kind, children }: { kind: 'project' | 'global'; children: string }) {
  return (
    <div className="flex items-center gap-2 pb-1 pt-0.5 font-mono text-[9.5px] tracking-[0.18em] text-[rgba(160,190,225,.6)]">
      <ScopeMark kind={kind} />
      {children}
    </div>
  )
}

/**
 * The start view (canvas 30c): this project's templates, then the global
 * ones, never another project's. One row is selected at a time and expands
 * in place; Start harness sends step 1.
 */
export function StartView({ sessionId, chrome }: { sessionId: string; chrome: Chrome }) {
  const inWindow = chrome.inWindow
  const [data, setData] = useState<{ project: HarnessProject | null; templates: HarnessTemplate[] } | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [lucky, setLucky] = useState(false)
  const [busy, setBusy] = useState(false)
  const openTemplates = useOrbital((s) => s.openHarnessTemplates)

  useEffect(() => {
    let live = true
    api
      .listHarnessTemplatesForSession(sessionId)
      .then((answer) => {
        if (!live) return
        setData(answer)
        const first = answer.templates[0]
        if (first) {
          setSelectedId(first.id)
          setLucky(first.options.lucky)
        }
      })
      .catch((err) => reportError(err, 'Failed to load harness templates'))
    return () => {
      live = false
    }
  }, [sessionId])

  const pick = (t: HarnessTemplate) => {
    if (t.id === selectedId) return
    setSelectedId(t.id)
    setInputs({})
    setLucky(t.options.lucky)
  }

  const templates = data?.templates ?? []
  const projectTemplates = templates.filter((t) => t.scope.kind === 'project')
  const globalTemplates = templates.filter((t) => t.scope.kind === 'global')
  const selected = templates.find((t) => t.id === selectedId)
  const missing = selected?.inputs.find((input) => !inputs[input.key]?.trim() && !isOptional(input.hint))
  const projectName = data?.project?.name

  async function start() {
    if (!selected || missing) return
    setBusy(true)
    try {
      const { harness } = await api.attachHarness(sessionId, selected.id, inputs)
      useOrbital.setState((s) => ({ harnesses: { ...s.harnesses, [sessionId]: harness } }))
      if (lucky !== harness.options.lucky) {
        const { harness: tuned } = await api.setHarnessOptions(sessionId, { lucky })
        useOrbital.setState((s) => ({ harnesses: { ...s.harnesses, [sessionId]: tuned } }))
      }
      void useOrbital.getState().loadHarness(sessionId)
    } catch (err) {
      reportError(err, 'Failed to start the harness')
    } finally {
      setBusy(false)
    }
  }

  const rows = (list: HarnessTemplate[]) =>
    list.map((t) => (
      <div key={t.id} className="flex flex-col">
        <TemplateRow template={t} selected={t.id === selectedId} onPick={() => pick(t)} />
        {t.id === selectedId && (
          <TemplateDetail template={t} inputs={inputs} setInputs={setInputs} lucky={lucky} setLucky={setLucky} />
        )}
      </div>
    ))

  const focusProject = data?.project ?? undefined

  return (
    <>
      <HeaderBlock chrome={chrome}>
        {chrome.row(
          <>
            <Kicker>HARNESS</Kicker>
            <span aria-hidden className="flex-1" />
            {chrome.close}
          </>,
        )}
        <div className="mt-2 text-[15px] font-semibold text-text-bright">Start a harness</div>
        <div className="mt-1 font-mono text-[10px] text-[rgba(160,190,225,.6)]">
          for this session{projectName ? ` · project ${projectName}` : ''}
        </div>
      </HeaderBlock>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-[18px] py-[14px]" role="radiogroup" aria-label="Templates">
        {!data ? null : (
          <>
            {projectName && (
              <>
                <GroupHead kind="project">{`${projectName.toUpperCase()} · THIS PROJECT`}</GroupHead>
                {projectTemplates.length > 0 ? (
                  rows(projectTemplates)
                ) : (
                  <div className="flex flex-col gap-2 rounded-[9px] border border-dashed border-[rgba(150,205,255,.18)] bg-[rgba(4,8,16,.3)] p-3.5">
                    <div className="text-pretty text-[12.5px] leading-[1.55] text-[rgba(228,238,250,.9)]">
                      No templates for {projectName} yet. A project template appears only in this project&apos;s
                      sessions. A global one appears everywhere.
                    </div>
                    {!inWindow && (
                      <>
                        <div className="mt-0.5 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => openTemplates({ project: focusProject, draft: true })}
                            className="rounded-[7px] border border-[rgba(150,205,255,.2)] px-[11px] py-1.5 text-[12px] font-semibold text-[rgba(220,235,255,.9)] hover:border-[rgba(150,205,255,.35)]"
                          >
                            Draft one with the assistant
                          </button>
                          <button
                            type="button"
                            onClick={() => openTemplates({ project: focusProject })}
                            className="rounded-[7px] border border-[rgba(150,205,255,.14)] px-[11px] py-1.5 text-[12px] font-semibold text-[rgba(200,220,245,.75)] hover:border-[rgba(150,205,255,.3)]"
                          >
                            Open Settings
                          </button>
                        </div>
                        <div className="font-mono text-[9.5px] text-[rgba(160,190,225,.5)]">
                          both open Settings → Harness templates · scope pre-set to {projectName}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
            {globalTemplates.length > 0 && (
              <>
                <div className={projectName ? 'pt-1.5' : ''}>
                  <GroupHead kind="global">GLOBAL</GroupHead>
                </div>
                {rows(globalTemplates)}
              </>
            )}
            {!projectName && globalTemplates.length === 0 && (
              <div className="text-pretty text-[12.5px] leading-[1.55] text-[rgba(200,214,235,.85)]">
                No harness templates yet. Create one in Settings → Harness templates.
              </div>
            )}
          </>
        )}
      </div>
      <div className="flex flex-col gap-2 border-t border-[rgba(150,205,255,.1)] px-[18px] pb-4 pt-3">
        <button
          type="button"
          disabled={!selected || !!missing || busy}
          onClick={() => void start()}
          className="flex items-center justify-center rounded-lg bg-[oklch(85%_.12_205)] px-3.5 py-[9px] text-[13px] font-bold text-[#03111a] hover:brightness-[1.06] disabled:cursor-not-allowed disabled:bg-[oklch(85%_.12_205_/_.25)] disabled:text-[rgba(232,238,248,.6)] disabled:hover:brightness-100"
        >
          Start harness
        </button>
        <div className="text-center font-mono text-[9.5px] leading-[1.6] text-[rgba(160,190,225,.55)]">
          {!selected
            ? 'pick a template first'
            : missing
              ? `fill in ${missing.label} first`
              : 'step 1 is sent to the agent now · if a turn is running, after it'}
        </div>
      </div>
    </>
  )
}
