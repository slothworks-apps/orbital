import { useState } from 'react'
import type { ChatMessage } from '../lib/types'
import { ansiToHtml } from '../lib/highlight'
import { ImageThumb, formatBytes } from './ImageThumb'

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

/** Micro-label over an expanded row's input/result block — the export's
 * 9.5px mono caption, tracked out .16em (canvas 1b). */
function SectionLabel({ children }: { children: string }) {
  return (
    <div className="mb-1 font-mono text-[9.5px] tracking-[0.16em] text-[rgba(160,190,225,.55)]">
      {children}
    </div>
  )
}

export interface ToolRowProps {
  toolUse: ChatMessage
  /** Undefined while the tool call is still running (no result yet). */
  toolResult?: ChatMessage
}

/**
 * One tool_use/tool_result pair, collapsed to a single `▸ ⚙ Bash: npm test`
 * line by default. Expanding shows the full (pretty-printed) input JSON and
 * the result — Bash results go through `ansiToHtml` since shell output
 * commonly carries ANSI color codes.
 *
 * Canvas 1b: 7px radius, 11.5px mono, 7px×10px row padding; a collapsed row
 * sits on a quiet `rgba(4,8,16,.45)` fill behind a barely-there border, and
 * expanding lifts both (fill `.55`, border `.18`) so the open row reads as
 * one block with its output.
 */
export function ToolRow({ toolUse, toolResult }: ToolRowProps) {
  const [expanded, setExpanded] = useState(false)
  const running = !toolResult
  const label = salientInput(toolUse.toolName, toolUse.toolInput)

  return (
    <div
      data-role="tool"
      data-running={running}
      data-expanded={expanded}
      className={[
        'overflow-hidden rounded-[7px] border',
        expanded
          ? 'border-[rgba(150,205,255,.18)] bg-[rgba(4,8,16,.55)]'
          : 'border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.45)]',
      ].join(' ')}
    >
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-2.5 py-[7px] text-left font-mono text-[11.5px] text-[rgba(200,220,245,.8)] hover:bg-white/5"
      >
        <span aria-hidden className="text-[rgba(160,190,225,.6)]">
          {expanded ? '▾' : '▸'}
        </span>
        <span aria-hidden className="text-[rgba(160,190,225,.6)]">
          ⚙
        </span>
        <span className="min-w-0 flex-1 truncate">
          {toolUse.toolName}
          {label ? ': ' : ''}
          <span className="text-text-bright">{label}</span>
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
        <div className="flex flex-col gap-2 border-t border-[rgba(150,205,255,.08)] px-3 pb-2.5 pt-2">
          <div>
            <SectionLabel>INPUT</SectionLabel>
            <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[10.5px] leading-[1.6] text-[rgba(160,190,225,.75)]">
              {JSON.stringify(toolUse.toolInput, null, 2)}
            </pre>
          </div>
          {toolResult && (
            <div>
              <SectionLabel>RESULT</SectionLabel>
              {toolResult.images?.length ? (
                // An image result is a body under the row, like a <pre>
                // output block (canvas 7b): 96px thumb, mono readout beside
                // it — dimensions and size are all an image block carries.
                <div className="flex flex-col gap-2">
                  {toolResult.images.map((image) => (
                    <div key={image.ref} className="flex items-start gap-2.5">
                      <ImageThumb image={image} variant="tool" source={toolUse.toolName ?? 'tool result'} />
                      <div className="min-w-0 font-mono text-[10.5px] leading-[1.7] text-[rgba(160,190,225,.6)]">
                        {image.w && image.h ? (
                          <>
                            {image.w}×{image.h}
                            <br />
                          </>
                        ) : null}
                        {formatBytes(image.bytes)}
                      </div>
                    </div>
                  ))}
                  {toolResult.text ? (
                    <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[10.5px] leading-[1.6] text-[rgba(160,190,225,.75)]">
                      {toolResult.text}
                    </pre>
                  ) : null}
                </div>
              ) : toolUse.toolName === 'Bash' ? (
                <pre
                  className="overflow-x-auto whitespace-pre-wrap font-mono text-[10.5px] leading-[1.6] text-[rgba(160,190,225,.75)]"
                  // eslint-disable-next-line react/no-danger -- ansiToHtml escapes its input before colorizing
                  dangerouslySetInnerHTML={{ __html: ansiToHtml(toolResult.text ?? '') }}
                />
              ) : (
                <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[10.5px] leading-[1.6] text-[rgba(160,190,225,.75)]">
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
