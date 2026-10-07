import { useEffect, useMemo, useRef, useState } from 'react'
import { copyToClipboard } from '../../lib/clipboard'
import { formatBytes } from '../../lib/format'
import { PHONE_TEXT_PREVIEW_MAX_BYTES } from '../constants'
import { asOfLabel, basename } from '../format'
import { useMobile } from '../state'
import { CantShow } from './CantShow'
import { ByteBar, GoneBlock, StateButton, StateText } from './FileStates'
import { useFile } from './useFile'

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

/**
 * Canvas 10d, third phone — a text file the transcript named, read-only
 * (spec 2026-10-05-mobile-next § 2): line numbers, scrolled to the `:line`
 * the mention carried, Wrap on or off, Copy path. Editing stays on the Mac.
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
  const mac = useMobile((s) => s.macName) ?? 'the Mac'
  const [wrap, setWrap] = useState(true)
  const target = useRef<HTMLDivElement>(null)

  const outcome = view.phase === 'done' ? view.outcome : null
  const shown = outcome?.kind === 'ready' ? outcome : outcome?.kind === 'gone' ? outcome.copy : null
  const lines = useMemo(() => (shown ? previewLines(new TextDecoder().decode(shown.bytes)) : null), [shown])

  useEffect(() => {
    if (lines && line !== null) target.current?.scrollIntoView({ block: 'center' })
  }, [lines, line])

  const dir = dirOf(path)
  const sub = [
    dir || null,
    shown ? formatBytes(shown.bytes.length) : null,
    lines ? `${lines.length} line${lines.length === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  let body
  if (lines) {
    body = (
      <div className={wrap ? '' : 'w-max min-w-full'}>
        {lines.map((text, i) => (
          <div
            key={i}
            ref={line === i + 1 ? target : undefined}
            className="flex gap-3 font-mono text-[12px] leading-[1.75]"
          >
            <span className="w-8 flex-none text-right text-[rgba(160,190,225,.35)]">{i + 1}</span>
            <span
              className={[
                'min-w-0 flex-1 text-[rgba(214,230,248,.9)]',
                wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre pr-4',
              ].join(' ')}
            >
              {text || ' '}
            </span>
          </div>
        ))}
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
            className="grid h-11 w-11 shrink-0 place-items-center text-[28px] leading-none text-[rgba(220,235,255,.85)]"
          >
            ‹
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[16px] font-bold">{basename(path)}</div>
            {sub && <div className="mt-0.5 truncate font-mono text-[10.5px] text-[rgba(160,190,225,.65)]">{sub}</div>}
          </div>
        </div>
        {shown && (
          <div className="pl-2.5">
            <span className="rounded-[4px] border border-[rgba(150,205,255,.2)] px-[7px] py-[3px] font-mono text-[9px] tracking-[0.14em] text-[rgba(160,190,225,.75)]">
              READ-ONLY PREVIEW · {asOfLabel(shown.readAt, Date.now()).toUpperCase()}
            </span>
          </div>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-auto bg-[rgba(2,4,9,.6)] py-2.5">{body}</div>
      <footer className="flex shrink-0 flex-col gap-2 border-t border-[rgba(150,205,255,.1)] bg-[rgba(6,10,20,.94)] px-4 pb-1.5 pt-2.5">
        <div className="text-[12px] leading-[1.45] text-[rgba(160,190,225,.65)] [text-wrap:pretty]">
          Text files up to {formatBytes(PHONE_TEXT_PREVIEW_MAX_BYTES)} preview here. Editing happens on the Mac.
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void copyToClipboard(path)}
            className="h-13 flex-1 rounded-[14px] border border-[rgba(150,205,255,.22)] bg-transparent text-[14px] font-semibold text-[#e8eef8]"
          >
            Copy path
          </button>
          {lines && (
            <button
              type="button"
              aria-pressed={wrap}
              onClick={() => setWrap((w) => !w)}
              className="h-13 flex-1 rounded-[14px] border border-[rgba(150,205,255,.22)] bg-transparent text-[14px] font-semibold text-[#e8eef8]"
            >
              Wrap · {wrap ? 'on' : 'off'}
            </button>
          )}
        </div>
      </footer>
    </main>
  )
}
