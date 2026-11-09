import { useState } from 'react'
import type { SessionSetup } from '@orbital/shared/worktree'
import { queuedCaption, setupBlock, type SetupLine } from '../lib/setup'
import { swatch } from '../lib/palette'
import { useOrbital } from '../store/store'
import { copySetupPrompt, retrySetup, startWithoutWorktree } from '../store/setupActions'
import { ForkMark } from './WhereLine'

/**
 * A worktree launch in the transcript (spec
 * 2026-11-09-worktree-setup-in-background-design; canvas 66a, 66c, 66d):
 * the setup block under the first prompt, and the prompt and the queue as
 * queued turns while the session has not started — the queue still, at the
 * bottom, until the first turn has ended.
 */

export type SetupSurface = 'panel' | 'phone'

/** 66c: the block's fixed height per surface, so nothing below it moves when it changes. */
const BLOCK_PX: Record<SetupSurface, number> = { panel: 132, phone: 172 }
/** 66c `r3h`: the bottom row's height — the path, or the ways out. */
const ACTION_ROW_PX: Record<SetupSurface, number> = { panel: 34, phone: 60 }

/** 66c `L()`: each line's ink, its glyph's and its mono tail's, by how far along it is. */
const LINE_INK: Record<SetupLine['tone'], { text: string; glyph: string; mono: string }> = {
  now: { text: 'text-ink-100', glyph: 'text-ink-100', mono: 'text-ink-500/80' },
  done: { text: 'text-ink-200/85', glyph: 'text-ink-200/85', mono: 'text-ink-500/80' },
  pending: { text: 'text-ink-900/60', glyph: 'text-ink-900/45', mono: 'text-ink-900/50' },
  // 66c: the failure's ! in the soft error ink, its sentence in full ink.
  error: { text: 'text-ink-100', glyph: 'text-danger-pale', mono: 'text-ink-500/80' },
}

function BlockButton({
  surface,
  primary = false,
  onClick,
  children,
}: {
  surface: SetupSurface
  primary?: boolean
  onClick: () => void
  children: string
}) {
  const tone = primary
    ? 'border-accent bg-accent font-bold text-space-deep'
    : `bg-transparent font-semibold ${surface === 'phone' ? 'border-line/22 text-ink-100' : 'border-line/20 text-ink-200/90'}`
  // 66c `act()`: 24px chips on the desktop, 44px halves on the phone.
  const size = surface === 'phone' ? 'h-11 flex-1 rounded-[12px] px-3 fs-14' : 'h-6 flex-none rounded-[6px] px-[9px] fs-11.5'
  return (
    <button
      type="button"
      onClick={onClick}
      className={`cursor-pointer whitespace-nowrap border border-solid ${size} ${tone}`}
    >
      {children}
    </button>
  )
}

/**
 * The setup block (canvas 66c): one fixed-height box — its title, three
 * lines, and a bottom row with the worktree's path or, once it failed, the
 * ways out. It keeps its place for the life of the session; once ready it
 * says how long setup took.
 */
