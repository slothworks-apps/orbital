import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { copyToClipboard } from '../../lib/clipboard'
import { formatBytes } from '../../lib/format'
import { languageFromPath } from '../../lib/highlight'
import { PHONE_HIGHLIGHT_MAX_LINES, PHONE_TEXT_PREVIEW_MAX_BYTES } from '../constants'
import { asOfLabel, basename } from '../format'
import { useMobile } from '../state'
import { useSessionDeviceName } from '../useDevice'
import { CantShow } from './CantShow'
import { ByteBar, GoneBlock, StateButton, StateText } from './FileStates'
import type { MarkdownLink } from './markdownLinks'
import { PhoneMarkdown } from './PhoneMarkdown'
import { useFile } from './useFile'
import { useTokens } from '../../lib/useTokens'

/** The lines of a text file as the preview numbers them: a final newline opens no empty last line. */
export function previewLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function dirOf(path: string): string {
  const cut = path.replace(/\/+$/, '').lastIndexOf('/')
  return cut > 0 ? path.slice(0, cut) : cut === 0 ? '/' : ''
}

type Mode = 'rendered' | 'source'

/** Where the next layout puts the scroll: a source row (⅓ down for a target, else at the top), or a rendered block. */
type Place = { to: 'row'; line: number; third: boolean } | { to: 'block'; line: number }

// Canvas 8e, the target line: wash, inset rail and number, as the desktop draws them.
const TARGET_RAIL = 'oklch(85% .12 205)'
const TARGET_NUMBER = 'oklch(88% .1 205)'

/** The first source line on screen in Rendered: the last block whose top has reached the top edge. */
function renderedLineAtTop(scroller: HTMLElement): number {
  const top = scroller.getBoundingClientRect().top + 1
  let line = 1
  for (const el of scroller.querySelectorAll<HTMLElement>('[data-src-line]')) {
    if (el.getBoundingClientRect().top <= top) line = Number(el.dataset.srcLine)
  }
  return line
}

/** The first source row still on screen in Source. */
function sourceLineAtTop(scroller: HTMLElement): number {
  const top = scroller.getBoundingClientRect().top
  for (const row of scroller.querySelectorAll<HTMLElement>('[data-line]')) {
    if (row.getBoundingClientRect().bottom > top) return Number(row.dataset.line)
  }
  return 1
}

/** False when the row is not there yet (a shorter cached copy), so the next version of the file tries again. */
function place(scroller: HTMLElement, where: Place): boolean {
  const top = scroller.getBoundingClientRect().top
  if (where.to === 'row') {
    const row = scroller.querySelector<HTMLElement>(`[data-line="${where.line}"]`)
    if (!row) return false
    const offset = row.getBoundingClientRect().top - top + scroller.scrollTop
    scroller.scrollTop = Math.max(0, offset - (where.third ? scroller.clientHeight / 3 : 0))
    return true
  }
  // The block that starts at or before the line; of equals, the innermost (it comes later).
  let block: HTMLElement | null = null
  for (const el of scroller.querySelectorAll<HTMLElement>('[data-src-line]')) {
    if (Number(el.dataset.srcLine) <= where.line) block = el
  }
  scroller.scrollTop = block && where.line > 1 ? block.getBoundingClientRect().top - top + scroller.scrollTop - 12 : 0
  return true
}

/**
 * Canvas 10d, third phone — a text file the transcript named, read-only
 * (spec 2026-10-05-mobile-next § 2): line numbers, scrolled to the `:line`
 * the mention carried, Wrap on or off, Copy path. Editing stays on the Mac.
 * Source is coloured and a markdown file opens as a document, with a switch
 * to its source (`Feature - Phone text preview` 10d·a–e, spec
 * 2026-10-23-phone-text-preview).
 */
