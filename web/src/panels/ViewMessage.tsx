import { useContext } from 'react'
import type { ViewMessage as ParsedViewMessage } from '@orbital/shared/views'
import { FromViewLine, ViewJumpContext } from './ViewParts'

/**
 * A message a view sent, read back out of its own text (`parseViewMessage`):
 * the user's bubble with one mono line above it, "from <title> ↑", which
 * jumps back to the view (canvas `Feature - Views` 69c SENT). What the page
 * sent is the bubble: a string as words, anything else as its JSON. An
 * error the user sent from a failed view reads the same way, the error in
 * mono (not on the canvas).
 */
export function ViewMessageBubble({ parsed, time }: { parsed: ParsedViewMessage; time?: string }) {
  const views = useContext(ViewJumpContext)
  const jump = views?.has(parsed.viewId) ? () => views.jump(parsed.viewId) : undefined
  const words = parsed.kind === 'value' ? stringValue(parsed.body) : null
  return (
    <div data-role="user" data-view-message className="flex flex-col items-end gap-[5px]">
      <FromViewLine title={parsed.title} error={parsed.kind === 'error'} onJump={jump} />
      <div className="max-w-[86%] rounded-[12px_12px_4px_12px] border border-accent/30 bg-accent/12 px-3.5 py-2.5 fs-13 leading-[1.5] text-ink-100 [overflow-wrap:anywhere] [text-wrap:pretty]">
        {words !== null ? (
          <span className="whitespace-pre-wrap">{words}</span>
        ) : (
          <pre className="m-0 whitespace-pre-wrap font-mono fs-11.5 leading-[1.5] text-ink-200">{parsed.body}</pre>
        )}
        {parsed.text && <div className="mt-1.5 whitespace-pre-wrap">{parsed.text}</div>}
      </div>
      {time && <span className="font-mono fs-10 text-ink-900/70">{time}</span>}
    </div>
  )
}

/** The value as words when it is one string; null for anything else. */
function stringValue(body: string): string | null {
  try {
    const value: unknown = JSON.parse(body)
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}
