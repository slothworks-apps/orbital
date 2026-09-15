import { useEffect } from 'react'
import type { ReactNode } from 'react'

export interface DialogProps {
  open: boolean
  title: string
  footer?: ReactNode
  onClose: () => void
  children?: ReactNode
}

const cornerClasses: Record<'tl' | 'tr' | 'bl' | 'br', string> = {
  tl: 'absolute left-0 top-0 h-3 w-3 border-l-2 border-t-2 border-text-soft/70',
  tr: 'absolute right-0 top-0 h-3 w-3 border-r-2 border-t-2 border-text-soft/70',
  bl: 'absolute left-0 bottom-0 h-3 w-3 border-l-2 border-b-2 border-text-soft/70',
  br: 'absolute right-0 bottom-0 h-3 w-3 border-r-2 border-b-2 border-text-soft/70',
}

const corners = ['tl', 'tr', 'bl', 'br'] as const

export function Dialog({ open, title, footer, onClose, children }: DialogProps) {
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-space/70 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-w-md rounded-lg border border-panel-border bg-panel p-5 font-sans text-text-bright shadow-2xl backdrop-blur-md"
      >
        {corners.map((corner) => (
          <span key={corner} aria-hidden data-corner={corner} className={cornerClasses[corner]} />
        ))}
        <h2 className="mb-3 text-sm font-mono font-semibold tracking-wide text-text-soft">{title}</h2>
        <div>{children}</div>
        {footer && <div className="mt-4 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  )
}
