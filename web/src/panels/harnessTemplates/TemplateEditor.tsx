import { useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { tagColor, type HarnessInput, type HarnessStep, type KnownHarnessProject, type StepMode, type Tag, type TemplateScope } from '../../lib/types'
import { Checkbox } from '../../ui/Checkbox'
import { MenuButton } from '../../ui/Menu'
import { inputUsage } from './logic'
import { newStep, type EditorDraft } from './editorDraft'
import {
  FIELD_LABEL,
  KEY_WARNING,
  KeyedText,
  KeyedTextArea,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
  SECTION_LABEL,
  Seg,
  SegShell,
  TagPill,
} from './parts'
import { ScopePicker } from './ScopePicker'

/** 30k's fields: a dark well, a .16 hairline. */
const WELL = 'rounded-lg border border-[rgba(150,205,255,.16)] bg-[rgba(4,8,16,.6)]'
const STEP_WELL = 'rounded-[7px] border border-[rgba(150,205,255,.16)] bg-[rgba(4,8,16,.7)]'
const INPUT_CELL =
  'min-w-0 rounded-md border border-[rgba(150,205,255,.16)] bg-[rgba(4,8,16,.6)] px-[7px] py-[5px] focus:border-[rgba(150,205,255,.32)] focus:outline-none'

/**
 * 30k's header, in place of Settings' own: ‹ back to the list, the
 * template's name, Draft…, whether there are unsaved changes, and Save.
 */
export function EditorHeader({
  name,
  status,
  dirty,
  saving,
  onBack,
  onSave,
  draftRef,
  draftOpen,
  onDraft,
}: {
  name: string
  status: string | null
  dirty: boolean
  saving: boolean
  onBack: () => void
  onSave: () => void
  draftRef: RefObject<HTMLButtonElement | null>
  draftOpen: boolean
  onDraft: () => void
}) {
  return (
    <div className="flex items-center gap-3.5 border-b border-[rgba(150,205,255,.1)] px-7 pb-[18px] pt-[22px]">
      <button
        type="button"
        aria-label="Back to the templates"
        onClick={onBack}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-[7px] border border-panel-border text-sm text-[rgba(200,220,245,.7)] transition-colors hover:bg-white/5 hover:text-text-bright"
      >
        ‹
      </button>
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[10px] tracking-[0.2em] text-accent/80">SETTINGS · HARNESS TEMPLATES</div>
        <h2 className="mt-1 truncate text-xl font-bold tracking-[-0.01em] text-text-bright">{name.trim() || 'New template'}</h2>
      </div>
      <button
        ref={draftRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={draftOpen}
        onClick={onDraft}
        className={SECONDARY_BUTTON}
      >
        Draft…
      </button>
      {status && <span className="font-mono text-[10.5px] text-[rgba(160,190,225,.55)]">{status}</span>}
      <button type="button" disabled={saving || !dirty} onClick={onSave} className={[PRIMARY_BUTTON, 'text-[12.5px]'].join(' ')}>
        Save
      </button>
    </div>
  )
}

function StepMark({ mode }: { mode: StepMode }) {
  return (
    <span
      aria-hidden
      className="block h-2 w-2 flex-none border-[1.3px] border-[rgba(200,220,245,.75)]"
      style={mode === 'gate' ? { borderRadius: 1.5, transform: 'rotate(45deg)' } : { borderRadius: '50%' }}
    />
  )
}

/** One step, one line when closed; the open one carries its fields (30k). */
function StepCard({
  step,
  index,
  count,
  open,
  known,
  onToggle,
  onMove,
  onChange,
  onRemove,
}: {
  step: HarnessStep
  index: number
  count: number
  open: boolean
  known: ReadonlySet<string>
  onToggle: () => void
  onMove: (by: -1 | 1) => void
  onChange: (patch: Partial<HarnessStep>) => void
  onRemove: () => void
}) {
  const arrow = 'cursor-pointer px-[3px] text-[8px] leading-none text-[rgba(200,220,245,.75)] disabled:cursor-default disabled:opacity-30'
  return (
    <div
      className={[
        'flex flex-none flex-col rounded-[9px] border bg-[rgba(4,8,16,.45)]',
        open ? 'border-[rgba(150,205,255,.26)]' : 'border-[rgba(150,205,255,.1)]',
      ].join(' ')}
    >
      <div className="flex items-center gap-2.5 py-[7px] pl-2.5 pr-2">
        <span className="flex flex-col gap-px">
          <button type="button" aria-label="Move up" disabled={index === 0} onClick={() => onMove(-1)} className={arrow}>
            ▲
          </button>
          <button type="button" aria-label="Move down" disabled={index === count - 1} onClick={() => onMove(1)} className={arrow}>
            ▼
          </button>
        </span>
        <span className="font-mono text-[10.5px] text-[rgba(160,190,225,.6)]">{String(index + 1).padStart(2, '0')}</span>
        <StepMark mode={step.mode} />
        <button type="button" aria-expanded={open} onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">
            {step.title.trim() ? <KeyedText text={step.title} known={known} /> : <span className="text-[rgba(160,190,225,.5)]">Untitled step</span>}
          </span>
          <span className="font-mono text-[10px] text-[rgba(160,190,225,.6)]">{step.mode}</span>
          <span className="w-2.5 text-[9px] text-[rgba(160,190,225,.6)]">{open ? '▾' : '▸'}</span>
        </button>
      </div>
      {open && (
        <div className="flex flex-col gap-2.5 pb-3 pl-[42px] pr-3 pt-1">
          <div className="flex items-center gap-2.5">
            <input
              aria-label="Step title"
              value={step.title}
              onChange={(e) => onChange({ title: e.target.value })}
              className={['min-w-0 flex-1 px-[9px] py-[7px] text-[12px] text-text-bright focus:border-[rgba(150,205,255,.32)] focus:outline-none', STEP_WELL].join(' ')}
            />
            <SegShell label="Step kind" radius={7}>
              <Seg first pad="narrow" active={step.mode === 'auto'} onClick={() => onChange({ mode: 'auto' })}>
                ● auto
              </Seg>
              <Seg pad="narrow" active={step.mode === 'gate'} onClick={() => onChange({ mode: 'gate' })}>
                ◆ gate
              </Seg>
            </SegShell>
          </div>
          <label className="flex flex-col gap-1">
            <span className={FIELD_LABEL}>INSTRUCTIONS</span>
            <KeyedTextArea
              value={step.instructions}
              onChange={(instructions) => onChange({ instructions })}
              known={known}
              box={STEP_WELL}
              type="px-[9px] py-2 text-[12px] leading-[1.55] text-[rgba(220,232,248,.9)]"
              minHeight={54}
            />
          </label>
          <div className="grid grid-cols-2 gap-2.5">
            <label className="flex min-w-0 flex-col gap-1">
              <span className={FIELD_LABEL}>DONE WHEN</span>
              <KeyedTextArea
                value={step.doneWhen}
                onChange={(doneWhen) => onChange({ doneWhen })}
                known={known}
                box={STEP_WELL}
                type="px-[9px] py-2 text-[11.5px] leading-[1.5] text-[rgba(220,232,248,.9)]"
                minHeight={34}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1">
              <span className={FIELD_LABEL}>VERIFY COMMAND · OPTIONAL</span>
              <KeyedTextArea
                value={step.verify ?? ''}
                onChange={(verify) => onChange({ verify: verify || undefined })}
                known={known}
                box="rounded-[7px] border border-[rgba(150,205,255,.16)] bg-[rgba(2,4,9,.8)]"
                type="break-all px-[9px] py-2 font-mono text-[10.5px] leading-[1.5] text-[rgba(214,230,248,.9)]"
                minHeight={34}
                spellCheck={false}
              />
            </label>
          </div>
          <div className="flex items-center gap-2.5 font-mono text-[10px] text-[rgba(160,190,225,.6)]">
            inputs resolve when the harness starts · a gate waits for an OK once ticked
            <span className="flex-1" />
            <button type="button" onClick={onRemove} className="text-[rgba(220,235,255,.8)] hover:text-text-bright">
              Remove step
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 30k: the template as one document. Left 400: about, inputs, how it runs —
 * read once. Right: the steps, one open at a time.
 */
export function TemplateEditor({
  draft,
  onChange,
  scope,
  onScopeChange,
  projects,
  cameFromRoot,
  tags,
  error,
}: {
  draft: EditorDraft
  onChange: (next: EditorDraft) => void
  scope: TemplateScope
  onScopeChange: (scope: TemplateScope) => void
  projects: readonly KnownHarnessProject[]
  cameFromRoot: string | null
  tags: readonly Tag[]
  error: string | null
}) {
  const [openStep, setOpenStep] = useState<string | null>(draft.steps[0]?.id ?? null)
  const [scopeOpen, setScopeOpen] = useState(false)
  const projectSegRef = useRef<HTMLButtonElement | null>(null)

  const usage = useMemo(() => inputUsage(draft.inputs, draft.steps), [draft.inputs, draft.steps])
  const known = useMemo(() => new Set(draft.inputs.map((i) => i.key.trim()).filter(Boolean)), [draft.inputs])

  const setInput = (i: number, patch: Partial<HarnessInput>) =>
    onChange({ ...draft, inputs: draft.inputs.map((input, j) => (j === i ? { ...input, ...patch } : input)) })
  const setStep = (i: number, patch: Partial<HarnessStep>) =>
    onChange({ ...draft, steps: draft.steps.map((step, j) => (j === i ? { ...step, ...patch } : step)) })
  const moveStep = (i: number, by: -1 | 1) => {
    const steps = draft.steps.slice()
    const [step] = steps.splice(i, 1)
    steps.splice(i + by, 0, step)
    onChange({ ...draft, steps })
  }
  const addStep = () => {
    const step = newStep(draft.steps.map((s) => s.id))
    onChange({ ...draft, steps: [...draft.steps, step] })
    setOpenStep(step.id)
  }
  const addInput = () => {
    const taken = draft.inputs.map((i) => i.key)
    let key = 'input'
    for (let n = 2; taken.includes(key); n++) key = `input${n}`
    onChange({ ...draft, inputs: [...draft.inputs, { key, label: '' }] })
  }

  const hueOf = (name: string) => tags.find((t) => t.name === name)?.hue
  const untaken = tags.filter((t) => !draft.tags.includes(t.name))
  const lastProject = scope.kind === 'project' ? scope : null

  const row = (label: string, children: ReactNode) => (
    <div className="flex items-center gap-1.5">
      <span className="w-[62px] flex-none text-[12px] font-semibold">{label}</span>
      {children}
    </div>
  )

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[400px_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col gap-2.5 overflow-y-auto overflow-x-hidden border-r border-[rgba(150,205,255,.1)] pb-4 pl-7 pr-[26px] pt-3.5">
        <div className={SECTION_LABEL}>ABOUT</div>
        <label className="flex flex-col gap-[5px]">
          <span className="text-[12px] font-semibold">Name</span>
          <input
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
            className={['px-2.5 py-1.5 text-[12.5px] text-text-bright focus:border-[rgba(150,205,255,.32)] focus:outline-none', WELL].join(' ')}
          />
        </label>
        <label className="flex flex-col gap-[5px]">
          <span className="text-[12px] font-semibold">Description</span>
          <textarea
            rows={1}
            value={draft.description}
            onChange={(e) => onChange({ ...draft, description: e.target.value })}
            className={[
              'resize-none px-2.5 py-1.5 text-[12px] leading-[1.5] text-[rgba(220,235,255,.9)] [field-sizing:content] focus:border-[rgba(150,205,255,.32)] focus:outline-none',
              WELL,
            ].join(' ')}
          />
        </label>
        {row(
          'Tags',
          <div className="flex flex-wrap items-center gap-1.5">
            {draft.tags.map((name) => (
              <TagPill
                key={name}
                name={name}
                hue={hueOf(name)}
                size="field"
                onRemove={() => onChange({ ...draft, tags: draft.tags.filter((t) => t !== name) })}
              />
            ))}
            {untaken.length > 0 && (
              <MenuButton
                aria-label="Add a tag"
                align="left"
                entries={untaken.map((t) => ({
                  key: String(t.id),
                  label: t.name,
                  icon: <span className="block h-1.5 w-1.5 rounded-full" style={{ background: tagColor(t.hue) }} />,
                  onSelect: () => onChange({ ...draft, tags: [...draft.tags, t.name] }),
                }))}
                renderTrigger={(props) => (
                  <button
                    {...props}
                    type="button"
                    className="rounded-full border border-dashed border-[rgba(150,205,255,.2)] px-[9px] py-[3px] text-[11px] text-[rgba(160,190,225,.7)] hover:bg-white/5"
                  >
                    + tag
                  </button>
                )}
              />
            )}
          </div>,
        )}
        {row(
          'Scope',
          <SegShell label="Scope" radius={8}>
            <Seg first pad="wide" active={scope.kind === 'global'} onClick={() => onScopeChange({ kind: 'global' })}>
              ◯ Global
            </Seg>
            <Seg
              pad="wide"
              buttonRef={projectSegRef}
              active={scope.kind === 'project'}
              aria-haspopup="dialog"
              aria-expanded={scopeOpen}
              onClick={() => setScopeOpen((o) => !o)}
            >
              ▢ {lastProject ? lastProject.name : 'project'} ▾
            </Seg>
          </SegShell>,
        )}

        <div className={['mt-0.5 flex items-center gap-2 border-t border-[rgba(150,205,255,.08)] pt-2.5', SECTION_LABEL].join(' ')}>
          INPUTS
          <span className="flex-1" />
          <button type="button" onClick={addInput} className="tracking-[0.04em] text-accent hover:text-text-soft">
            + input
          </button>
        </div>
        {draft.inputs.length > 0 && (
          <div className="grid grid-cols-[86px_110px_minmax(0,1fr)_12px] gap-1.5 font-mono text-[9px] tracking-[0.14em] text-[rgba(160,190,225,.5)]">
            <span>KEY</span>
            <span>LABEL</span>
            <span>HINT</span>
            <span />
          </div>
        )}
        {draft.inputs.map((input, i) => {
          const unused = usage.unused.has(input.key.trim())
          return (
            <div key={i} className="-mt-1 grid grid-cols-[86px_110px_minmax(0,1fr)_12px] items-center gap-1.5">
              <input
                aria-label="Key"
                value={input.key}
                spellCheck={false}
                onChange={(e) => setInput(i, { key: e.target.value })}
                className={['font-mono text-[10.5px] text-accent', INPUT_CELL].join(' ')}
              />
              <input
                aria-label="Label"
                value={input.label}
                onChange={(e) => setInput(i, { label: e.target.value })}
                className={['text-[11px] text-text-bright', INPUT_CELL].join(' ')}
              />
              <span className="relative min-w-0">
                <input
                  aria-label="Hint"
                  value={input.hint ?? ''}
                  onChange={(e) => setInput(i, { hint: e.target.value || undefined })}
                  className={['w-full text-[11px] text-[rgba(200,214,235,.8)]', unused ? 'pr-12' : '', INPUT_CELL].join(' ')}
                />
                {unused && (
                  <span
                    title="No step uses this input"
                    className="pointer-events-none absolute right-[7px] top-1/2 -translate-y-1/2 font-mono text-[9.5px]"
                    style={{ color: KEY_WARNING }}
                  >
                    unused
                  </span>
                )}
              </span>
              <button
                type="button"
                aria-label={`Remove ${input.key || 'input'}`}
                onClick={() => onChange({ ...draft, inputs: draft.inputs.filter((_, j) => j !== i) })}
                className="text-[10px] text-[rgba(160,190,225,.5)] hover:text-text-bright"
              >
                ✕
              </button>
            </div>
          )
        })}
        <div className="font-mono text-[9.5px] text-[rgba(160,190,225,.55)]">
          Use an input in any step as {'{{key}}'}. Starting the harness asks for each one.
        </div>

        <div className={['mt-0.5 border-t border-[rgba(150,205,255,.08)] pt-2.5', SECTION_LABEL].join(' ')}>HOW IT RUNS</div>
        <Checkbox
          checked={draft.options.commitPerStep}
          onChange={(on) => onChange({ ...draft, options: { ...draft.options, commitPerStep: on } })}
          label={<span className="text-text-bright">Commit after every step</span>}
        />
        <Checkbox
          checked={draft.options.lucky}
          onChange={(on) => onChange({ ...draft, options: { ...draft.options, lucky: on } })}
          label={<span className="text-text-bright">Feeling lucky by default</span>}
        />
        <div className="grid grid-cols-[minmax(0,1fr)_58px] items-center gap-x-3 gap-y-1.5 text-[12px] text-[rgba(220,235,255,.85)]">
          {(
            [
              ['maxAutoRounds', 'Messages sent on its own, at most'],
              ['maxIdleNudges', 'Nudges without a tick, then pause'],
              ['maxReviewerReopens', 'Reviewer send-backs per step'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="contents">
              <span>{label}</span>
              <input
                inputMode="numeric"
                value={String(draft.options[key])}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  if (e.target.value !== '' && Number.isInteger(n) && n >= 0) onChange({ ...draft, options: { ...draft.options, [key]: n } })
                }}
                className="w-full rounded-md border border-[rgba(150,205,255,.16)] bg-[rgba(4,8,16,.6)] px-2 py-[5px] text-center font-mono text-[11.5px] text-text-bright focus:border-[rgba(150,205,255,.32)] focus:outline-none"
              />
            </label>
          ))}
        </div>
        {error && (
          <div className="text-[12px] leading-[1.5]" style={{ color: KEY_WARNING }}>
            {error}
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto pb-5 pl-[26px] pr-7 pt-4">
        <div className={['mb-1 flex items-center gap-2', SECTION_LABEL].join(' ')}>
          STEPS · {draft.steps.length}
          <span className="flex-1" />
          <span className="tracking-[0.04em]">● auto · ◆ gate</span>
        </div>
        {draft.steps.map((step, i) => (
          <StepCard
            key={step.id}
            step={step}
            index={i}
            count={draft.steps.length}
            open={openStep === step.id}
            known={known}
            onToggle={() => setOpenStep(openStep === step.id ? null : step.id)}
            onMove={(by) => moveStep(i, by)}
            onChange={(patch) => setStep(i, patch)}
            onRemove={() => onChange({ ...draft, steps: draft.steps.filter((_, j) => j !== i) })}
          />
        ))}
        <button
          type="button"
          onClick={addStep}
          className="flex-none rounded-[9px] border border-dashed border-[rgba(150,205,255,.18)] px-2.5 py-2 text-left text-[12px] font-semibold text-[rgba(160,190,225,.75)] hover:bg-white/5"
        >
          + Add step
        </button>
      </div>

      <ScopePicker
        open={scopeOpen}
        anchorRef={projectSegRef}
        projects={projects}
        value={scope}
        cameFromRoot={cameFromRoot}
        footer={(s) => `move to ${s.kind === 'global' ? 'Global' : s.name} on Save`}
        onPick={(s) => {
          onScopeChange(s)
          setScopeOpen(false)
        }}
        onClose={() => setScopeOpen(false)}
      />
    </div>
  )
}