export function TextPreview({
  sessionId, cwd, path, line, onBack,
}: {
  sessionId: string
  /** The `cwd` the naming message was written in; the path is read against it. */
  cwd?: string
  path: string
  line: number | null
  onBack: () => void
}) {
  const source = useMemo(() => ({ kind: 'path' as const, sessionId, path, as: 'text' as const, cwd }), [sessionId, path, cwd])
  const { view, retry } = useFile(source)
  const mac = useSessionDeviceName(sessionId) ?? 'the Mac'
  const lang = languageFromPath(path).lang
  const isMarkdown = lang === 'markdown'
  // 10d·e: an .md without a line opens Rendered; a `:line` opens Source. Not remembered.
  const [mode, setMode] = useState<Mode>(isMarkdown && line === null ? 'rendered' : 'source')
  const [target, setTarget] = useState(line)
  // Kept per file while the preview is open, across trips to Rendered and back.
  const [wrap, setWrap] = useState(true)
  const scroller = useRef<HTMLDivElement>(null)
  const pending = useRef<Place | null>(line !== null ? { to: 'row', line, third: true } : null)
  const [placing, setPlacing] = useState(0)

  const outcome = view.phase === 'done' ? view.outcome : null
  const shown = outcome?.kind === 'ready' ? outcome : outcome?.kind === 'gone' ? outcome.copy : null
  const text = useMemo(() => (shown ? new TextDecoder().decode(shown.bytes) : null), [shown])
  const lines = useMemo(() => (text !== null ? previewLines(text) : null), [text])
  const rendered = isMarkdown && mode === 'rendered'
  // Rendered shows no rows, so a markdown file is coloured only once its source is opened.
  const highlighted = lines !== null && !rendered && lines.length <= PHONE_HIGHLIGHT_MAX_LINES
  const tokens = useTokens(highlighted ? lines.join('\n') : '', highlighted ? lang : '', lines?.length ?? 0)

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !lines || !pending.current) return
    if (place(el, pending.current)) pending.current = null
  }, [lines, mode, placing])

  const switchTo = (next: Mode) => {
    const el = scroller.current
    if (next === mode) return
    if (el && lines) {
      pending.current =
        next === 'source'
          ? { to: 'row', line: renderedLineAtTop(el), third: false }
          : { to: 'block', line: sourceLineAtTop(el) }
    }
    setMode(next)
  }

  const onLink = useCallback(
    (link: MarkdownLink) => {
      if (link.kind === 'web') window.open(link.url, '_blank', 'noopener')
      else if (link.kind === 'same') {
        setTarget(link.line)
        pending.current = { to: 'row', line: link.line, third: true }
        setMode('source')
        setPlacing((n) => n + 1)
      } else if (link.kind === 'file') {
        useMobile.getState().openFile({ sessionId, path: link.path, line: link.line, ...(cwd ? { cwd } : {}) })
      }
    },
    [sessionId, cwd],
  )

  const dir = dirOf(path)
  const sub = [
    dir || null,
    ...(lines && !rendered && target !== null
      ? [`line ${target} of ${lines.length}`]
      : [
          shown ? formatBytes(shown.bytes.length) : null,
          lines ? `${lines.length} line${lines.length === 1 ? '' : 's'}` : null,
        ]),
  ]
    .filter(Boolean)
    .join(' · ')

  let body
  if (lines && text !== null && rendered) {
    body = <PhoneMarkdown content={text} path={path} onLink={onLink} />
  } else if (lines) {
    body = (
      <div className={['py-2.5', wrap ? '' : 'w-max min-w-full'].join(' ')}>
        {lines.map((row, i) => {
          const n = i + 1
          const hit = n === target
          return (
            <div
              key={i}
              data-line={n}
              className="flex font-mono fs-12 leading-[1.75]"
              style={hit ? { background: 'rgba(150,205,255,.07)' } : undefined}
            >
              {/* The number is drawn by ::before, so a selection copies the text without it.
                  With Wrap off it is pinned, and the code slides under it behind a hairline (10d·e). */}
              <span
                data-number={n}
                className={[
                  'block w-11 flex-none pr-3 text-right before:content-[attr(data-number)]',
                  wrap ? '' : 'sticky left-0 z-[1]',
                ].join(' ')}
                style={{
                  color: hit ? TARGET_NUMBER : 'rgba(160,190,225,.35)',
                  background: hit ? '#0d131c' : '#03050b',
                  boxShadow:
                    [hit ? `inset 2px 0 0 ${TARGET_RAIL}` : '', wrap ? '' : 'inset -1px 0 0 rgba(150,205,255,.08)']
                      .filter(Boolean)
                      .join(', ') || undefined,
                }}
              />
              <span
                className={[
                  'min-w-0 pr-4 text-[rgba(214,230,248,.9)] [font-variant-ligatures:none]',
                  wrap ? 'flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]' : 'flex-none whitespace-pre',
                ].join(' ')}
              >
                {tokens
                  ? tokens[i].map((token, j) => (
                      // A static token list: the index is a stable key.
                      <span key={j} style={token.color ? { color: token.color } : undefined}>
                        {token.content}
                      </span>
                    ))
                  : row || ' '}
              </span>
            </div>
          )
        })}
      </div>
    )
  } else if (view.phase === 'loading') {
    body = (
      <div className="flex h-full flex-col justify-center">
        <ByteBar received={view.received} total={view.total} mac={mac} />
      </div>
    )
  } else if (outcome?.kind === 'failed') {
    body = (
      <div className="flex h-full flex-col justify-center">
        <StateText title="Couldn't load" action={<StateButton onClick={retry}>Retry</StateButton>}>
          {outcome.received > 0 ? `The connection dropped at ${formatBytes(outcome.received)}.` : 'The connection dropped.'}
        </StateText>
      </div>
    )
  } else if (outcome?.kind === 'gone') {
    body = (
      <div className="flex h-full flex-col justify-center">
        <GoneBlock path={path} mac={mac} />
      </div>
    )
  } else if (outcome?.kind === 'waits') {
    body = (
      <div className="flex h-full flex-col justify-center">
        <StateText title={`Opens when ${mac} wakes`}>Not on this phone yet. Stay here and it loads on its own.</StateText>
      </div>
    )
  } else if (outcome?.kind === 'cant-show' || outcome?.kind === 'outside') {
    body = (
      <div className="flex h-full flex-col justify-center">
        <CantShow path={path} size={outcome.kind === 'cant-show' ? outcome.size : null} outside={outcome.kind === 'outside'} />
      </div>
    )
  }

  return (
    <main className="relative flex h-full min-h-0 flex-col text-[#e8eef8]">
      {/* Canvas 10d, third phone: the header, then the read-only chip under it. */}
      <header className="shrink-0 border-b border-[rgba(150,205,255,.1)] bg-[rgba(8,12,22,.9)] px-1.5 pb-2">
        <div className="flex h-13 items-center gap-1">
          <button
            type="button"
            aria-label="Back"
            onClick={onBack}
            className="grid h-11 w-11 shrink-0 place-items-center fs-28 leading-none text-[rgba(220,235,255,.85)]"
          >
            ‹
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate fs-16 font-bold">{basename(path)}</div>
            {sub && <div className="mt-0.5 truncate font-mono fs-10.5 text-[rgba(160,190,225,.65)]">{sub}</div>}
          </div>
          {isMarkdown && lines && (
            // 10d·e, the switch: a 76×28 pill whose two segments are each 38×44 to the finger.
            <div role="tablist" className="relative mr-1 flex flex-none">
              <span aria-hidden className="pointer-events-none absolute inset-x-0 top-2 h-7 rounded-lg border border-[rgba(150,205,255,.14)]" />
              {(
                [
                  ['rendered', 'Rendered', 'Aa', 'font-sans fs-12 font-bold tracking-[-.02em]'],
                  ['source', 'Source', '</>', 'font-mono fs-10.5 [font-variant-ligatures:none]'],
                ] as const
              ).map(([value, name, glyph, type]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={mode === value}
                  aria-label={name}
                  title={name}
                  onClick={() => switchTo(value)}
                  className="relative grid h-11 w-[38px] place-items-center"
                >
                  <span
                    className={[
                      'grid h-7 w-[38px] place-items-center rounded-lg',
                      type,
                      mode === value
                        ? 'bg-[rgba(150,205,255,.14)] text-[#e8eef8] shadow-[inset_0_0_0_1px_rgba(150,205,255,.3)]'
                        : 'text-[rgba(160,190,225,.7)]',
                    ].join(' ')}
                  >
                    {glyph}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        {shown && (
          <div className="pl-2.5">
            <span className="rounded-[4px] border border-[rgba(150,205,255,.2)] px-[7px] py-[3px] font-mono fs-9 tracking-[0.14em] text-[rgba(160,190,225,.75)]">
              READ-ONLY PREVIEW · {asOfLabel(shown.readAt, Date.now()).toUpperCase()}
            </span>
          </div>
        )}
      </header>
      <div
        ref={scroller}
        className="relative min-h-0 flex-1 overflow-auto overscroll-contain bg-[rgba(2,4,9,.6)] [scrollbar-color:rgba(150,205,255,.22)_transparent] [scrollbar-width:thin]"
      >
        {body}
      </div>
      <footer className="flex shrink-0 flex-col gap-2 border-t border-[rgba(150,205,255,.1)] bg-[rgba(6,10,20,.94)] px-4 pb-1.5 pt-2.5">
        <div className="fs-12 leading-[1.45] text-[rgba(160,190,225,.65)] [text-wrap:pretty]">
          Text files up to {formatBytes(PHONE_TEXT_PREVIEW_MAX_BYTES)} preview here. Editing happens on the Mac.
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void copyToClipboard(path)}
            className="h-13 flex-1 rounded-[14px] border border-[rgba(150,205,255,.22)] bg-transparent fs-14 font-semibold text-[#e8eef8]"
          >
            Copy path
          </button>
          {/* Rendered text always reflows, so there Wrap is removed, not disabled (10d·e). */}
          {lines && !rendered && (
            <button
              type="button"
              aria-pressed={wrap}
              onClick={() => setWrap((w) => !w)}
              className="h-13 flex-1 rounded-[14px] border border-[rgba(150,205,255,.22)] bg-transparent fs-14 font-semibold text-[#e8eef8]"
            >
              Wrap · {wrap ? 'on' : 'off'}
            </button>
          )}
        </div>
      </footer>
    </main>
  )
}
