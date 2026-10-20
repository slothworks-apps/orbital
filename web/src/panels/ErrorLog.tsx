import { useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import type { ErrorRecord } from '../lib/types'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Collapse } from '../ui/Collapse'
import { FADE_MS, HEIGHT_MS } from '../ui/motion'
import { useExitList } from '../ui/useExitList'
import { copyToClipboard } from '../lib/clipboard'
import { formatRecordForCopy, fromClaude } from '../lib/errorRecord'
import { isDemo } from '../lib/demo'
import { issueNumber } from './report/logic'
import { ReportDialog } from './report/ReportDialog'

/** 5b spells kinds out: `render_crash` reads as RENDER CRASH. */
function kindLabel(kind: string): string {
  return kind.replace(/_/g, ' ').toUpperCase()
}

/** Canvas 5b/5c's frame stops here; past it the list scrolls inside. */
const LOG_MAX_HEIGHT = 720

/**
 * The reported chip (canvas 61g REPORT CHIP → REPORTED): Copy's hairline pill,
 * with the issue's number in mono. It says the record was filed from this
 * Mac, nothing about the issue's state.
 */
function ReportedChip({ url }: { url: string }) {
  const n = issueNumber(url)
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={`Reported as issue #${n ?? ''} · opens on GitHub`}
      className="inline-flex items-center rounded-full border border-[rgba(150,205,255,.14)] px-2.5 py-1 font-mono text-[11px] text-[rgba(220,235,255,.85)] no-underline transition-colors hover:bg-[rgba(150,205,255,.08)] hover:text-text-bright"
    >
      #{n ?? ''} ↗
    </a>
  )
}

/**
 * One log row per canvas 5b/5c. Three ranks of ink carry the whole
 * distinction: a real error keeps a filled red dot, mono kind in warm ink and
 * body-ink message; an unseen row adds the one hairline-lit surface; a dev
 * record (stamped by `api.reportErrorToServer` in dev builds) drops to a
 * hollow dot, muted message and a dashed DEV chip — no red anywhere on it.
 */
function ErrorRow({ error, onReport }: { error: ErrorRecord; onReport: (error: ErrorRecord) => void }) {
  const [expanded, setExpanded] = useState(false)
  const bodyId = `error-detail-${error.id}`
  const hasBody = Boolean(error.detail) || Boolean(error.context)
  const isDev = error.context?.dev === true
  const unseen = error.seenAt === null
  // Canvas 61a/61g: Report only where the whole record has been read — an
  // expanded row, or one with nothing more to expand — and never on a dev
  // record, which comes from the user's own build. Nor on an error Claude
  // gave (an overloaded API, a usage limit), which Orbital cannot fix, nor in
  // the website's demo, where it would file a real issue.
  const reportable = !isDev && !isDemo() && !fromClaude(error) && (expanded || !hasBody)

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
      {reportable &&
        (error.issueUrl ? (
          <ReportedChip url={error.issueUrl} />
        ) : (
          <Button variant="pill" size="pill" aria-label={`Report error ${error.id}`} onClick={() => onReport(error)}>
            Report
          </Button>
        ))}
    </>
  )

  return (
    <div
      className={[
        'flex items-start gap-2.5 border-b border-[rgba(150,205,255,.07)] px-2.5 py-[13px]',
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
        {/* The detail opens and closes by its height, so the rows below glide.
            The 6px column gap rides inside the collapsing box. */}
        {hasBody && (
          <Collapse open={expanded} id={bodyId} className="-mt-1.5">
          <div className="flex flex-col gap-1.5 pt-1.5">
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
                instead of floating beside a now-tall column. While the block
                closes they stay drawn but out of reach — the live set is
                already back beside the row. */}
            <div className="flex items-center gap-1.5" aria-hidden={!expanded || undefined}>
              {actions}
            </div>
          </div>
          </Collapse>
        )}
      </div>
      {!expanded && (
        <div className={`flex flex-none items-center gap-1.5 ${hasBody ? 'orbital-arrive' : ''}`}>
          {actions}
        </div>
      )}
    </div>
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
  // A row that leaves (marked seen here or elsewhere) fades, then gives its
  // height back so the rows below glide up into the place.
  const rows = useExitList(errors, (error) => error.id, FADE_MS + HEIGHT_MS)
  // Rows on screen when the log opened are simply there; one that arrives
  // later opens its place and fades in.
  // Taken each time the log opens: it stays mounted while closed, and the rows
  // loaded at launch must not all grow in as if they had just arrived.
  const firstIds = useRef<Set<number> | null>(null)
  const wasOpen = useRef(false)
  const justOpened = open && !wasOpen.current
  if (justOpened) firstIds.current = new Set(errors.map((error) => error.id))
  wasOpen.current = open
  // The record being reported, kept through the review's close transition.
  const [reporting, setReporting] = useState<{ error: ErrorRecord; open: boolean } | null>(null)
  // Closing the log closes the review with it — fading, as the log does,
  // not gone in one frame; reopening the log starts clean.
  if (!open && reporting?.open) setReporting({ ...reporting, open: false })
  if (justOpened && reporting !== null) setReporting(null)

  // Deliberately NO marking on open. The log is an unread inbox over a
  // permanent table: the user reads, decides nothing here needs them, and
  // says so with the button — reading is not marking.
  const entryCount = `${errors.length} unread ${errors.length === 1 ? 'entry' : 'entries'}`

  return (
    <Dialog
      open={open}
      title="Errors"
      eyebrow="LOG"
      size="xl"
      maxHeight={LOG_MAX_HEIGHT}
      anchorTop
      onClose={onClose}
      headerMeta={errors.length > 0 ? entryCount : undefined}
      footerCaption="newest first · dev records included"
      footer={
        <>
          {/* Red belongs to the badge and the error dot alone (5b), so this
              is a plain outline, not a danger button. Marking is the user's
              explicit act and the only way rows leave the inbox — the server
              keeps them all in its table. Stamps the WHOLE table, not just
              the loaded page. */}
          <Button
            variant="ghost"
            size="lg"
            onClick={() => void markErrorsSeen('all')}
            disabled={errors.length === 0}
          >
            Mark all seen
          </Button>
          <Button variant="primary" size="lg" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {rows.length === 0 ? (
        <p className="orbital-arrive text-[13px] text-[rgba(200,214,235,.85)]">
          No unread errors.
        </p>
      ) : (
        <ul aria-label="Recorded errors" className="flex flex-col">
          {rows.map(({ item, key, leaving }) => (
            <Collapse key={key} as="li" open={!leaving} stagger appear={!firstIds.current?.has(key)} className="-mx-2.5">
              <ErrorRow error={item} onReport={(error) => setReporting({ error, open: true })} />
            </Collapse>
          ))}
        </ul>
      )}
      {/* Rendered inside the log, so it stacks over it and Escape peels it first. */}
      {reporting && (
        <ReportDialog
          open={reporting.open}
          kind="error"
          error={reporting.error}
          onClose={() => setReporting((r) => r && { ...r, open: false })}
        />
      )}
    </Dialog>
  )
}
