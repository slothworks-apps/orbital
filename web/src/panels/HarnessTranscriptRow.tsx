import type { ChatMessage } from '../lib/types'

/**
 * Orbital's own line in the transcript (canvas `Feature - Harness` 30b,
 * 30a-d): a message the harness sent, or an event of its log where it
 * happened — a dashed row, a ◆ glyph, mono. Never a bubble: the user did not
 * write it. One line; a long step title ellipsises, the whole line is its
 * tooltip.
 */
export function HarnessTranscriptRow({ message }: { message: ChatMessage }) {
  const line = `harness · ${message.text ?? ''}`
  return (
    <div
      data-harness-row
      title={line}
      className="flex items-center gap-2 rounded-[7px] border border-dashed border-[rgba(150,205,255,.18)] px-2.5 py-1.5 font-mono text-[10.5px] text-[rgba(160,190,225,.75)]"
    >
      <span
        aria-hidden
        className="block size-[7px] flex-none rotate-45 rounded-[1px] border-[1.3px] border-solid border-current"
      />
      <span className="min-w-0 truncate">{line}</span>
    </div>
  )
}
