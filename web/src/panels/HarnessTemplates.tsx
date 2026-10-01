import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { generateStepId } from '../lib/harness'
import { DEFAULT_HARNESS_OPTIONS, type HarnessInput, type HarnessOptions, type HarnessStep, type HarnessTemplate, type StepMode } from '../lib/types'
import { Toggle } from '../ui/Checkbox'
import { Button } from '../ui/Button'
import { Input, TextArea } from '../ui/Input'
import { Segmented } from '../ui/Segmented'
import { Select } from '../ui/Select'
import { useOrbital } from '../store/store'
import { lastLaunch } from './NewSessionDialog'

type Draft = Omit<HarnessTemplate, 'id' | 'createdAt' | 'updatedAt'>

const MODE_OPTIONS: Array<{ value: StepMode; label: string }> = [
  { value: 'auto', label: 'auto' },
  { value: 'gate', label: 'gate' },
]

const LABEL = 'font-mono text-[10px] tracking-[0.18em] text-[rgba(160,190,225,.6)]'
const MUTED = 'text-[rgba(160,190,225,.6)]'
const CARD = 'flex flex-col gap-2 rounded-[8px] border border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.35)] p-3'

const EMPTY: Draft = { name: '', description: '', tags: [], inputs: [], steps: [], options: DEFAULT_HARNESS_OPTIONS }

/** How a harness runs (spec 2026-09-30-harness-lucky-and-step-records-design § Options). */
function OptionsFields({ options, onChange }: { options: HarnessOptions; onChange: (next: HarnessOptions) => void }) {
  const count = (key: 'maxAutoRounds' | 'maxIdleNudges' | 'maxReviewerReopens', label: string) => (
    <Field label={label}>
      <Input
        font="mono"
        inputMode="numeric"
        value={String(options[key])}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (Number.isInteger(n) && n >= 0) onChange({ ...options, [key]: n })
        }}
      />
    </Field>
  )
  return (
    <div className="flex flex-col gap-3">
      <span className={LABEL}>HOW IT RUNS</span>
      <label className="flex items-center gap-3">
        <Toggle checked={options.commitPerStep} onChange={(on) => onChange({ ...options, commitPerStep: on })} />
        <span className="text-[12.5px] text-text-bright">Commit after every step</span>
        <span className={`text-[11.5px] ${MUTED}`}>locally, never pushed — each step becomes one diff to review or undo</span>
      </label>
      <label className="flex items-center gap-3">
        <Toggle checked={options.lucky} onChange={(on) => onChange({ ...options, lucky: on })} />
        <span className="text-[12.5px] text-text-bright">Feeling lucky by default</span>
        <span className={`text-[11.5px] ${MUTED}`}>a reviewer decides the gates; switchable per session</span>
      </label>
      <div className="grid grid-cols-3 gap-3">
        {count('maxAutoRounds', 'MESSAGES ON ITS OWN')}
        {count('maxIdleNudges', 'NUDGES WITHOUT A TICK')}
        {count('maxReviewerReopens', 'REVIEWER SEND-BACKS')}
      </div>
      {options.lucky && <span className={`text-[11px] ${MUTED}`}>With feeling lucky, the message cap does not apply.</span>}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className={LABEL}>{label}</span>
      {children}
    </label>
  )
}

function newStep(taken: readonly string[]): HarnessStep {
  const title = `Step ${taken.length + 1}`
  return { id: generateStepId(title, taken), title, instructions: '', mode: 'auto', doneWhen: '' }
}