export function SetupBlock({
  sessionId,
  setup,
  surface = 'panel',
  onMore,
}: {
  sessionId: string
  setup: SessionSetup
  surface?: SetupSurface
  /** The phone's More…, which opens the ⋯ sheet with the rest of the ways out. */
  onMore?: () => void
}) {
  const model = setupBlock(setup)
  const setDialog = useOrbital((s) => s.setDialog)
  const [copied, setCopied] = useState(false)
  const settingUp = setup.phase !== 'failed' && setup.phase !== 'ready'
  const discard = () => setDialog('end', sessionId)
  const actions = model.failed ? (
    surface === 'phone' ? (
      <>
        <BlockButton surface={surface} primary onClick={() => retrySetup(sessionId)}>
          Try again
        </BlockButton>
        {onMore && (
          <BlockButton surface={surface} onClick={onMore}>
            More…
          </BlockButton>
        )}
      </>
    ) : (
      <>
        <BlockButton surface={surface} primary onClick={() => retrySetup(sessionId)}>
          Try again
        </BlockButton>
        <BlockButton surface={surface} onClick={() => startWithoutWorktree(sessionId)}>
          Without a worktree
        </BlockButton>
        <BlockButton surface={surface} onClick={() => void copySetupPrompt(sessionId).then(setCopied)}>
          {copied ? 'Copied' : 'Copy prompt'}
        </BlockButton>
        <BlockButton surface={surface} onClick={discard}>
          Discard…
        </BlockButton>
      </>
    )
  ) : settingUp && surface === 'panel' ? (
    <BlockButton surface={surface} onClick={discard}>
      Cancel and discard…
    </BlockButton>
  ) : null

  return (
    <div
      data-setup-block={setup.phase}
      className="box-border flex flex-none flex-col overflow-hidden rounded-[8px] border border-line/14 bg-space/45"
      style={{ height: BLOCK_PX[surface] }}
    >
      <div
        className={[
          'flex h-[30px] flex-none items-center gap-2 whitespace-nowrap border-b border-line/8 px-2.5 font-mono fs-11.5',
          model.failed ? 'text-danger-pale' : 'text-ink-200/90',
        ].join(' ')}
      >
        <ForkMark ink={swatch('ink-900', 0.75)} />
        <span className="min-w-0 truncate">{model.title}</span>
        <span aria-hidden className="flex-1" />
        {model.failed ? (
          // "Detail" opens the error log, which holds this failure's full output.
          <button
            type="button"
            onClick={() => setDialog('errors')}
            className="cursor-pointer border-0 bg-transparent p-0 font-mono fs-10.5 text-sky hover:text-sky-soft"
          >
            Detail
          </button>
        ) : (
          model.right && <span className="fs-10.5 text-ink-900/55">{model.right}</span>
        )}
      </div>
      <div
        data-selectable
        className={[
          'flex min-h-0 flex-1 flex-col gap-0.5 px-2.5 py-[7px] leading-[1.45]',
          surface === 'phone' ? 'fs-13.5' : 'fs-12',
        ].join(' ')}
      >
        {model.lines.map((line, i) => {
          const ink = LINE_INK[line.tone]
          return (
            <div key={i} className={`flex items-baseline gap-2 ${ink.text}`}>
              <span aria-hidden className={`w-3 flex-none text-center font-mono fs-10.5 ${ink.glyph}`}>
                {line.glyph}
              </span>
              <span className="min-w-0 flex-1 [text-wrap:pretty]">
                {line.text}
                {line.mono && <span className={`font-mono text-[.92em] ${ink.mono}`}>{line.mono}</span>}
              </span>
            </div>
          )
        })}
      </div>
      <div
        className={[
          'flex flex-none items-center gap-1.5 border-t border-line/8',
          surface === 'phone' ? 'px-2' : 'px-2.5',
        ].join(' ')}
        style={{ height: ACTION_ROW_PX[surface] }}
      >
        <span className="min-w-0 flex-1 truncate whitespace-nowrap font-mono fs-10.5 text-ink-900/55">
          {model.path ?? ''}
        </span>
        {actions}
      </div>
    </div>
  )
}

/**
 * A turn that has not gone out (canvas 66c QUEUED): the queued-turn bubble
 * as built — dashed in the tag hue — with a mono caption and no time.
 */
export function QueuedTurn({ text, caption, hue, surface = 'panel' }: { text: string; caption: string; hue: number; surface?: SetupSurface }) {
  return (
    <div data-setup-queued className="flex w-full flex-none flex-col items-end gap-[5px]">
      <div
        data-selectable
        className={[
          'max-w-[86%] whitespace-pre-wrap border border-dashed px-3.5 py-2.5 leading-[1.5] text-ink-100/86 [text-wrap:pretty]',
          surface === 'phone' ? 'rounded-[16px_16px_5px_16px] fs-14.5' : 'rounded-[12px_12px_4px_12px] fs-13',
        ].join(' ')}
        style={{ borderColor: `oklch(var(--tb-l) var(--tb-c) ${hue} / .4)` }}
      >
        {text}
      </div>
      <span
        className={[
          'min-h-3.5 whitespace-nowrap font-mono tracking-[0.04em] text-ink-900/60',
          surface === 'phone' ? 'fs-10' : 'fs-9.5',
        ].join(' ')}
      >
        {caption}
      </span>
    </div>
  )
}

/**
 * What the transcript holds while a worktree launch has not started: the
 * first prompt, the setup block under it, then the messages queued since
 * (66a). The transcript file does not exist yet, so all of it comes from
 * the session's `setup`.
 */
export function SetupPending({
  sessionId,
  setup,
  hue,
  surface = 'panel',
  onMore,
}: {
  sessionId: string
  setup: SessionSetup
  hue: number
  surface?: SetupSurface
  onMore?: () => void
}) {
  const first = setup.prompt.trim() !== '' ? setup.prompt : null
  return (
    <div className={`flex flex-col ${surface === 'phone' ? 'gap-3' : 'gap-[14px]'}`}>
      {first !== null && <QueuedTurn text={first} caption={queuedCaption(setup, true)} hue={hue} surface={surface} />}
      <SetupBlock sessionId={sessionId} setup={setup} surface={surface} onMore={onMore} />
      <SetupQueue setup={setup} hue={hue} surface={surface} />
    </div>
  )
}

/**
 * The messages queued while the worktree was made, as queued turns: under
 * the setup block before the session starts, and at the bottom of the
 * transcript after, until each is sent once the first turn has ended.
 */
export function SetupQueue({ setup, hue, surface = 'panel' }: { setup: SessionSetup; hue: number; surface?: SetupSurface }) {
  const queued = setup.queued.map((q) => q.text).filter((text) => text.trim() !== '')
  if (queued.length === 0) return null
  return (
    <div className={`flex flex-col ${surface === 'phone' ? 'gap-3' : 'gap-[14px]'}`}>
      {queued.map((text, i) => (
        <QueuedTurn key={i} text={text} caption={queuedCaption(setup, false)} hue={hue} surface={surface} />
      ))}
    </div>
  )
}
