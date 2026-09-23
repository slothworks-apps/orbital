import { formatContextWindow } from '../lib/format'
import { useCustomModel, type UseCustomModelOptions } from '../lib/customModel'
import { Input, type FieldSize } from './Input'

export interface CustomModelFieldProps extends UseCustomModelOptions {
  /** `lg` in the New session dialog, `sm` in the Settings row — the fields around it. */
  size?: FieldSize
}

/**
 * The text field under `ModelCards`' Other card: any model id Claude Code
 * accepts, checked on Enter or blur through `useCustomModel`. No canvas
 * exists for it (spec 2026-09-16-agent-model-design § Other model), so it
 * reuses the field and caption styles already around it.
 */
export function CustomModelField({ size = 'lg', ...options }: CustomModelFieldProps) {
  const field = useCustomModel(options)

  return (
    <div className="flex w-full flex-col gap-1.5">
      <Input
        font="mono"
        size={size}
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
      {field.status !== 'idle' && (
        <p
          role="status"
          className={[
            'font-mono text-[11px] leading-[1.4] [overflow-wrap:anywhere]',
            // Error tone: the red the Transcript's error banner uses.
            field.status === 'invalid' ? 'text-red-300' : 'text-[rgba(160,190,225,.7)]',
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
      )}
    </div>
  )
}