/** One template as a document: name, tags, the inputs asked at start, the steps. */
function Editor({
  draft,
  onChange,
  error,
}: {
  draft: Draft
  onChange: (next: Draft) => void
  error: string | null
}) {
  // The tag field is typed as text and split on save, so a trailing comma is not eaten mid-typing.
  const [tagText, setTagText] = useState(draft.tags.join(', '))
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

  return (
    <div className="flex flex-col gap-4">
      <Field label="NAME">
        <Input value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} />
      </Field>
      <Field label="DESCRIPTION">
        <TextArea rows={2} value={draft.description} onChange={(e) => onChange({ ...draft, description: e.target.value })} />
      </Field>
      <Field label="TAGS">
        <Input
          value={tagText}
          placeholder="ui, redesign"
          onChange={(e) => {
            setTagText(e.target.value)
            onChange({ ...draft, tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })
          }}
        />
      </Field>

      <OptionsFields options={draft.options} onChange={(options) => onChange({ ...draft, options })} />

      <div className="flex flex-col gap-2">
        <div className="flex items-center">
          <span className={LABEL}>INPUTS · asked when the harness starts, used as {'{{key}}'}</span>
          <span aria-hidden className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange({ ...draft, inputs: [...draft.inputs, { key: `input${draft.inputs.length + 1}`, label: '' }] })}
          >
            + input
          </Button>
        </div>
        {draft.inputs.map((input, i) => (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1.6fr)_auto] items-center gap-2">
            <Input font="mono" value={input.key} placeholder="key" onChange={(e) => setInput(i, { key: e.target.value })} />
            <Input value={input.label} placeholder="Label" onChange={(e) => setInput(i, { label: e.target.value })} />
            <Input
              value={input.hint ?? ''}
              placeholder="Hint"
              onChange={(e) => setInput(i, { hint: e.target.value || undefined })}
            />
            <Button variant="ghost" size="sm" onClick={() => onChange({ ...draft, inputs: draft.inputs.filter((_, j) => j !== i) })}>
              Remove
            </Button>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center">
          <span className={LABEL}>STEPS · a gate waits for your OK once it is done</span>
          <span aria-hidden className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange({ ...draft, steps: [...draft.steps, newStep(draft.steps.map((s) => s.id))] })}
          >
            + step
          </Button>
        </div>
        {draft.steps.map((step, i) => (
          <div key={step.id} className={CARD}>
            <div className="flex items-center gap-2">
              <span className={`w-5 font-mono text-[11px] ${MUTED}`}>{i + 1}</span>
              <Input className="flex-1" value={step.title} onChange={(e) => setStep(i, { title: e.target.value })} />
              <Segmented label="Step mode" options={MODE_OPTIONS} value={step.mode} onChange={(mode: StepMode) => setStep(i, { mode })} />
            </div>
            <Field label="INSTRUCTIONS">
              <TextArea rows={4} value={step.instructions} onChange={(e) => setStep(i, { instructions: e.target.value })} />
            </Field>
            <Field label="DONE WHEN">
              <TextArea rows={2} value={step.doneWhen} onChange={(e) => setStep(i, { doneWhen: e.target.value })} />
            </Field>
            <Field label="VERIFY · optional, must exit 0 in the session's directory">
              <Input
                font="mono"
                value={step.verify ?? ''}
                placeholder="npm test"
                onChange={(e) => setStep(i, { verify: e.target.value || undefined })}
              />
            </Field>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" disabled={i === 0} onClick={() => moveStep(i, -1)}>
                ↑
              </Button>
              <Button variant="ghost" size="sm" disabled={i === draft.steps.length - 1} onClick={() => moveStep(i, 1)}>
                ↓
              </Button>
              <span aria-hidden className="flex-1" />
              <Button variant="ghost" size="sm" onClick={() => onChange({ ...draft, steps: draft.steps.filter((_, j) => j !== i) })}>
                Remove step
              </Button>
            </div>
          </div>
        ))}
      </div>

      {error && <div className="text-[12px] text-[var(--state-interrupted)]">{error}</div>}
    </div>
  )
}

/** How many recent sessions the assistant offers as an example. */
const EXAMPLE_SESSIONS = 30

/**
 * The assistant (spec 2026-09-30-assisted-harness-templates-design): a
 * description and/or an example session drafted into the editor, or a
 * session that interviews the user and saves the template itself.
 */
