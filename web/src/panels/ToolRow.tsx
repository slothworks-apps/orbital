import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital, editDiffsExpanded } from '../store/store'
import type { ChatMessage } from '../lib/types'
import { ansiToHtml } from '../lib/highlight'
import { hasTextExtension } from '../lib/pathLinks'
import { formatBytes } from '../lib/format'
import { changeCounts, describeFileChange } from '../lib/fileEdit'
import { ChangeView, changeSectionLabel } from './DiffView'
import { ImageThumb } from './ImageThumb'
import { PathButton } from './PathButton'

/** Tools whose salient input lives in a `file_path` field. */
const FILE_PATH_TOOLS = new Set(['Read', 'Edit', 'Write'])

/** Input fields that name a file (spec: 2026-09-19-file-viewer-design §
 * Where paths come from) — pressable in the collapsed label and in the
 * expanded INPUT's pretty-print. */
const PATH_INPUT_FIELDS = new Set(['file_path', 'notebook_path'])

/**
 * The path a tool row can open in the file viewer, or null: `file_path` of
 * the `FILE_PATH_TOOLS`, `notebook_path` of NotebookEdit. Image and
 * known-binary extensions stay plain text — the whitelist in
 * `hasTextExtension` decides, same as prose matching.
 */
export function pressablePathOf(toolName: string | undefined, toolInput: unknown): string | null {
  if (!toolInput || typeof toolInput !== 'object') return null
  const input = toolInput as Record<string, unknown>
  let path: unknown
  if (toolName && FILE_PATH_TOOLS.has(toolName)) path = input.file_path
  else if (toolName === 'NotebookEdit') path = input.notebook_path
  if (typeof path !== 'string' || !hasTextExtension(path)) return null
  return path
}

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

/** One JSON-escaped `"file_path": "…"` (or notebook_path) line of the
 * pretty-printed input. Captures indentation+key prefix, the escaped value
 * and the closing quote/comma so the value alone can become a button. */
const PATH_FIELD_LINE = /^(\s*"(file_path|notebook_path)": ")(.*)(",?)$/

/**
 * The expanded INPUT block (canvas 8a's INPUT frame): the pretty-printed
 * JSON with the path fields' values rendered as `PathButton`s — everything
 * else in the JSON stays text. Line-based on the `JSON.stringify` output,
 * which is safe because escaping keeps every value on one line; a value
 * whose unescape fails, or whose extension is not text, stays text too.
 */
