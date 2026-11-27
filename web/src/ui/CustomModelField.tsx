import { formatContextWindow } from '../lib/format'
import { useCustomModel, type CustomModelState, type UseCustomModelOptions } from '../lib/customModel'
import { Button } from './Button'
import { Input, type FieldSize } from './Input'

export interface CustomModelFieldProps extends UseCustomModelOptions {
  /** `lg` in the New session dialog, `sm` in the Settings row — the fields around it. `field` only. */
  size?: FieldSize
  autoFocus?: boolean
  /**
   * `field` is the text field under Settings' Other card; `in-list` is New
   * session's Custom ID… row typed in place, inside the Other list (canvas
   * 72b): the field and its Use ⏎, the id taken only on ⏎ or Use — a
   * validated id goes to the Other card, so only a check under way or a
   * rejection shows here.
   */
  variant?: 'field' | 'in-list'
}

/**
 * Any model id Claude Code accepts, checked through `useCustomModel`. No
 * canvas exists for the `field` variant (spec 2026-09-16-agent-model-design §
 * Other model), so it reuses the field and caption styles already around it.
 */
export function CustomModelField({ size = 'lg', autoFocus, variant = 'field', ...options }: CustomModelFieldProps) {
  const field = useCustomModel(options)

  if (variant === 'in-list') {
    const text = field.text.trim()
    // An id already valid (the one the Other card holds, reopened) is taken
    // again as it is; anything else is checked first.
    const take = () => {
      if (!text) return
      if (field.status === 'valid') {
        options.onValidated(text, { resolvedModel: field.resolvedModel, contextWindow: field.contextWindow })
      } else void field.validate()
    }
    return (
      <div className="flex flex-col">
        {/* canvas 72b: the field and Use ⏎ 6px apart, 2px inside the list's edge. */}
        <div className="flex items-center gap-1.5 p-[2px]">
          <Input
            variant="in-list"
            font="mono"
            className="min-w-0 flex-1"
            autoFocus={autoFocus}
            aria-label="Custom model ID"
            placeholder="model ID"
            spellCheck={false}
            autoComplete="off"
            value={field.text}
            invalid={field.status === 'invalid'}
            onChange={(e) => field.setText(e.target.value)}
            onKeyDown={(e) => {
              // Plain Enter only: ⌘⏎ belongs to the dialog's Launch.
              if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                e.preventDefault()
                take()
              }
            }}
          />
          <Button variant="outline" size="in-list" disabled={!text || field.status === 'checking'} onClick={take}>
            Use ⏎
          </Button>
        </div>
        {(field.status === 'checking' || field.status === 'invalid') && (
          <CustomModelStatus field={field} className="px-2.5 pb-1 pt-1.5" />
        )}
      </div>
    )
  }

  return (
    <div className="flex w-full flex-col gap-1.5">
      <Input
        font="mono"
        size={size}
        autoFocus={autoFocus}
        aria-label="Model id"
        placeholder="claude-opus-4-6"
        spellCheck={false}
        autoComplete="off"
        value={field.text}
        invalid={field.status === 'invalid'}
        onChange={(e) => field.setText(e.target.value)}
        onBlur={() => void field.validate()}
        onKeyDown={(e) => {
          // Plain Enter only: ⌘⏎ belongs to the dialog's Launch.
          if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
            e.preventDefault()
            void field.validate()
          }
        }}
      />
      {field.status !== 'idle' && <CustomModelStatus field={field} />}
    </div>
  )
}

/** The line under the field: checking, the resolved id it validated to, or Claude Code's reason it would not. */
function CustomModelStatus({ field, className = '' }: { field: CustomModelState; className?: string }) {
  return (
    <p
      role="status"
      className={[
        'font-mono fs-11 leading-[1.4] [overflow-wrap:anywhere]',
        // Error tone: the red the Transcript's error banner uses.
        field.status === 'invalid' ? 'text-red-300' : 'text-ink-900/70',
        className,
      ].join(' ')}
    >
      {field.status === 'checking' && 'checking…'}
      {field.status === 'valid' && (
        <>
          <span className="text-accent">✓</span> {field.resolvedModel ?? field.text.trim()}
          {field.contextWindow !== null && ` · ${formatContextWindow(field.contextWindow)} ctx`}
        </>
      )}
      {field.status === 'invalid' && field.reason}
    </p>
  )
}