function Assistant({ onDraft, onClose }: { onDraft: (draft: Draft) => void; onClose: () => void }) {
  const sessions = useOrbital((s) => s.sessions)
  const settings = useOrbital((s) => s.settings)
  const [description, setDescription] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const recent = Object.values(sessions)
    .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))
    .slice(0, EXAMPLE_SESSIONS)
  const options = [
    { value: '', label: 'No example session' },
    ...recent.map((s) => ({ value: s.id, label: s.title || s.cwd })),
  ]

  async function draft() {
    setBusy(true)
    setError(null)
    try {
      const { template } = await api.draftHarnessTemplate({
        description: description.trim() || undefined,
        sessionId: sessionId || undefined,
      })
      onDraft({ ...template, options: template.options ?? DEFAULT_HARNESS_OPTIONS })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to draft the template')
    } finally {
      setBusy(false)
    }
  }

  async function interview() {
    const { cwd, permissionMode } = lastLaunch(settings)
    if (!cwd) {
      setError('Set a default project directory in Settings → Sessions, or launch a session once, first.')
      return
    }
    try {
      const { prompt } = await api.getHarnessInterviewPrompt()
      const store = useOrbital.getState()
      const id = await store.launchSession({ cwd, prompt, permissionMode, model: 'sonnet' })
      store.setDialog(null)
      await store.select(id)
    } catch (err) {
      reportError(err, 'Failed to start the conversation')
    }
  }

  return (
    <div className={CARD}>
      <div className="flex items-center">
        <span className={LABEL}>DRAFT WITH THE ASSISTANT</span>
        <span aria-hidden className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
      <Field label="HOW THE WORK GOES">
        <TextArea
          rows={5}
          value={description}
          placeholder="E.g. I load the design, the legacy component and its usage, build the component, do Storybook, tune parity and the API, migrate the call sites, test, review, prepare the PR with screenshots."
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <Field label="EXAMPLE SESSION · optional, where this work was done">
        <Select options={options} value={sessionId} onChange={(id: string) => setSessionId(id)} font="sans" />
      </Field>
      {error && <div className="text-[12px] text-[var(--state-interrupted)]">{error}</div>}
      <div className="flex items-center gap-2">
        <Button variant="primary" size="md" disabled={busy || (!description.trim() && !sessionId)} onClick={() => void draft()}>
          {busy ? 'Drafting…' : 'Draft'}
        </Button>
        <span className={`text-[11.5px] ${MUTED}`}>or</span>
        <Button variant="ghost" size="md" disabled={busy} onClick={() => void interview()}>
          Draft in a conversation
        </Button>
      </div>
    </div>
  )
}

/**
 * Settings → Harness templates (spec 2026-09-30-session-harness-design § UI):
 * the list on the left, the selected template as one editable document on
 * the right, saved whole.
 */
