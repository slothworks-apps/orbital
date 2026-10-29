import { swatch } from '../lib/palette'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { EscapeBoundary, useEscapeLayer } from '../ui/escapeLayer'
import { usePresence } from '../ui/usePresence'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { command, matches } from '../lib/keymap'
import { formatBytes, timeAgo } from '../lib/format'
import { languageFromPath } from '../lib/highlight'
import { useTokens } from '../lib/useTokens'
import type {
  ApiSession,
  FilePreview,
  IdeDiagnostic,
  IdeDiagnosticSeverity,
} from '../lib/types'
import { workingDirOf } from '../lib/types'
import { ideHere } from '../lib/devices'
import { Code, Pre } from './MessageView'
import { IDE_MODIFIER_LABEL } from './PathButton'

/**
 * The read-only file viewer over the app (spec: 2026-09-19-file-viewer-design
 * § The viewer; canvas 8b/8c/8d/8e). Built on the Lightbox's infra —
 * `useEscapeLayer` + `usePresence` + `createPortal` — deliberately NOT
 * `Dialog`, for the same reason the Lightbox isn't: this is a bare surface,
 * not form-dialog chrome. Reading, never editing; content is a snapshot of
 * the moment it opened — no watch, no reload, no diff.
 */

/** Canvas 8e "loading threshold": most local reads finish first, and
 * flashing a skeleton for 40ms is worse than none. */
export const LOADING_SKELETON_DELAY_MS = 120
/** The degrade tier's ceilings (spec § Deviations): over either, the body
 * is one plain escaped <pre> — numbers and line targets are what make big
 * files expensive, not the bytes. The file still opens. */
export const HIGHLIGHT_MAX_BYTES = 1024 * 1024
export const HIGHLIGHT_MAX_LINES = 20_000
/** Mirrors the server's `FILE_PREVIEW_MAX_BYTES` — only the refusal copy
 * needs it ("<measured> over the <ceiling> ceiling", 8d-C). */
const FILE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024

/** 8e transitions: surface .18s cubic-bezier(.2,.9,.25,1) 98%→100%, no
 * slide; close is the same reversed (slightly shorter, like the Lightbox). */
export const VIEWER_ENTER_MS = 180
export const VIEWER_EXIT_MS = 140

/** Target-line accent (canvas 8e "target number"): oklch(88% .1 205). */
const TARGET_ACCENT = 'oklch(88% .1 205)'

/**
 * The shortcut drawn beside the header's "open in <editor>" link (canvas 20d
 * panel 2). It is the teaching device: seeing ⌥ next to the one worded link
 * is what tells someone that ⌥ over any path means the same thing.
 */
const IDE_VIEWER_SHORTCUT_LABEL = `${IDE_MODIFIER_LABEL}⏎`

/**
 * The editor's findings, marked on the gutter number (spec
 * 2026-09-23-ide-bridge-design § Talking back to the editor).
 *
 * `--color-warning` is the export's amber caution hue and the red is the
 * error ink the toast surface already uses; neither is a new value. There is
 * no artboard for this — it has no canvas of its own, and the two severities
 * worth marking borrow the two the app already has.
 */
const DIAGNOSTIC_INK: Record<IdeDiagnosticSeverity, string> = {
  error: '#ff9b9b',
  warning: 'var(--color-warning)',
  info: swatch('ink-900', 0.7),
  hint: swatch('ink-900', 0.7),
}

/** Worst first — what the gutter number takes its colour from. */
const SEVERITY_ORDER: IdeDiagnosticSeverity[] = ['error', 'warning', 'info', 'hint']

function worstSeverity(found: IdeDiagnostic[]): IdeDiagnosticSeverity {
  for (const severity of SEVERITY_ORDER) {
    if (found.some((d) => d.severity === severity)) return severity
  }
  return 'info'
}

