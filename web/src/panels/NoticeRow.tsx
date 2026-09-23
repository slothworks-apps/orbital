import { useState } from 'react'
import type { ChatMessage, NoticeLevel } from '../lib/types'
import { ansiToHtml } from '../lib/highlight'

/**
 * Canvas 20c F's ramp: glyph and ink rise with urgency, and accent appears
 * only where there is something to do about it. No hue anywhere — amber and
 * red belong to the tags and the mode dots, and a notice borrowing one would
 * read as a failure of theirs.
 */
const LEVEL: Record<
  NoticeLevel,
  { label: string; glyph: string; glyphInk: string; labelInk: string; bodyInk: string }
> = {
  info: {
    label: 'INFO',
    glyph: '·',
    glyphInk: 'text-[rgba(160,190,225,.5)]',
    labelInk: 'text-[rgba(160,190,225,.5)]',
    bodyInk: 'text-[rgba(200,220,245,.62)]',
  },
  notice: {
    label: 'NOTICE',
    glyph: '○',
    glyphInk: 'text-[rgba(220,232,248,.85)]',
    labelInk: 'text-[rgba(200,220,245,.7)]',
    bodyInk: 'text-[rgba(225,235,250,.9)]',
  },
  suggestion: {
    label: 'SUGGESTION',
    glyph: '◇',
    glyphInk: 'text-accent',
    labelInk: 'text-accent/85',
    bodyInk: 'text-[rgba(225,235,250,.9)]',
  },
  warning: {
    label: 'WARNING',
    glyph: '▲',
    glyphInk: 'text-white',
    labelInk: 'text-white',
    bodyInk: 'text-[#e8eef8]',
  },
}

/** Canvas 20c A/B: the CLI's own output ink, whatever level it arrived at. */
const OUTPUT_INK = 'text-[rgba(215,228,245,.85)]'

/**
 * Canvas 20c B: "up to 8 lines render in full", longer output clips at 8 with
 * a fade and one link that grows the row in place. `max-h-[136px]` is those 8
 * lines at the body's own 11px / 1.55 — the number the artboard writes.
 */
const FOLD_AT = 8
const CLIPPED = 'max-h-[136px]'

/**
 * Box-drawing frames only join at the artboard's tighter leading, and only if
 * the lines are not reflowed — so output carrying them (or raw ANSI, which is
 * what `/status` used to arrive as on older CLIs) is set differently from
 * prose (canvas 20c D).
 */
const BOX_DRAWING = /[\u2500-\u257f]/
/** The introducer every ANSI control sequence starts with. */
const ANSI_CSI = '\u001b['

function isTerminalArt(text: string): boolean {
  return BOX_DRAWING.test(text) || text.includes(ANSI_CSI)
}

/**
 * The CLI's own voice in the transcript (canvas
 * `Feature - Transcript blocks` 20c; 20a for where it sits between messages).
 *
 * A line the CLI wrote itself: the output of a slash command it answered
 * locally (`/context`, `/usage`, `/mcp`, `/agents`), a hook's feedback, a
 * status banner. Not a turn — nothing here went to or came from the model —
 * so it gets neither the user's bubble nor the assistant's prose column, and
 * 20c gives it neither: full transcript width, mono body, dashed rules above
 * and below. A printout dropped between messages.
 *
 * Two headers, chosen by the one thing the data actually distinguishes
 * (domain `locally-answered-slash-commands`): a notice that NAMES a command
 * is that command's output and wears 20c A's `CLI` + command chip; one that
 * names none is a run message and wears 20c F's glyph + level. 20c E's rule
 * holds either way — the chip is absent rather than guessed.
 *
 * Verbatim, never markdown, for the same reason the command expansion in
 * `MessageView` is: this is terminal output, and its columns and blank lines
 * are the only structure it has. `/context` prints a pipe table that a
 * markdown renderer would reflow into something narrower and less readable;
 * `/usage` prints lines that markdown would join into a paragraph. ANSI
 * colour is decoded the same way a Bash tool result's is (`ansiToHtml`
 * escapes its input before colorizing).
 *
 * Folded rather than capped: 20c B replaces the bounded scroller this row
 * used to own, because the feature's acceptance list says no block in the
 * transcript owns a vertical scroller — the transcript scrolls, the row grows.
 */
export interface NoticeRowProps {
  message: ChatMessage
}

