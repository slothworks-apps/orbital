import { swatch } from '../../lib/palette'
import type { HarnessTemplate } from '../../lib/types'
import { ScopeMark } from './parts'

/**
 * The template list's pieces (canvas 30c), shared by the Harness panel's
 * start view and New session's step 2 (canvas `Feature - New session
 * harness` 65a).
 */

/** "required unless the hint says optional" (30c). */
export const isOptional = (hint: string | undefined) => /optional/i.test(hint ?? '')

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function gateCount(t: HarnessTemplate) {
  return t.steps.filter((s) => s.mode === 'gate').length
}

/** "7 steps · 3 gates" (30c). */
export const templateMeta = (t: HarnessTemplate) =>
  `${plural(t.steps.length, 'step')} · ${plural(gateCount(t), 'gate')}`

/** The inputs a launch still waits for: required ones (30c) left empty. */
export function missingInputs(t: HarnessTemplate, inputs: Record<string, string>) {
  return t.inputs.filter((input) => !isOptional(input.hint) && !inputs[input.key]?.trim())
}

/**
 * A template row (30c): radio dot, name, "7 steps · 3 gates". `inline`, the
 * start view's, puts the count beside the name; `stacked`, New session's
 * (65a), puts it under the name with `note` after it ("last used here").
 */
export function TemplateRow({
  template,
  selected,
  onPick,
  layout = 'inline',
  note,
}: {
  template: HarnessTemplate
  selected: boolean
  onPick: () => void
  layout?: 'inline' | 'stacked'
  note?: string
}) {
  const meta = templateMeta(template) + (note ? ` · ${note}` : '')
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onPick}
      className={[
        'flex w-full shrink-0 items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left',
        layout === 'stacked' ? 'hover:border-line/30' : 'hover:bg-line/4',
      ].join(' ')}
      style={{
        borderColor: selected ? swatch('accent', 0.6) : swatch('line', 0.1),
        background: selected ? swatch('accent', 0.07) : undefined,
      }}
    >
      <span
        aria-hidden
        className="block size-[10px] shrink-0 box-border rounded-full"
        style={{
          border: `1.4px solid ${selected ? 'var(--color-accent)' : 'color-mix(in oklab, var(--color-ink-900) 60%, transparent)'}`,
          boxShadow: selected ? 'inset 0 0 0 2px var(--color-space)' : undefined,
          background: selected ? swatch('accent') : 'transparent',
        }}
      />
      {layout === 'stacked' ? (
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate fs-12.5 font-semibold text-ink-100">{template.name}</span>
          <span className="truncate font-mono fs-10 text-ink-900/60">{meta}</span>
        </span>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate fs-12.5 font-semibold text-ink-100">{template.name}</span>
          <span className="shrink-0 font-mono fs-10 text-ink-900/60">{meta}</span>
        </>
      )}
    </button>
  )
}

/** A group's kicker in the list (30c): ▢ ORBITAL · THIS PROJECT, ◯ GLOBAL. */
export function GroupHead({ kind, children }: { kind: 'project' | 'global'; children: string }) {
  return (
    <div className="flex items-center gap-2 pb-1 pt-0.5 font-mono fs-9.5 tracking-[0.18em] text-ink-900/60">
      <ScopeMark kind={kind} />
      {children}
    </div>
  )
}