function InputJson({ input }: { input: unknown }) {
  // `stringify(undefined)` is undefined, not a string — a tool_use with no
  // input at all used to render an empty <pre> and still must.
  const json = JSON.stringify(input, null, 2) ?? ''
  const lines = json.split('\n')
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[10.5px] leading-[1.6] text-[rgba(160,190,225,.75)]">
      {lines.map((line, index) => {
        const trailing = index < lines.length - 1 ? '\n' : ''
        const match = PATH_FIELD_LINE.exec(line)
        if (match && PATH_INPUT_FIELDS.has(match[2])) {
          let path: string | null = null
          try {
            path = JSON.parse(`"${match[3]}"`) as string
          } catch {
            // Malformed capture (shouldn't happen for stringify output) — text.
          }
          if (path !== null && hasTextExtension(path)) {
            return (
              // A static line list: the index is a stable key.
              <span key={index}>
                {match[1]}
                <PathButton path={path} variant="input" />
                {match[4]}
                {trailing}
              </span>
            )
          }
        }
        // A static line list: the index is a stable key.
        return <span key={index}>{line + trailing}</span>
      })}
    </pre>
  )
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
  const settings = useOrbital(useShallow((s) => s.settings))
  // `null` means "nobody has touched this row", which is what lets the setting
  // still govern it. The first click writes a boolean and the row keeps that
  // choice from then on, so changing the setting never reaches back and closes
  // something the reader deliberately opened (canvas `Feature - Transcript
  // blocks` 20f: "rows you've toggled by hand keep your choice").
  const [override, setOverride] = useState<boolean | null>(null)
  const running = !toolResult
  const label = salientInput(toolUse.toolName, toolUse.toolInput)
  // The collapsed label's path span becomes a PathButton only when the
  // salient input IS the path — for the path-bearing tools that is always
  // the case, and anything else keeps today's plain bright span.
  const pathInput = pressablePathOf(toolUse.toolName, toolUse.toolInput)
  const pressablePath = pathInput !== null && pathInput === label ? pathInput : null

  // An editing tool's expanded body is its diff, not its input JSON (spec:
  // 2026-09-23-edit-diffs-in-the-transcript) — the JSON was where reviewing a
  // change used to mean reading `old_string` and `new_string` side by side in
  // a `<pre>`. Memoised on the input object because the transcript re-renders
  // on every websocket message and the diff is real work; `describeFileChange`
  // caches the diff itself as well, so a remount is free too.
  const failed = toolResult?.isError === true
  const change = useMemo(
    () => describeFileChange(toolUse.toolName, toolUse.toolInput, toolResult?.text, failed),
    [toolUse.toolName, toolUse.toolInput, toolResult?.text, failed],
  )
  // Memoised alongside the change: a created file's count is a split of the
  // whole content, which is not something to redo on every frame either.
  const counts = useMemo(() => (change ? changeCounts(change) : null), [change])

  // Only a row that has a change to show can arrive open: the setting is about
  // edit diffs, and auto-opening a Bash call's input JSON is not what anyone
  // asked for. The companion "expand under a pending permission" setting is
  // not read here — a call its session is parked on never reaches `ToolRow`,
  // `groupToolRuns` having routed it to a `PermissionCard` instead, which is
  // where that setting is honoured.
  const autoOpen = change !== null && editDiffsExpanded(settings)
  const expanded = override ?? autoOpen
  // Open because it arrived that way, not because anyone opened it — which is
  // what makes the body a preview rather than the whole change.
  const preview = expanded && override === null

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
      {/* Two sibling interactive elements — a nested <button> inside the
          expand button would be invalid HTML, so the expand button covers
          the header as an absolute layer and the visible line sits over it
          with pointer-events off, except the PathButton, which takes its
          own presses (spec § Tool rows, canvas 8a). While the path is
          hovered or focused the row's own hover styling is suppressed, so
          the two targets never both look armed (8e "press vs. toggle") —
          the :has() guards below drop the fill while the path is hovered
          or holds keyboard focus. */}
      <div
        data-tool-header
        className="relative [&:hover:not(:has([data-path-button]:hover)):not(:has([data-path-button]:focus-visible))]:bg-white/5"
      >
        <button
          type="button"
          onClick={() => setOverride(!expanded)}
          aria-expanded={expanded}
          aria-label={`${toolUse.toolName ?? 'Tool'}${label ? `: ${label}` : ''}`}
          className="absolute inset-0 h-full w-full"
        />
        <div className="pointer-events-none relative flex w-full items-center gap-2 px-2.5 py-[7px] text-left font-mono text-[11.5px] text-[rgba(200,220,245,.8)]">
          <span aria-hidden className="text-[rgba(160,190,225,.6)]">
            {expanded ? '▾' : '▸'}
          </span>
          <span aria-hidden className="text-[rgba(160,190,225,.6)]">
            ⚙
          </span>
          <span className="min-w-0 flex-1 truncate">
            {toolUse.toolName}
            {label ? ': ' : ''}
            {pressablePath ? (
              <span className="pointer-events-auto">
                <PathButton path={pressablePath} variant="row" />
              </span>
            ) : (
              <span className="text-text-bright">{label}</span>
            )}
          </span>
          {/* The skim line: how much this call changed, without opening it.
              Each side appears only when it is non-zero — a new file has
              nothing removed, and `−0` would read as a claim about a side
              Orbital does not have. */}
          {counts && (counts.added > 0 || counts.removed > 0) && (
            <span data-diff-stat className="shrink-0 tabular-nums">
              {counts.added > 0 && (
                <span className="text-[oklch(78%_.13_145)]">+{counts.added}</span>
              )}
              {counts.added > 0 && counts.removed > 0 && ' '}
              {counts.removed > 0 && (
                <span className="text-[oklch(74%_.14_22)]">−{counts.removed}</span>
              )}
            </span>
          )}
          {running && (
            <span
              data-testid="tool-running-dot"
              aria-label="running"
              aria-hidden
              className="orbital-pulse h-1.5 w-1.5 shrink-0 rounded-full bg-text-soft"
            />
          )}
        </div>
      </div>

      {expanded && (
        <div className="flex flex-col gap-2 border-t border-[rgba(150,205,255,.08)] px-3 pb-2.5 pt-2">
          <div>
            <SectionLabel>{change ? changeSectionLabel(change, failed) : 'INPUT'}</SectionLabel>
            {change ? (
              <ChangeView change={change} isError={failed} preview={preview} />
            ) : (
              <InputJson input={toolUse.toolInput} />
            )}
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
                      <ImageThumb
                        image={image}
                        variant="tool"
                        source={toolUse.toolName ?? 'tool result'}
                      />
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
                  // `ansiToHtml` escapes its input before colorizing.
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
