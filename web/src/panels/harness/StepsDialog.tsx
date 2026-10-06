import { useEffect, useState } from 'react'
import type { HarnessStep } from '../../lib/types'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { newStep } from '../harnessTemplates/editorDraft'
import { StepCard } from '../harnessTemplates/TemplateEditor'

const NO_KEYS: ReadonlySet<string> = new Set()

/**
 * A harness's steps in the template editor's cards, for a change made while
 * it runs or for what the agent proposed (spec 2026-10-06-harness-graph-and-
 * proposals-design § Edits by the user). Finished steps are shown, locked;
 * new steps go at the end, as the server adds them. `name` is edited only
 * when given — a proposed harness that is not attached yet.
 */
export function StepsDialog({
  open,
  eyebrow,
  title,
  steps: initial,
  locked = [],
  name: initialName,
  saveLabel,
  onClose,
  onSave,
}: {
  open: boolean
  eyebrow: string
  title: string
  steps: readonly HarnessStep[]
  locked?: readonly string[]
  name?: string
  saveLabel: string
  onClose: () => void
  /** Resolves to an error to show, or null when saved. */
  onSave: (steps: HarnessStep[], name: string | undefined) => Promise<string | null>
}) {
  const [steps, setSteps] = useState<HarnessStep[]>([...initial])
  const [name, setName] = useState(initialName)
  const [openStep, setOpenStep] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setSteps([...initial])
    setName(initialName)
    setOpenStep(null)
    setError(null)
    // Reset when it opens, not on every render of the harness underneath.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const done = new Set(locked)
  const add = () => {
    const step = newStep(steps.map((s) => s.id))
    setSteps([...steps, step])
    setOpenStep(step.id)
  }
  const save = async () => {
    setSaving(true)
    setError(await onSave(steps, name))
    setSaving(false)
  }

  return (
    <Dialog
      open={open}
      size="lg"
      eyebrow={eyebrow}
      title={title}
      onClose={onClose}
      footerCaption="esc cancel"
      footerLead={error ? <span className="text-[12px] text-[rgba(255,187,123,.9)]">{error}</span> : undefined}
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" onClick={() => void save()} disabled={saving}>
            {saveLabel}
          </Button>
        </>
      }
    >
      <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
        {name !== undefined && (
          <input
            aria-label="Harness name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mb-1 rounded-[7px] border border-[rgba(150,205,255,.16)] bg-[rgba(4,8,16,.7)] px-[9px] py-[7px] text-[13px] font-semibold text-text-bright focus:border-[rgba(150,205,255,.32)] focus:outline-none"
          />
        )}
        {steps.map((step, i) => (
          <StepCard
            key={step.id}
            steps={steps}
            index={i}
            open={openStep === step.id}
            known={NO_KEYS}
            locked={done.has(step.id)}
            note="a gate waits for an OK once ticked"
            onToggle={() => setOpenStep(openStep === step.id ? null : step.id)}
            onChange={(patch) => setSteps(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)))}
            onRemove={() => setSteps(steps.filter((_, j) => j !== i))}
          />
        ))}
        <button
          type="button"
          onClick={add}
          className="flex-none rounded-[9px] border border-dashed border-[rgba(150,205,255,.18)] px-2.5 py-2 text-left text-[12px] font-semibold text-[rgba(160,190,225,.75)] hover:bg-white/5"
        >
          + Add a step
        </button>
      </div>
    </Dialog>
  )
}
