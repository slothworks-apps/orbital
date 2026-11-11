import { useState } from 'react'
import type { SessionSetup } from '@orbital/shared/worktree'
import { queuedCaption, setupBlock, type SetupLine } from '../lib/setup'
import { swatch } from '../lib/palette'
import { useOrbital } from '../store/store'
import { copySetupPrompt, retrySetup, startWithoutWorktree } from '../store/setupActions'
import { Button } from '../ui/Button'
import { QueuedBubble, type QueuedBubbleSurface } from '../ui/QueuedBubble'
import { ForkMark } from './WhereLine'

/**
 * A worktree launch in the transcript (spec
 * 2026-11-09-worktree-setup-in-background-design; canvas 66a, 66c, 66d):
 * the setup block under the first prompt, and the prompt and the queue as
 * queued turns while the session has not started — the queue still, at the
 * bottom, until the first turn has ended.
 */

type SetupSurface = QueuedBubbleSurface

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

/**
 * The setup block (canvas 66c): one fixed-height box — its title, three
 * lines, and a bottom row with the worktree's path or, once it failed, the
 * ways out. It keeps its place for the life of the session; once ready it
 * says how long setup took. Discarding is never here: it is the strip's end
 * button on the desktop and the ⋯ sheet's last row on the phone.
 */
export function SetupBlock({
  sessionId,
  setup,
  surface = 'panel',
  onWithoutWorktree,
}: {
  sessionId: string
  setup: SessionSetup
  surface?: SetupSurface
  /** Without a worktree, where it opens New Session — the phone's screen; the desktop's dialog by default. */
  onWithoutWorktree?: () => void
}) {
  const model = setupBlock(setup)
  const setDialog = useOrbital((s) => s.setDialog)
  const [copied, setCopied] = useState(false)
  const phone = surface === 'phone'
  const withoutWorktree = onWithoutWorktree ?? (() => startWithoutWorktree(sessionId))
  // 66c `sb()`: Try again, Without a worktree and Copy prompt as 24px chips;
  // 66d: only the first two, as 44px halves — Copy first prompt is in the ⋯ sheet.
  const button = phone
    ? ({ size: 'block-half', className: 'flex-1', quiet: 'outline-touch' } as const)
    : ({ size: 'block-chip', className: 'flex-none', quiet: 'outline-soft' } as const)
  const actions = model.failed ? (
    <>
      <Button variant="primary-plain" size={button.size} className={button.className} onClick={() => retrySetup(sessionId)}>
        Try again
      </Button>
      <Button variant={button.quiet} size={button.size} className={button.className} onClick={withoutWorktree}>
        Without a worktree
      </Button>
      {!phone && (
        // Below the width the three chips need, Copy prompt gives way: the
        // context menu and the discard dialog offer it too.
        <Button
          variant={button.quiet}
          size={button.size}
          className="flex-none @max-[31em]:hidden"
          onClick={() => void copySetupPrompt(sessionId).then(setCopied)}
        >
          {copied ? 'Copied' : 'Copy prompt'}
        </Button>
      )}
    </>
  ) : null

  return (
    <div
      data-setup-block={setup.phase}
      // A query container sized in the chips' own type, so the row knows
      // when they no longer fit at any text size (`fs-11.5` is 66c's chip).
      className="@container box-border flex flex-none flex-col overflow-hidden rounded-[8px] border border-line/14 bg-space/45 fs-11.5"
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
          // "Detail" opens the error log, which holds this failure's full
          // output. The phone keeps no error log, so it has none.
          !phone && (
          <button
            type="button"
            onClick={() => setDialog('errors')}
            className="cursor-pointer border-0 bg-transparent p-0 font-mono fs-10.5 text-sky hover:text-sky-soft"
          >
            Detail
          </button>
          )
        ) : (
          model.right && <span className="fs-10.5 text-ink-900/55">{model.right}</span>
        )}
      </div>
      <div
        data-selectable
        className={[
          'flex min-h-0 flex-1 flex-col gap-0.5 px-2.5 py-[7px] leading-[1.45]',
          phone ? 'fs-13.5' : 'fs-12',
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
          phone ? 'px-2' : 'px-2.5',
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
  onWithoutWorktree,
}: {
  sessionId: string
  setup: SessionSetup
  hue: number
  surface?: SetupSurface
  onWithoutWorktree?: () => void
}) {
  const first = setup.prompt.trim() !== '' ? setup.prompt : null
  return (
    <div className={`flex flex-col ${surface === 'phone' ? 'gap-3' : 'gap-[14px]'}`}>
      {first !== null && <QueuedBubble kind="setup" surface={surface} text={first} caption={queuedCaption(setup, true)} hue={hue} />}
      <SetupBlock sessionId={sessionId} setup={setup} surface={surface} onWithoutWorktree={onWithoutWorktree} />
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
        <QueuedBubble key={i} kind="setup" surface={surface} text={text} caption={queuedCaption(setup, false)} hue={hue} />
      ))}
    </div>
  )
}
