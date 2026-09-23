import type { ChatMessage, NoticeLevel } from '../lib/types'
import { ansiToHtml } from '../lib/highlight'

/**
 * The header's label when the CLI did not say which command answered — a
 * refused command carries no name, and a hook's banner names none either.
 */
const LEVEL_LABEL: Record<NoticeLevel, string> = {
  info: 'note',
  notice: 'local command',
  suggestion: 'suggestion',
  warning: 'warning',
}

/**
 * The two loud levels are the only ones that get their own ink. `info` and
 * `notice` are the CLI answering a question that was asked; nothing about
 * them is a problem, so they stay in the transcript's muted machine ink —
 * the same the folded command expansion and the tool rows use.
 */
function isLoud(level: NoticeLevel): boolean {
  return level === 'warning' || level === 'suggestion'
}

export interface NoticeRowProps {
  message: ChatMessage
}

/**
 * A line the CLI wrote itself: the output of a slash command it answered
 * locally (`/context`, `/usage`, `/mcp`, `/agents`), a hook's feedback, a
 * status banner. Not a turn — nothing here went to or came from the model —
 * so it gets neither the user's bubble nor the assistant's prose column.
 *
 * Verbatim, never markdown, for the same reason the command expansion in
 * `MessageView` is: this is terminal output, and its columns and blank lines
 * are the only structure it has. `/context` prints a pipe table that a
 * markdown renderer would reflow into something narrower and less readable;
 * `/usage` prints lines that markdown would join into a paragraph. ANSI
 * colour is decoded the same way a Bash tool result's is (`ansiToHtml`
 * escapes its input before colorizing).
 *
 * Bounded height rather than a fold: `/context` runs to dozens of lines and
 * would otherwise swallow the transcript, but a row that has to be opened
 * before it says anything is the silence this component exists to end.
 *
 * NOTE: no artboard covers a system/notice row, so every value here is
 * borrowed from a row that does have one rather than picked by eye: the
 * header from the folded tool run's header (canvas 6b) and the command chip
 * (canvas 6c), the body from `MessageView`'s expansion `<pre>` (canvas 6c C),
 * the loud variant from the transcript's own error alert. A design pass is
 * pending — see `docs/domains/locally-answered-slash-commands.md`.
 */
export function NoticeRow({ message }: NoticeRowProps) {
  const level = message.notice?.level ?? 'notice'
  const loud = isLoud(level)
  const text = message.text ?? ''
  const lines = text.split('\n').length

  return (
    <div data-notice data-notice-level={level} className="flex flex-col gap-1">
      {/* Canvas 6b's run header and 6c's command chip: 11.5px mono, 7px gap,
          the row's muted ink with the name itself at full brightness. */}
      <div
        className={[
          'flex items-center gap-[7px] font-mono text-[11.5px]',
          loud ? 'text-red-300' : 'text-[rgba(160,190,225,.6)]',
        ].join(' ')}
      >
        <span aria-hidden>⌁</span>
        <span className={loud ? '' : 'text-text-bright'}>
          {message.notice?.command ?? LEVEL_LABEL[level]}
        </span>
        {lines > 1 && <span className="text-[rgba(160,190,225,.5)]">· {lines} lines</span>}
      </div>
      {/* The expansion `<pre>` of canvas 6c C, verbatim: same radius, inset,
          type and height cap. The loud variant swaps in the transcript's own
          error-alert tokens rather than inventing a second warning palette. */}
      <pre
        className={[
          'max-h-[168px] w-full self-stretch overflow-auto whitespace-pre-wrap rounded-[7px] border',
          'px-3 py-2.5 text-left font-mono text-[10.5px] leading-[1.6]',
          loud
            ? 'border-red-400/30 bg-red-400/10 text-red-300'
            : 'border-[rgba(150,205,255,.12)] bg-[rgba(4,8,16,.55)] text-[rgba(160,190,225,.75)]',
        ].join(' ')}
        // `ansiToHtml` escapes its input before colorizing, so no raw markup
        // from a command's stdout can reach the DOM.
        dangerouslySetInnerHTML={{ __html: ansiToHtml(text) }}
      />
    </div>
  )
}