export function NoticeRow({ message }: NoticeRowProps) {
  const [open, setOpen] = useState(false)
  const level = message.notice?.level ?? 'notice'
  const tone = LEVEL[level]
  const command = message.notice?.command
  const text = message.text ?? ''
  const lines = text.split('\n').length
  const boxed = isTerminalArt(text)
  const folded = lines > FOLD_AT && !open
  // Canvas 20c F: warning is the one level that leaves the dashed printout
  // for a solid box.
  const loud = level === 'warning'
  // Canvas 20c F draws a run message as ONE baseline-aligned line — glyph,
  // level, text. Only output that needs more than a line gets 20c A's header
  // over a body.
  const inline = !command && lines === 1
  const time = message.timestamp
    ? new Date(message.timestamp).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      })
    : null

  const identity = command ? (
    <>
      CLI
      {/* 20c A's chip: the command's own name, set at reading size and
          untracked so it stays a name rather than an eyebrow. */}
      <span className="inline-block rounded-[4px] border border-[rgba(150,205,255,.14)] px-1.5 py-px text-[10.5px] tracking-normal text-[#e8eef8]">
        {command}
      </span>
    </>
  ) : (
    <>
      <span aria-hidden className={`inline-block w-[10px] shrink-0 text-center ${tone.glyphInk}`}>
        {tone.glyph}
      </span>
      <span className={`shrink-0 ${tone.labelInk}`}>{tone.label}</span>
    </>
  )

  return (
    <div
      data-notice
      data-notice-level={level}
      className={[
        inline ? 'flex items-baseline gap-2' : 'flex flex-col gap-[5px]',
        'font-mono',
        loud
          ? 'rounded-[8px] border border-[rgba(232,238,248,.32)] bg-[rgba(232,238,248,.05)] px-2.5 py-[7px]'
          : `border-y border-dashed px-[2px] ${inline ? 'py-[6px]' : 'pb-[9px] pt-2'} ${
              level === 'info'
                ? 'border-[rgba(150,205,255,.12)]'
                : 'border-[rgba(150,205,255,.16)]'
            }`,
      ].join(' ')}
    >
      {inline ? (
        <>
          <span className="flex shrink-0 items-baseline gap-2 text-[9.5px] tracking-[0.14em]">
            {identity}
          </span>
          <span
            className={`min-w-0 flex-1 text-[11px] leading-[1.5] ${tone.bodyInk}`}
            // Decoded the same way the stacked form's body is — a one-line
            // banner can still arrive coloured from an older CLI, and
            // `ansiToHtml` escapes its input before colorizing.
            dangerouslySetInnerHTML={{ __html: ansiToHtml(text) }}
          />
        </>
      ) : (
        <>
          <div
            className={`flex items-center gap-2 text-[9.5px] tracking-[0.14em] ${
              command ? 'text-[rgba(160,190,225,.55)]' : ''
            }`}
          >
            {identity}
            <span aria-hidden className="flex-1" />
            {/* 20c D marks ANSI output in the header's right slot, beside the
                time that already sits there. */}
            {command && (boxed || time) && (
              <span className="text-[rgba(160,190,225,.55)]">
                {[boxed ? 'ANSI' : null, time].filter(Boolean).join(' · ')}
              </span>
            )}
          </div>
          <div className="relative">
            <pre
              className={[
                'm-0 text-[11px]',
                boxed
                  ? 'overflow-x-auto whitespace-pre leading-[1.3]'
                  : 'whitespace-pre-wrap leading-[1.55]',
                command ? OUTPUT_INK : tone.bodyInk,
                folded ? `${CLIPPED} overflow-y-hidden` : '',
              ].join(' ')}
              // `ansiToHtml` escapes its input before colorizing, so no raw
              // markup from a command's stdout can reach the DOM.
              dangerouslySetInnerHTML={{ __html: ansiToHtml(text) }}
            />
            {folded && (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-0 bottom-0 block h-[34px] bg-[linear-gradient(180deg,transparent,rgba(12,17,30,.98))]"
              />
            )}
          </div>
        </>
      )}
      {lines > FOLD_AT && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="cursor-pointer self-start font-mono text-[10px] text-[rgba(143,216,255,.85)] focus:outline-none"
        >
          {open ? '▴ show less' : `▾ show all ${lines} lines`}
        </button>
      )}
    </div>
  )
}
