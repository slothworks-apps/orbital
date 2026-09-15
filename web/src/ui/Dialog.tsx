import { useEffect } from 'react'
import type { ReactNode } from 'react'

export interface DialogProps {
  open: boolean
  title: string
  /** Mono uppercase kicker above the title (e.g. "LAUNCH", "/CLEAR"). */
  eyebrow?: string
  /** Panel width: md = confirm dialogs, lg = forms like New session. */
  size?: 'md' | 'lg'
  footer?: ReactNode
  /** Left side of the footer row — mono muted keyboard hints or captions. */
  footerCaption?: ReactNode
  onClose: () => void
  children?: ReactNode
}

const cornerClasses: Record<'tl' | 'tr' | 'bl' | 'br', string> = {
  tl: 'absolute -left-px -top-px h-3.5 w-3.5 rounded-tl-lg border-l-2 border-t-2 border-accent',
  tr: 'absolute -right-px -top-px h-3.5 w-3.5 rounded-tr-lg border-r-2 border-t-2 border-accent',
  bl: 'absolute -left-px -bottom-px h-3.5 w-3.5 rounded-bl-lg border-l-2 border-b-2 border-accent',
  br: 'absolute -right-px -bottom-px h-3.5 w-3.5 rounded-br-lg border-r-2 border-b-2 border-accent',
}

const corners = ['tl', 'tr', 'bl', 'br'] as const

const sizeClasses: Record<NonNullable<DialogProps['size']>, string> = {
  md: 'max-w-lg',
  lg: 'max-w-2xl',
}

export function Dialog({
  open,
  title,
  eyebrow,
  size = 'md',
  footer,
  footerCaption,
  onClose,
  children,
}: DialogProps) {
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-space/70 p-6 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative flex max-h-full w-full flex-col rounded-lg border border-accent/25 bg-panel-solid font-sans text-text-bright shadow-2xl shadow-accent/5 ${sizeClasses[size]}`}
      >
        {corners.map((corner) => (
          <span key={corner} aria-hidden data-corner={corner} className={cornerClasses[corner]} />
        ))}
        <header className="flex items-start justify-between gap-4 border-b border-panel-border px-5 py-4">
          <div className="min-w-0">
            {eyebrow && (
              <div className="font-mono text-[10px] tracking-[0.25em] text-accent">
                {eyebrow}
              </div>
            )}
            <h2 className="truncate text-lg font-semibold text-text-bright">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="shrink-0 rounded border border-panel-border px-1.5 py-0.5 font-mono text-[10px] text-text-muted transition-colors hover:bg-white/5"
          >
            esc
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {(footer || footerCaption) && (
          <footer className="flex items-center justify-between gap-3 border-t border-panel-border px-5 py-3">
            <div className="min-w-0 truncate font-mono text-[11px] text-text-muted">
              {footerCaption}
            </div>
            <div className="flex shrink-0 items-center gap-2">{footer}</div>
          </footer>
        )}
      </div>
    </div>
  )
}