/** One finding as a line of the gutter number's hover text. */
function describeDiagnostic(d: IdeDiagnostic): string {
  return d.source ? `${d.severity}: ${d.message} (${d.source})` : `${d.severity}: ${d.message}`
}

/** "2 errors · 1 warning", or null when the editor found nothing to say. */
function diagnosticsSummary(found: IdeDiagnostic[]): string | null {
  const counts = new Map<IdeDiagnosticSeverity, number>()
  for (const d of found) counts.set(d.severity, (counts.get(d.severity) ?? 0) + 1)
  const parts = SEVERITY_ORDER.filter((s) => counts.has(s)).map((s) => {
    const n = counts.get(s) as number
    return `${n} ${s}${n === 1 ? '' : 's'}`
  })
  return parts.length === 0 ? null : parts.join(' · ')
}

/** "modified 2m ago" from the file's mtime. `timeAgo` already covers the
 * shapes: "now" (→ just now), a relative count, or a short date for old
 * files (which reads without the "ago"). */
function modifiedLabel(mtimeMs: number): string {
  const t = timeAgo(mtimeMs)
  if (t === 'now') return 'modified just now'
  return /^\d/.test(t) ? `modified ${t} ago` : `modified ${t}`
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/** 8d-A: four bars at the line rhythm, .07 fill, 1.4s sweep staggered 100ms. */
function SkeletonBody() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 px-[18px] py-4">
      {[62, 88, 74, 40].map((width, index) => (
        <div
          key={width}
          data-skeleton
          className="relative h-[11px] overflow-hidden rounded-[3px] bg-line/7"
          style={{ width: `${width}%` }}
        >
          <div
            className="absolute inset-0 bg-[linear-gradient(90deg,transparent,color-mix(in_oklab,_var(--color-line)_10%,_transparent),transparent)]"
            style={{ animation: `orbital-sweep 1.4s ease-in-out ${index * 0.1}s infinite` }}
          />
        </div>
      ))}
    </div>
  )
}

/**
 * 8d B–D: the four refusals share one frame — centred 16px outline glyph,
 * 10px tracked mono label, one 11px sentence, 10px gaps, neutral ink. No
 * red, no retry: a refusal is the viewer having nothing to show, not the
 * app going wrong.
 */
export function RefusalBody({ label, sentence }: { label: string; sentence: React.ReactNode | null }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[10px] px-10 text-center">
      <span aria-hidden className="h-4 w-4 rounded-[4px] border border-ink-900/35" />
      <span className="font-mono fs-10 tracking-[0.14em] text-ink-900/55">
        {label}
      </span>
      {sentence && (
        <span className="font-mono fs-11 leading-[1.7] text-ink-900/70 [text-wrap:pretty]">
          {sentence}
        </span>
      )}
    </div>
  )
}

/** 8b: the transcript's markdown pipeline at reading size — 660px measure
 * centred, 15/1.75 body, 26px/700 h1, 18px block gap, 34px top inset. */
export function MarkdownBody({ content }: { content: string }) {
  return (
    <div data-selectable className="min-h-0 flex-1 overflow-y-auto pb-10 pt-[34px]">
      <div
        className={[
          'mx-auto flex max-w-[660px] flex-col gap-[18px] px-6',
          'fs-15 leading-[1.75] text-ink-100/90 [text-wrap:pretty]',
          '[&_p]:m-0',
          '[&_h1]:fs-26 [&_h1]:font-bold [&_h1]:leading-[1.25] [&_h1]:tracking-[-.015em]',
          '[&_h2]:fs-16 [&_h2]:font-bold [&_h2]:tracking-[-.01em]',
          '[&_ul]:m-0 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:m-0 [&_ol]:list-decimal [&_ol]:pl-5',
          '[&_blockquote]:m-0 [&_blockquote]:border-l-2 [&_blockquote]:border-line/30 [&_blockquote]:bg-line/4 [&_blockquote]:px-4 [&_blockquote]:py-3.5',
        ].join(' ')}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: Code, pre: Pre }}>
          {content}
        </ReactMarkdown>
      </div>
    </div>
  )
}

