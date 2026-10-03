import { useRef, useState } from 'react'
import type { SessionHarness } from '../../lib/types'
import { pad2, shortSha } from './model'
import { FILE_FOLD_LINES, foldFile, type PatchFile } from './patch'
import { HeaderBlock, Kicker, type Chrome } from './parts'
import { useStepDiff } from './useStepDiff'

const MINT = '#7fe3b0'
const RED = '#fa8880'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** "+14 −6", with a zero side quiet (30e's file list). */
function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <>
      <span style={{ color: added ? MINT : 'rgba(160,190,225,.4)' }}>+{added}</span>
      <span style={{ color: removed ? RED : 'rgba(160,190,225,.4)' }}>−{removed}</span>
    </>
  )
}

/** One file of the unified diff (30e): its header row, hunks, rows tinted with the done / interrupted tokens. */
function FileDiff({ file, wide, unfolded, onUnfold }: { file: PatchFile; wide: boolean; unfolded: boolean; onUnfold: () => void }) {
  const { hunks, more } = unfolded ? { hunks: file.hunks, more: 0 } : foldFile(file, FILE_FOLD_LINES)
  return (
    <div data-file={file.path}>
      <div className="mb-0.5 mt-2.5 flex items-center gap-2 border-y border-b-[rgba(150,205,255,.06)] border-t-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.6)] px-[18px] py-1.5 text-[#e8eef8]">
        <span className="min-w-0 flex-1 truncate">{file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path}</span>
        <span className="shrink-0 text-[rgba(160,190,225,.6)]">
          +{file.added} −{file.removed}
        </span>
      </div>
      {file.binary && <div className="px-[18px] py-0.5 text-[rgba(160,190,225,.55)]">binary file</div>}
      {hunks.map((h, i) => (
        <div key={i}>
          <div className="truncate whitespace-nowrap px-[18px] py-0.5 text-[rgba(160,190,225,.55)]">{h.header}</div>
          {h.lines.map((l, j) => (
            <div
              key={j}
              className="flex"
              style={{ background: l.kind === 'add' ? 'rgba(127,227,176,.08)' : l.kind === 'del' ? 'rgba(250,136,128,.09)' : undefined }}
            >
              <span
                className="shrink-0 box-border text-right text-[rgba(160,190,225,.35)]"
                style={{ width: wide ? 44 : 38, paddingRight: wide ? 10 : 8 }}
              >
                {l.line}
              </span>
              <span
                className="shrink-0"
                style={{ width: wide ? 16 : 14, color: l.kind === 'add' ? MINT : l.kind === 'del' ? RED : 'transparent' }}
              >
                {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ''}
              </span>
              <span
                className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-pre pr-3"
                style={{ color: l.kind === 'add' ? '#c9f3dc' : l.kind === 'del' ? '#fbcfcb' : 'rgba(200,214,235,.75)' }}
              >
                {l.text}
              </span>
            </div>
          ))}
        </div>
      ))}
      {more > 0 && (
        <button
          type="button"
          onClick={onUnfold}
          className="block px-[18px] py-1.5 text-left tracking-[0.04em] text-[oklch(85%_.12_205)] hover:brightness-110"
        >
          ⋯ {plural(more, 'more line')}
        </button>
      )}
    </div>
  )
}

/** The diff's body: every file, the picked one unfolded. */
function DiffBody({
  files,
  wide,
  unfolded,
  unfold,
}: {
  files: PatchFile[]
  wide: boolean
  unfolded: Set<string>
  unfold: (path: string) => void
}) {
  return (
    <>
      {files.map((f) => (
        <FileDiff key={f.path} file={f} wide={wide} unfolded={unfolded.has(f.path)} onUnfold={() => unfold(f.path)} />
      ))}
    </>
  )
}

/**
 * A step's diff in the side slot (canvas 30e, right): the file list on top,
 * the selected one filled, and the unified diff under it.
 */
