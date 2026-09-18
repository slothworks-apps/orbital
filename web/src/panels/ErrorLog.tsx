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

/** 5b spells kinds out: `render_crash` reads as RENDER CRASH. */
function kindLabel(kind: string): string {
  return kind.replace(/_/g, ' ').toUpperCase()
}

/**
 * One log row per canvas 5b/5c. Three ranks of ink carry the whole
 * distinction: a real error keeps a filled red dot, mono kind in warm ink and
 * body-ink message; an unseen row adds the one hairline-lit surface; a dev
 * record (stamped by `api.reportErrorToServer` in dev builds) drops to a
 * hollow dot, muted message and a dashed DEV chip — no red anywhere on it.
 */
function ErrorRow({ error }: { error: ErrorRecord }) {
  const [expanded, setExpanded] = useState(false)
  const bodyId = `error-detail-${error.id}`
  const hasBody = Boolean(error.detail) || Boolean(error.context)
  const isDev = error.context?.dev === true
  const unseen = error.seenAt === null

  // 5b: red is the badge's and the error dot's alone — oklch(60% .2 25),
  // precomputed to #de3b3d for Tailwind arbitrary values (see theme.css for
  // the convention). Kind ink is oklch(85% .1 25) → #ffb4ad.
  const separator = (
    <span aria-hidden className={isDev ? 'text-[rgba(150,205,255,.2)]' : 'text-[rgba(150,205,255,.28)]'}>
      ·
    </span>
  )

  const actions = (
    <>
      {hasBody && (
        <Button
          variant={expanded ? 'pill-active' : isDev ? 'pill-muted' : 'pill'}
          size="pill"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? 'Hide detail' : 'Show detail'}
        </Button>
      )}
      <Button
        variant={isDev ? 'pill-muted' : 'pill'}
        size="pill"
        aria-label={`Copy error ${error.id}`}
        onClick={() => void copyToClipboard(formatRecordForCopy(error))}
      >
        Copy
      </Button>
    </>
  )

  return (
    <li
      className={[
        '-mx-2.5 flex items-start gap-2.5 border-b border-[rgba(150,205,255,.07)] px-2.5 py-[13px]',
        unseen ? 'bg-[rgba(150,205,255,.05)]' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span
        aria-hidden
        className={[
          'mt-[5px] h-1.5 w-1.5 flex-none rounded-full',
          isDev
            ? 'box-border border border-[rgba(160,190,225,.5)]'
            : unseen
              ? 'bg-[#de3b3d] shadow-[0_0_10px_#de3b3d]'
              : 'bg-[#de3b3d] shadow-[0_0_8px_rgba(222,59,61,.7)]',
        ].join(' ')}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div
          className={[
            'flex flex-wrap items-center gap-2 font-mono text-[10px] tracking-[0.1em]',
            isDev ? 'text-[rgba(160,190,225,.55)]' : 'text-[rgba(160,190,225,.7)]',
          ].join(' ')}
        >
          {new Date(error.at).toLocaleString()}
          {separator}
          {error.source}
          {error.sessionId && (
            <>
              {separator}
              {error.sessionId}
            </>
          )}
          {separator}
          {isDev ? (
            kindLabel(error.kind)
          ) : (
            <span className="text-[#ffb4ad]">{kindLabel(error.kind)}</span>
          )}
          {isDev && (
            <span className="flex items-center rounded border border-dashed border-[rgba(160,190,225,.4)] px-1.5 py-px text-[9px] tracking-[0.14em] text-[rgba(160,190,225,.6)]">
              DEV
            </span>
          )}
          {unseen && (
            <>
              {separator}
              <span className="text-[rgba(200,220,245,.75)]">UNSEEN</span>
            </>
          )}
        </div>
        <div
          className={[
            'break-words leading-normal text-pretty',
            isDev ? 'text-[12.5px] text-[rgba(190,212,238,.7)]' : 'text-[13px] text-text-bright',
          ].join(' ')}
        >
          {error.message}
        </div>
        {hasBody && expanded && (
          <div id={bodyId} className="flex flex-col gap-1.5">
            {error.context && (
              <pre className="max-h-[150px] overflow-auto whitespace-pre-wrap break-words rounded-[7px] border border-[rgba(150,205,255,.12)] bg-[rgba(4,8,16,.55)] px-3 py-2.5 font-mono text-[10.5px] leading-[1.6] text-[rgba(190,212,238,.8)]">
                {JSON.stringify(error.context, null, 2)}
              </pre>
            )}
            {error.detail && (
              <pre className="max-h-[150px] overflow-auto whitespace-pre-wrap break-words rounded-[7px] border border-[rgba(150,205,255,.12)] bg-[rgba(4,8,16,.55)] px-3 py-2.5 font-mono text-[10.5px] leading-[1.6] text-[rgba(190,212,238,.8)]">
                {error.detail}
              </pre>
            )}
            {/* Expanded, the actions follow the detail block (5b's open row)
                instead of floating beside a now-tall column. */}
            <div className="flex items-center gap-1.5">{actions}</div>
          </div>
        )}
      </div>
      {!expanded && <div className="flex flex-none items-center gap-1.5">{actions}</div>}
    </li>
  )
}

export interface ErrorLogProps {
  open: boolean
  onClose: () => void
}

/**
 * The shared error log, newest first — styled per canvas 5b
 * (`Feature - Error log.dc.html`; behaviour spec:
 * `docs/superpowers/specs/2026-09-17-error-surface-design.md`).
 */
export function ErrorLog({ open, onClose }: ErrorLogProps) {
  const errors = useOrbital(useShallow((s) => s.errors))
  const markErrorsSeen = useOrbital((s) => s.markErrorsSeen)
  const clearErrorLog = useOrbital((s) => s.clearErrorLog)

  // The rows THIS opening has stamped — the header's "N unseen cleared" (5b).
  // Grows while open (rows can arrive live) and resets on close. A Set, not a
  // counter, so StrictMode's dev-only double-invoked effect cannot count the
  // same ids twice.
  const [clearedIds, setClearedIds] = useState<ReadonlySet<number>>(new Set())
  useEffect(() => {
    if (!open) setClearedIds(new Set())
  }, [open])

  // "A list you opened is a list you were shown": every loaded row gets
  // stamped, not only the ones scrolled past. Keyed on the unseen ids rather
  // than on `open` alone so a record ARRIVING while the log is already open
  // is stamped too — the effect simply runs again with a new key.
  const unseenIds = errors.filter((error) => error.seenAt === null).map((error) => error.id)
  const unseenKey = unseenIds.join(',')
  useEffect(() => {
    if (!open || unseenKey === '') return
    const ids = unseenKey.split(',').map(Number)
    setClearedIds((prev) => new Set([...prev, ...ids]))
    void markErrorsSeen(ids)
    // `unseenKey` is the real dependency; `unseenIds` is a fresh array on
    // every render and would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, unseenKey, markErrorsSeen])

  const clearedOnOpen = clearedIds.size
  const entryCount = `${errors.length} ${errors.length === 1 ? 'entry' : 'entries'}`

  return (
    <Dialog
      open={open}
      title="Errors"
      eyebrow="LOG"
      size="xl"
      onClose={onClose}
      headerMeta={
        errors.length > 0
          ? clearedOnOpen > 0
            ? `${entryCount} · ${clearedOnOpen} unseen cleared`
            : entryCount
          : undefined
      }
      footerCaption="newest first · dev records included"
      footer={
        <>
          {/* Red belongs to the badge and the error dot alone (5b), so Clear
              all is a plain outline, not a danger button. */}
          <Button
            variant="ghost"
            size="lg"
            onClick={() => void clearErrorLog()}
            disabled={errors.length === 0}
          >
            Clear all
          </Button>
          <Button variant="primary" size="lg" onClick={onClose}>
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