/**
 * 8c: shiki per-line tokens rendered as rows — 56px gutter well with
 * right-aligned 11.5px numbers in .32 ink, 18px left inset, 12.5px/22px
 * body. Plain rows render synchronously; tokens swap in when shiki lands
 * (same posture as the transcript's CodeBlock). The target line wears the
 * wash + inset rail + accent number the whole time the file is open, and
 * is placed by scroll at ⅓ of the body height — no flash, no pulse (8e).
 */
function SourceBody({
  content,
  path,
  targetLine,
  diagnostics,
}: {
  content: string
  path: string
  targetLine: number | null
  diagnostics: Map<number, IdeDiagnostic[]>
}) {
  const lines = useMemo(() => content.replace(/\n$/, '').split('\n'), [content])
  // A token line count that disagrees with ours would misalign the gutter —
  // `useTokens` drops it, and the rows stay plain rather than shift every number.
  const tokens = useTokens(content.replace(/\n$/, ''), languageFromPath(path).lang, lines.length)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const targetRowRef = useRef<HTMLDivElement | null>(null)

  // Placed by scroll, not animation (8e "target line"). Layout effect so
  // the first paint already sits on the target — no flash of the top.
  useLayoutEffect(() => {
    const container = containerRef.current
    const row = targetRowRef.current
    if (!container || !row) return
    container.scrollTop = Math.max(0, row.offsetTop - container.clientHeight / 3)
  }, [lines])

  return (
    <div
      ref={containerRef}
      data-selectable
      className="relative h-fit min-h-0 flex-1 overflow-auto font-mono fs-12.5 leading-[calc(22px*var(--text-scale,1))]"
    >
      <div className="relative min-h-full w-fit min-w-full py-3.5">
        {/* The gutter well (8c): 56px, rgba(4,8,16,.4), hairline right edge. */}
        <div
          aria-hidden
          className="absolute inset-y-0 left-0 w-14 border-r border-line/8 bg-shade/40"
        />
        <div className="relative">
          {lines.map((text, index) => {
            const lineNumber = index + 1
            const isTarget = lineNumber === targetLine
            // The editor's own findings on this line, when an editor is
            // there to have any. They mark the NUMBER rather than the row:
            // the target line already owns the row's wash and rail, and two
            // meanings on one surface is how both stop being readable.
            const found = diagnostics.get(lineNumber)
            const severity = found ? worstSeverity(found) : null
            return (
              <div
                key={lineNumber}
                data-line={lineNumber}
                data-target-line={isTarget || undefined}
                data-diagnostic={severity ?? undefined}
                ref={isTarget ? targetRowRef : undefined}
                className="flex"
                style={
                  isTarget
                    ? // 8e: wash rgba(150,205,255,.07) + inset 2px accent rail.
                      {
                        background: swatch('line', 0.07),
                        boxShadow: `inset 2px 0 0 ${TARGET_ACCENT}`,
                      }
                    : undefined
                }
              >
                {/* The number is drawn by ::before, so a selection dragged
                    across rows copies the code alone, without the gutter. */}
                <span
                  data-number={lineNumber}
                  className="w-14 shrink-0 pr-3 text-right fs-11.5 text-ink-900/32 before:content-[attr(data-number)]"
                  style={
                    isTarget
                      ? { color: TARGET_ACCENT }
                      : severity
                        ? { color: DIAGNOSTIC_INK[severity] }
                        : undefined
                  }
                  title={found ? found.map(describeDiagnostic).join('\n') : undefined}
                />
                <span className="whitespace-pre pl-[18px] pr-5 text-ink-400/90">
                  {tokens
                    ? tokens[index].map((token, tokenIndex) => (
                        // A static token list: the index is a stable key.
                        <span key={tokenIndex} style={token.color ? { color: token.color } : undefined}>
                          {token.content}
                        </span>
                      ))
                    : text}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The viewer
// ---------------------------------------------------------------------------

export interface FileViewerProps {
  /** The selected session — the viewer always belongs to it: its id scopes
   * the read and its cwd/title feed the refusal copy and the footer. */
  session: ApiSession
}

export function FileViewer({ session }: FileViewerProps) {
  const target = useOrbital((s) => s.ui.fileViewer)
  const closeFile = useOrbital((s) => s.closeFile)
  const read = useCallback(
    (path: string, cwd?: string) => api.filePreview(session.id, path, cwd),
    [session.id],
  )
  return (
    <FileViewerSurface
      target={target}
      onClose={closeFile}
      read={read}
      ideSessionId={session.id}
      ideName={ideHere(session)?.ideName ?? null}
      outside={(cwd) => (
        <>
          Orbital reads inside{' '}
          <span className="text-ink-200/85">{cwd ?? workingDirOf(session)}</span> and files this
          session named.
        </>
      )}
      openedFrom={session.title || 'session'}
    />
  )
}

export interface ProjectFileViewerProps {
  /** The project the New session dialog is about to launch in. */
  cwd: string
  /** The undecided `.mcp.json` server whose file is shown, or null while closed. */
  server: { name: string; file: string } | null
  onClose: () => void
  /** The member the session would run on; absent, this device. */
  machine?: string
}

/**
 * The same viewer over the one project file a `.mcp.json` server runs, for
 * the New session question's *View file* (spec
 * 2026-10-08-mcpjson-approval-design § Clients; canvas `Feature - MCP
 * approval` 2d). There is no session yet, so it is opened by its caller
 * rather than through `ui.fileViewer`, which belongs to the selected
 * session, and it has no editor to talk to.
 */
export function ProjectFileViewer({ cwd, server, onClose, machine }: ProjectFileViewerProps) {
  const name = server?.name ?? null
  // Only called while open, so `name` is set.
  const read = useCallback(() => api.mcpjsonFile(cwd, name ?? '', machine), [cwd, name, machine])
  return (
    <FileViewerSurface
      target={server ? { path: server.file, line: null } : null}
      onClose={onClose}
      read={read}
      ideSessionId={null}
      ideName={null}
      outside={() => (
        <>
          Orbital reads inside <span className="text-ink-200/85">{cwd}</span>.
        </>
      )}
      openedFrom="New session"
    />
  )
}

interface FileViewerSurfaceProps {
  target: { path: string; line: number | null; cwd?: string } | null
  onClose: () => void
  /** The snapshot read; a new function is a new read. */
  read: (path: string, cwd?: string) => Promise<FilePreview>
  /** The session whose editor is asked, or null where there is none. */
  ideSessionId: string | null
  ideName: string | null
  /** The OUTSIDE refusal's sentence, given the cwd the target was read against. */
  outside: (cwd: string | undefined) => ReactNode
  /** The footer's `opened from …`. */
  openedFrom: string
}

function FileViewerSurface({ target, onClose, read, ideSessionId, ideName: ideNameProp, outside, openedFrom }: FileViewerSurfaceProps) {
  const closeFile = onClose
  const openInIde = useOrbital((s) => s.openInIde)
  const open = target !== null

  useEscapeLayer(open, closeFile)
  const { mounted, state } = usePresence(open, VIEWER_ENTER_MS, VIEWER_EXIT_MS)

  // Keep rendering the outgoing target while the surface animates out —
  // same pattern as DetailPanel holding its last session.
  const lastTarget = useRef(target)
  if (target) lastTarget.current = target
  const shown = target ?? lastTarget.current

  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [skeleton, setSkeleton] = useState(false)
  const [openedAt, setOpenedAt] = useState('')
  const openerRef = useRef<HTMLElement | null>(null)

  const openPath = target?.path ?? null
  const openCwd = target?.cwd

  // The snapshot read. Refusals are viewer states delivered as values;
  // only a network-level failure lands in the error surface — and with
  // nothing to show, the viewer closes rather than sitting on a skeleton.
  useEffect(() => {
    if (openPath === null) return
    let cancelled = false
    setPreview(null)
    read(openPath, openCwd)
      .then((result) => {
        if (!cancelled) setPreview(result)
      })
      .catch((err) => {
        if (cancelled) return
        reportError(err, 'Failed to read the file')
        closeFile()
      })
    return () => {
      cancelled = true
    }
    // `closeFile` is the caller's and may be a fresh closure each render; the
    // read is keyed by what is read, not by who closes it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read, openPath, openCwd])

  // What the editor thinks is wrong with this file — inspections no test run
  // reports, which is the whole reason they are worth asking for (spec
  // 2026-09-23-ide-bridge-design § Talking back to the editor).
  //
  // Asked for once, at open, alongside the snapshot the viewer already is:
  // the file's bytes do not reload either, so a readout that kept refreshing
  // would be describing a file the reader is no longer looking at.
  //
  // `ideName` rather than the whole `ide` object in the dependency list: the
  // session republishes on every selection change, and re-fetching a file's
  // diagnostics because a caret moved is a call per keystroke.
  const ideName = ideSessionId === null ? null : ideNameProp
  const [diagnostics, setDiagnostics] = useState<IdeDiagnostic[] | null>(null)
  useEffect(() => {
    setDiagnostics(null)
    if (openPath === null || ideName === null || ideSessionId === null) return
    let cancelled = false
    void api.ideDiagnostics(ideSessionId, openPath).then((found) => {
      if (!cancelled) setDiagnostics(found)
    })
    return () => {
      cancelled = true
    }
  }, [ideSessionId, openPath, ideName])

  const byLine = useMemo(() => {
    const map = new Map<number, IdeDiagnostic[]>()
    for (const d of diagnostics ?? []) {
      // The editor answers for a file it may know by a different spelling
      // than the one the viewer was opened on; only findings about THIS file
      // may mark this file's gutter.
      if (openPath !== null && d.filePath !== openPath) continue
      const at = map.get(d.line)
      if (at) at.push(d)
      else map.set(d.line, [d])
    }
    return map
  }, [diagnostics, openPath])

  // Focus returns to the path that opened the viewer (8e "focus return"):
  // captured at open, restored by the effect's cleanup at close.
  useEffect(() => {
    if (!open) return
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setOpenedAt(
      new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    )
    return () => {
      openerRef.current?.focus()
      openerRef.current = null
    }
  }, [open])

  // ⌥⏎ — the shortcut the header's link advertises (canvas 20d panel 2).
  // Wired here rather than on the link so the keystroke works wherever focus
  // sits inside the viewer, which is what an advertised shortcut has to do;
  // esc is left alone, since the escape stack already owns it.
  useEffect(() => {
    if (!open || ideName === null || openPath === null) return
    const onKey = (event: KeyboardEvent) => {
      if (!matches(command('files.open-in-ide').chords[0], event)) return
      event.preventDefault()
      void openInIde(openPath, target?.line ?? null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, ideName, openPath, target?.line, openInIde])

  // The skeleton appears only after LOADING_SKELETON_DELAY_MS (8d-A).
  const loading = open && preview === null
  useEffect(() => {
    if (!loading) {
      setSkeleton(false)
      return
    }
    const timer = setTimeout(() => setSkeleton(true), LOADING_SKELETON_DELAY_MS)
    return () => clearTimeout(timer)
  }, [loading])

  if (!mounted || !shown) return null

  const entered = state === 'entered'
  const path = shown.path
  const line = shown.line
  const lastSlash = path.lastIndexOf('/')
  const directory = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : ''
  const basename = path.slice(lastSlash + 1)
  const isMarkdown = /\.(md|markdown)$/i.test(path)
  const degraded =
    preview?.kind === 'ok' &&
    (preview.size > HIGHLIGHT_MAX_BYTES || preview.lines > HIGHLIGHT_MAX_LINES)

  const meta =
    preview === null
      ? 'reading…'
      : preview.kind === 'ok'
        ? [
            formatBytes(preview.size),
            `${preview.lines} lines`,
            modifiedLabel(preview.mtimeMs),
            languageFromPath(path).label || null,
            line !== null ? `line ${line} of ${preview.lines}` : null,
            // What the editor found, beside what the file is. Absent when
            // there is no editor, and absent when it found nothing — a
            // clean file says nothing rather than saying "0 errors".
            diagnostics ? diagnosticsSummary(diagnostics) : null,
          ]
            .filter(Boolean)
            .join(' · ')
        : preview.kind === 'too_large' || preview.kind === 'binary'
          ? `${formatBytes(preview.size)} · not read`
          : 'not read'

  return createPortal(
    <EscapeBoundary>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`File ${path}`}
        data-text-scope="transcript"
        data-state={state}
        inert={state === 'exiting' || undefined}
        onClick={closeFile}
        // 8e transitions: backdrop .14s; rgba(2,4,9,.82) + blur 6.
        style={{ transition: 'opacity 140ms ease', opacity: entered ? 1 : 0 }}
        className="orbital-no-drag fixed inset-0 z-50 grid place-items-center bg-space/82 p-6 backdrop-blur-[6px]"
      >
        <div
          onClick={(event) => event.stopPropagation()}
          style={{
            // 8e: markdown 980×760, source 1040×780, both capped
            // min(86vw, 1100px) × 86vh. The mode is known from the path, so
            // the surface never resizes when the bytes land.
            width: isMarkdown ? 980 : 1040,
            height: isMarkdown ? 760 : 780,
            maxWidth: 'min(86vw, 1100px)',
            maxHeight: '86vh',
            transition: 'transform 180ms cubic-bezier(.2,.9,.25,1)',
            transform: entered ? 'scale(1)' : 'scale(.98)',
          }}
          className="flex flex-col overflow-hidden rounded-[14px] border border-line/22 bg-[linear-gradient(180deg,color-mix(in_oklab,_var(--color-panel-solid)_96%,_transparent),color-mix(in_oklab,_var(--color-space-deep)_98%,_transparent))] shadow-[0_40px_120px_rgba(0,0,0,.7)]"
        >
          {/* Header (8b/8c): real from the first frame — the path is known
              client-side, so nothing moves when the read finishes. Pad
              16 18 14 over a hairline rule. */}
          <div className="flex items-start gap-3 border-b border-line/10 px-[18px] pb-3.5 pt-4">
            <div className="flex min-w-0 flex-1 flex-col gap-[7px]">
              <div className="flex min-w-0 items-center gap-2 font-mono fs-14 text-ink-900/60">
                <span className="min-w-0 truncate">
                  {directory && <span>{directory}</span>}
                  <span className="text-ink-50">{basename}</span>
                </span>
                {line !== null && (
                  // The :line chip (8c): accent .12 fill, .4 border.
                  <span className="shrink-0 rounded-[5px] border border-accent/40 bg-accent/12 px-[7px] py-[2px] fs-12 text-[oklch(88%_.1_205)]">
                    :{line}
                  </span>
                )}
              </div>
              <div className="truncate font-mono fs-10.5 tracking-[0.06em] text-ink-900/55">
                {meta}
              </div>
            </div>
            {/* The one place the modifier gesture is taught (spec
                2026-09-23-ide-bridge-design § Talking back to the editor;
                canvas `Feature - IDE bridge.dc.html` 20d panel 2). A text
                link with the shortcut beside it, "the same shape as the rest
                of that header, no button" — the shortcut is what teaches the
                gesture, so someone who uses this twice starts ⌥-clicking the
                path directly and never comes back here.

                20d: link swatch('ink-900', 0.6) under a dashed
                swatch('line', 0.25), tracking .04em against the row's own
                .1em; the shortcut behind it at `.4`. Absent with no editor,
                which is also how the gesture says it is unavailable. */}
            {ideName && (
              <button
                type="button"
                data-ide-open-link
                onClick={() => void openInIde(path, line)}
                className="shrink-0 font-mono fs-10.5 tracking-[0.04em] text-ink-900/60 underline decoration-dashed decoration-line/25 underline-offset-[3px] transition-colors hover:text-ink-50"
              >
                open in {ideName}
                <span className="pl-2 tracking-[0.04em] text-ink-900/40 no-underline">
                  {IDE_VIEWER_SHORTCUT_LABEL}
                </span>
              </button>
            )}
            <button
              type="button"
              aria-label="Close"
              onClick={closeFile}
              className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[8px] border border-line/20 bg-panel/70 fs-15 text-ink-100 transition-colors hover:border-line/45"
            >
              ×
            </button>
          </div>

          {/* Body — one of: skeleton (after the delay), refusal frame,
              degraded plain <pre>, markdown at reading size, source rows. */}
          {preview === null ? (
            skeleton ? (
              <SkeletonBody />
            ) : (
              <div className="min-h-0 flex-1" />
            )
          ) : preview.kind === 'outside' ? (
            <RefusalBody
              label="OUTSIDE SESSION FOLDER"
              sentence={outside(shown.cwd)}
            />
          ) : preview.kind === 'not_found' ? (
            // The canvas adds "The agent read it at 14:02." — that needs the
            // opening row's timestamp, which prose-opened paths don't have,
            // so the sentence is omitted (spec § Deviations).
            <RefusalBody label="NO LONGER ON DISK" sentence={null} />
          ) : preview.kind === 'too_large' ? (
            <RefusalBody
              label="TOO LARGE TO PREVIEW"
              sentence={
                <>
                  <span className="text-ink-200/85">{formatBytes(preview.size)}</span>{' '}
                  over the{' '}
                  <span className="text-ink-200/85">
                    {formatBytes(FILE_PREVIEW_MAX_BYTES)}
                  </span>{' '}
                  ceiling.
                </>
              }
            />
          ) : preview.kind === 'binary' ? (
            <RefusalBody
              label="BINARY FILE"
              sentence={
                <>
                  <span className="text-ink-200/85">{preview.mediaType}</span> —
                  nothing to read as text.
                </>
              }
            />
          ) : degraded ? (
            // The degrade tier: one plain escaped <pre> — no shiki, no
            // ReactMarkdown, no per-line rows. The file still opens.
            <pre
              data-degraded
              data-selectable
              className="h-fit min-h-0 flex-1 overflow-auto whitespace-pre px-[18px] py-3.5 font-mono fs-12.5 leading-[calc(22px*var(--text-scale,1))] text-ink-400/90"
            >
              {preview.content}
            </pre>
          ) : isMarkdown ? (
            <MarkdownBody content={preview.content} />
          ) : (
            <SourceBody
              content={preview.content}
              path={path}
              targetLine={line}
              diagnostics={byLine}
            />
          )}

          {/* Footer (8b/8c): pad 10 18. The spec's `opened from <source>`
              names the pressed site (tool name / prose); the store's
              fileViewer deliberately carries only {path, line, cwd}, so the
              footer names the session and the opening time — judgement
              call, marked. */}
          <div className="flex items-center gap-2.5 border-t border-line/10 px-[18px] py-2.5 font-mono fs-10 tracking-[0.08em] text-ink-900/55">
            <span className="rounded-[4px] border border-line/20 px-1.5 py-[2px] text-ink-500/70">
              esc
            </span>
            closes · read-only snapshot
            <span aria-hidden className="flex-1" />
            <span className="truncate">
              opened from {openedFrom}
              {openedAt ? ` · ${openedAt}` : ''}
            </span>
          </div>
        </div>
      </div>
    </EscapeBoundary>,
    document.body
  )
}
