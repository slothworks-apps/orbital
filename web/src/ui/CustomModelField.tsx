import { formatContextWindow } from '../lib/format'
import { useCustomModel, type CustomModelField as CustomModelFieldState, type CustomModelState, type UseCustomModelOptions } from '../lib/customModel'
import { Button } from './Button'
import { Input, type FieldSize } from './Input'

export interface CustomModelFieldProps extends UseCustomModelOptions {
  /** `lg` in the New session dialog, `sm` in the Settings row — the fields around it. */
  size?: FieldSize
  autoFocus?: boolean
}

/**
 * Any model id Claude Code accepts, checked through `useCustomModel` — the
 * text field under Settings' Other card. No canvas exists for it (spec
 * 2026-09-16-agent-model-design § Other model), so it reuses the field and
 * caption styles already around it.
 */
export function CustomModelField({ size = 'lg', autoFocus, ...options }: CustomModelFieldProps) {
  const field = useCustomModel(options)
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

export interface CustomModelListFieldProps {
  /** The `useCustomModel` state the caller holds, so the text outlives the list it is typed in. */
  field: CustomModelFieldState
  /** ⏎ or Use: the caller takes the id, or checks it first (`field.validate`). */
  onTake: () => void
  autoFocus?: boolean
  /** The phone's sheet (canvas 72d): a 40 px field and Use for a finger. */
  touch?: boolean
}

/**
 * New session's Custom ID… row typed in place, inside Other's list (canvas
 * 72b) or the phone's sheet (72d): the field and its Use, the id taken only
 * on ⏎ or Use — a validated id goes to the Other card, so only a check under
 * way or a rejection shows here.
 */
export function CustomModelListField({ field, onTake, autoFocus, touch = false }: CustomModelListFieldProps) {
  const text = field.text.trim()
  return (
    <div className="flex flex-col">
      <div
        className={
          touch
            ? // 72d draws no frame for the typed row: it keeps the Custom ID… row's 52 px, 2px inside the sheet's edge.
              'flex h-13 items-center gap-1.5 px-0.5'
            : // canvas 72b: the field and Use ⏎ 6px apart, 2px inside the list's edge.
              'flex items-center gap-1.5 p-[2px]'
        }
      >
        <Input
          variant={touch ? 'in-list-touch' : 'in-list'}
          font="mono"
          className="min-w-0 flex-1"
          autoFocus={autoFocus}
          aria-label="Custom model ID"
          placeholder="model ID"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          enterKeyHint="done"
          value={field.text}
          invalid={field.status === 'invalid'}
          onChange={(e) => field.setText(e.target.value)}
          onKeyDown={(e) => {
            // Plain Enter only: ⌘⏎ belongs to the dialog's Launch.
            if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
              e.preventDefault()
              onTake()
            }
          }}
        />
        <Button
          variant="outline"
          size={touch ? 'in-list-touch' : 'in-list'}
          disabled={!text || field.status === 'checking'}
          onClick={onTake}
        >
          {touch ? 'Use' : 'Use ⏎'}
        </Button>
      </div>
      {(field.status === 'checking' || field.status === 'invalid') && (
        <CustomModelStatus field={field} className={touch ? 'px-1.5 pb-1' : 'px-2.5 pb-1 pt-1.5'} />
      )}
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