export function HarnessTemplatesSection({ active, onSaved }: { active: boolean; onSaved: () => void }) {
  const [templates, setTemplates] = useState<HarnessTemplate[] | null>(null)
  // `null` id with a draft is a new template not saved yet.
  const [selected, setSelected] = useState<{ id: number | null; draft: Draft } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [assisting, setAssisting] = useState(false)
  // Remounts the editor for every template opened or drafted, so its own field state starts over.
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (!active) return
    api
      .listHarnessTemplates()
      .then(({ templates }) => setTemplates(templates))
      .catch((err) => reportError(err, 'Failed to load harness templates'))
  }, [active])

  const open = (template: HarnessTemplate | null) => {
    setError(null)
    setRevision((r) => r + 1)
    setSelected(
      template
        ? {
            id: template.id,
            draft: {
              name: template.name, description: template.description, tags: template.tags,
              inputs: template.inputs, steps: template.steps, options: template.options ?? DEFAULT_HARNESS_OPTIONS,
            },
          }
        : { id: null, draft: { ...EMPTY, steps: [newStep([])] } },
    )
  }

  async function save() {
    if (!selected) return
    setSaving(true)
    setError(null)
    try {
      const saved =
        selected.id === null
          ? await api.createHarnessTemplate(selected.draft)
          : await api.updateHarnessTemplate(selected.id, selected.draft)
      setTemplates((list) => {
        const rest = (list ?? []).filter((t) => t.id !== saved.id)
        return [...rest, saved].sort((a, b) => a.name.localeCompare(b.name))
      })
      setSelected({ id: saved.id, draft: selected.draft })
      onSaved()
    } catch (err) {
      // The server names what is wrong ("step … needs a title"); that is the message.
      setError(err instanceof Error ? err.message : 'Failed to save the template')
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (selected?.id == null) return setSelected(null)
    if (!window.confirm(`Delete “${selected.draft.name}”? Sessions running it keep their checklist.`)) return
    try {
      await api.deleteHarnessTemplate(selected.id)
      setTemplates((list) => (list ?? []).filter((t) => t.id !== selected.id))
      setSelected(null)
      onSaved()
    } catch (err) {
      reportError(err, 'Failed to delete the template')
    }
  }

  return (
    <div className="grid min-h-0 grid-cols-[260px_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto border-r border-[rgba(150,205,255,.1)] px-4 py-4">
        <div className="flex items-center">
          <span className={LABEL}>TEMPLATES · {templates?.length ?? 0}</span>
          <span aria-hidden className="flex-1" />
          <Button variant="ghost" size="sm" onClick={() => open(null)}>
            + new
          </Button>
        </div>
        <Button variant="ghost" size="sm" className="w-full" onClick={() => setAssisting(true)}>
          ✦ Draft with the assistant
        </Button>
        {templates === null && <div className={`text-[12px] ${MUTED}`}>Loading…</div>}
        {templates?.map((template) => (
          <button
            key={template.id}
            type="button"
            onClick={() => open(template)}
            aria-current={selected?.id === template.id ? 'true' : undefined}
            className={[
              'flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors',
              selected?.id === template.id
                ? 'border-panel-border bg-[rgba(150,205,255,.08)]'
                : 'border-transparent hover:bg-white/5',
            ].join(' ')}
          >
            <span className="text-[13px] font-semibold text-text-bright">{template.name}</span>
            <span className={`font-mono text-[10px] ${MUTED}`}>
              {template.steps.length} steps{template.tags.length > 0 && ` · ${template.tags.join(', ')}`}
            </span>
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-col overflow-y-auto px-8 pb-5 pt-4">
        {assisting && (
          <div className="mb-5">
            <Assistant
              onClose={() => setAssisting(false)}
              onDraft={(draft) => {
                setAssisting(false)
                setError(null)
                // A new template, not saved: the user reads it and presses Create.
                setSelected({ id: null, draft })
                setRevision((r) => r + 1)
              }}
            />
          </div>
        )}
        {selected ? (
          <>
            <Editor
              key={revision}
              draft={selected.draft}
              error={error}
              onChange={(draft) => setSelected({ ...selected, draft })}
            />
            <div className="mt-5 flex gap-2">
              <Button variant="primary" size="md" disabled={saving} onClick={() => void save()}>
                {selected.id === null ? 'Create template' : 'Save'}
              </Button>
              <span aria-hidden className="flex-1" />
              <Button variant="danger" size="md" onClick={() => void remove()}>
                {selected.id === null ? 'Discard' : 'Delete'}
              </Button>
            </div>
          </>
        ) : (
          <div className={`pt-2 text-[12.5px] leading-[1.5] ${MUTED}`}>
            A template is a checklist for one kind of work. Put it into a session from the session's Harness
            panel, and the session follows it step by step, stopping at gates and real questions.
          </div>
        )}
      </div>
    </div>
  )
}
