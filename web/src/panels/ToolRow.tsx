import { useState } from 'react'
import type { ChatMessage } from '../lib/types'
import { ansiToHtml } from '../lib/highlight'

/** Tools whose salient input lives in a `file_path` field. */
const FILE_PATH_TOOLS = new Set(['Read', 'Edit', 'Write'])

/**
 * Picks the one input value worth showing in a `ToolRow`'s collapsed
 * one-liner: `command` for Bash, `file_path` for Read/Edit/Write,
 * `description` for Task, and otherwise the first string-valued field on
 * the tool's input object (falling back to `''` when nothing qualifies).
 */
export function salientInput(toolName: string | undefined, toolInput: unknown): string {
  if (!toolInput || typeof toolInput !== 'object') return ''
  const input = toolInput as Record<string, unknown>

  if (toolName === 'Bash' && typeof input.command === 'string') return input.command
  if (toolName && FILE_PATH_TOOLS.has(toolName) && typeof input.file_path === 'string') {
    return input.file_path
  }
  if (toolName === 'Task' && typeof input.description === 'string') return input.description

  for (const value of Object.values(input)) {
    if (typeof value === 'string') return value
  }
  return ''
}

export interface ToolRowProps {
  toolUse: ChatMessage
  /** Undefined while the tool call is still running (no result yet). */
  toolResult?: ChatMessage
}

/**
 * One tool_use/tool_result pair, collapsed to a single `⚙ Bash: npm test`
 * line by default. Expanding shows the full (pretty-printed) input JSON and
 * the result — Bash results go through `ansiToHtml` since shell output
 * commonly carries ANSI color codes.
 */
export function ToolRow({ toolUse, toolResult }: ToolRowProps) {
  const [expanded, setExpanded] = useState(false)
  const running = !toolResult
  const label = salientInput(toolUse.toolName, toolUse.toolInput)

  return (
    <div
      data-role="tool"
      data-running={running}
      className="rounded-md border border-panel-border bg-black/20 text-xs"
    >
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-text-soft hover:bg-white/5"
      >
        <span aria-hidden>⚙</span>
        <span className="min-w-0 flex-1 truncate">
          {toolUse.toolName}
          {label ? `: ${label}` : ''}
        </span>
        {running && (
          <span
            data-testid="tool-running-dot"
            aria-label="running"
            aria-hidden
            className="orbital-pulse h-1.5 w-1.5 shrink-0 rounded-full bg-text-soft"
          />
        )}
      </button>

      {expanded && (
        <div className="flex flex-col gap-2 border-t border-panel-border px-3 py-2">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">input</div>
            <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-text-soft">
              {JSON.stringify(toolUse.toolInput, null, 2)}
            </pre>
          </div>
          {toolResult && (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">result</div>
              {toolUse.toolName === 'Bash' ? (
                <pre
                  className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px]"
                  // eslint-disable-next-line react/no-danger -- ansiToHtml escapes its input before colorizing
                  dangerouslySetInnerHTML={{ __html: ansiToHtml(toolResult.text ?? '') }}
                />
              ) : (
                <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-text-soft">
                  {toolResult.text}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