export function StepDiffView({
  sessionId,
  harness,
  index,
  chrome,
  onBack,
}: {
  sessionId: string
  harness: SessionHarness
  index: number
  chrome: Chrome
  onBack: () => void
}) {
  const state = harness.state[index]
  const { diff, error } = useStepDiff(sessionId, index, state)
  const [selected, setSelected] = useState<string | null>(null)
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set())
  const bodyRef = useRef<HTMLDivElement>(null)
  const files = diff?.parsed.files ?? []
  const current = selected ?? files[0]?.path ?? null

  const pick = (path: string) => {
    setSelected(path)
    setUnfolded((s) => new Set(s).add(path))
    const el = bodyRef.current?.querySelector(`[data-file="${CSS.escape(path)}"]`)
    el?.scrollIntoView?.({ block: 'start' })
  }

  return (
    <>
      <HeaderBlock chrome={chrome} pb={12}>
        {chrome.row(
          <>
            <button type="button" onClick={onBack} className="font-mono text-[10.5px] text-[oklch(85%_.12_205)] hover:brightness-110">
              ‹ record
            </button>
            <span aria-hidden className="flex-1" />
            <Kicker>DIFF · STEP {pad2(index + 1)}</Kicker>
          </>,
        )}
        {state?.startHead && state.endHead && (
          <div className="mt-2 font-mono text-[12px] text-[#e8eef8]">
            {shortSha(state.startHead)}..{shortSha(state.endHead)}
          </div>
        )}
        {diff && (
          <div className="mt-1 flex gap-1 font-mono text-[10px] text-[rgba(160,190,225,.6)]">
            {diff.commits !== null && `${plural(diff.commits, 'commit')} · `}
            {plural(files.length, 'file')} · <Counts added={diff.parsed.added} removed={diff.parsed.removed} />
            {diff.pushed === false && ' · local, not pushed'}
            {diff.parsed.cut && ' · cut at the size cap'}
          </div>
        )}
        {files.length > 0 && (
          <div className="mt-2.5 flex max-h-[160px] flex-col gap-0.5 overflow-y-auto font-mono text-[10.5px]">
            {files.map((f) => (
              <button
                type="button"
                key={f.path}
                onClick={() => pick(f.path)}
                className="flex gap-2 rounded-[5px] px-1.5 py-1 text-left hover:bg-[rgba(150,205,255,.05)]"
                style={{
                  background: f.path === current ? 'rgba(150,205,255,.08)' : undefined,
                  color: f.path === current ? '#e8eef8' : 'rgba(200,214,235,.8)',
                }}
              >
                <span className="min-w-0 flex-1 truncate">{f.path}</span>
                <Counts added={f.added} removed={f.removed} />
              </button>
            ))}
          </div>
        )}
      </HeaderBlock>
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto pb-3 pt-2 font-mono text-[10.5px] leading-[1.7]">
        {error && <div className="px-[18px] text-[rgba(160,190,225,.6)]">{error}</div>}
        {!diff && !error && !(state?.startHead && state.endHead) && (
          <div className="px-[18px] text-[rgba(160,190,225,.6)]">This step has no commit range.</div>
        )}
        {diff && files.length === 0 && <div className="px-[18px] text-[rgba(160,190,225,.6)]">No changes in this range.</div>}
        {diff && <DiffBody files={files} wide={false} unfolded={unfolded} unfold={(p) => setUnfolded((s) => new Set(s).add(p))} />}
      </div>
      <div className="flex items-center gap-2 border-t border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.4)] px-[18px] py-[11px] font-mono text-[10px] tracking-[0.06em] text-[rgba(160,190,225,.5)]">
        unified{chrome.inWindow ? '' : ' · wide view in the full window'}
        <span aria-hidden className="flex-1" />
        <span>⎋ back</span>
      </div>
    </>
  )
}

/** The full window's diff column (canvas 30h, right, 520 px). */
export function WideStepDiff({ sessionId, harness, index }: { sessionId: string; harness: SessionHarness; index: number }) {
  const state = harness.state[index]
  const { diff, error } = useStepDiff(sessionId, index, state)
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set())
  const files = diff?.parsed.files ?? []
  return (
    <div className="flex min-h-0 flex-col overflow-y-auto border-l border-[rgba(150,205,255,.08)] bg-[rgba(2,4,9,.35)] font-mono text-[11px] leading-[1.75]">
      <div className="flex gap-1 px-[18px] pb-1.5 pt-3.5 text-[9.5px] tracking-[0.18em] text-[rgba(160,190,225,.55)]">
        DIFF
        {diff && (
          <>
            {' '}
            · {plural(files.length, 'FILE').toUpperCase()} · <Counts added={diff.parsed.added} removed={diff.parsed.removed} />
          </>
        )}
      </div>
      {error && <div className="px-[18px] text-[rgba(160,190,225,.6)]">{error}</div>}
      {!(state?.startHead && state.endHead) && <div className="px-[18px] text-[rgba(160,190,225,.6)]">This step has no commit range.</div>}
      {diff && <DiffBody files={files} wide unfolded={unfolded} unfold={(p) => setUnfolded((s) => new Set(s).add(p))} />}
    </div>
  )
}
