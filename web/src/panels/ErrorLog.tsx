import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import type { ErrorRecord } from '../lib/types'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'

/**
 * The whole record as one block of text, which is what a person pasting it
 * into an issue or a session actually wants — not the one line the row shows.
 */
export function formatRecordForCopy(error: ErrorRecord): string {
  const lines = [
    `[${new Date(error.at).toISOString()}] ${error.source} · ${error.kind}`,
    error.sessionId ? `session: ${error.sessionId}` : null,
    '',
    error.message,
  ]
  if (error.context) lines.push('', JSON.stringify(error.context, null, 2))
  if (error.detail) lines.push('', error.detail)
  return lines.filter((line) => line !== null).join('\n')
}

/** Best-effort copy. `navigator.clipboard` is absent in jsdom and on any
 * non-secure origin, and a log that throws while you are reading it about
 * why something else threw is not a trade worth making. */
async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text)
  } catch (err) {
    console.error('orbital: could not copy the error to the clipboard', err)
  }
}

function ErrorRow({ error }: { error: ErrorRecord }) {
  const [expanded, setExpanded] = useState(false)
  const bodyId = `error-detail-${error.id}`
  const hasBody = Boolean(error.detail) || Boolean(error.context)

  return (
    <li className="border-b border-[rgba(150,205,255,.1)] py-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] text-[rgba(160,190,225,.7)]">
            {new Date(error.at).toLocaleString()} · {error.source} · {error.kind}
            {error.sessionId ? ` · ${error.sessionId}` : ''}
            {error.seenAt === null ? ' · unseen' : ''}
          </div>
          <div className="break-words text-[13px] text-text-bright">{error.message}</div>
        </div>
        {hasBody && (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? 'Hide detail' : 'Show detail'}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Copy error ${error.id}`}
          onClick={() => void copyToClipboard(formatRecordForCopy(error))}
        >
          Copy
        </Button>
      </div>
      {hasBody && expanded && (
        <div id={bodyId} className="mt-2">
          {error.context && (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-[rgba(160,190,225,.85)]">
              {JSON.stringify(error.context, null, 2)}
            </pre>
          )}
          {error.detail && (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-[rgba(160,190,225,.85)]">
              {error.detail}
            </pre>
          )}
        </div>
      )}
    </li>
  )
}

export interface ErrorLogProps {
  open: boolean
  onClose: () => void
}

/**
 * The shared error log, newest first
 * (`docs/superpowers/specs/2026-09-17-error-surface-design.md`).
 *
 * DELIBERATELY UNSTYLED beyond structure. The spec puts the visual design
 * out of scope and a canvas for it is coming; what this owes is correct
 * roles, labels and keyboard operation, which a later design pass can dress
 * without re-deriving. Do not "improve" the look of this file from the eye —
 * take it from the artboard when there is one (see `web/CLAUDE.md`).
 */
export function ErrorLog({ open, onClose }: ErrorLogProps) {
  const errors = useOrbital(useShallow((s) => s.errors))
  const markErrorsSeen = useOrbital((s) => s.markErrorsSeen)
  const clearErrorLog = useOrbital((s) => s.clearErrorLog)

  // "A list you opened is a list you were shown": every loaded row gets
  // stamped, not only the ones scrolled past. Keyed on the unseen ids rather
  // than on `open` alone so a record ARRIVING while the log is already open
  // is stamped too — the effect simply runs again with a new key.
  const unseenIds = errors.filter((error) => error.seenAt === null).map((error) => error.id)
  const unseenKey = unseenIds.join(',')
  useEffect(() => {
    if (!open || unseenKey === '') return
    void markErrorsSeen(unseenKey.split(',').map(Number))
    // `unseenKey` is the real dependency; `unseenIds` is a fresh array on
    // every render and would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, unseenKey, markErrorsSeen])

  return (
    <Dialog
      open={open}
      title="Errors"
      eyebrow="LOG"
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button
            variant="danger"
            size="lg"
            onClick={() => void clearErrorLog()}
            disabled={errors.length === 0}
          >
            Clear all
          </Button>
          <Button variant="ghost" size="lg" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {errors.length === 0 ? (
        <p className="text-[13px] text-[rgba(200,214,235,.85)]">No errors recorded.</p>
      ) : (
        <ul aria-label="Recorded errors" className="flex flex-col">
          {errors.map((error) => (
            <ErrorRow key={error.id} error={error} />
          ))}
        </ul>
      )}
    </Dialog>
  )
}
