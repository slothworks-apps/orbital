import { createContext, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital, editDiffsExpanded } from '../store/store'
import type { BackgroundTask, ChatMessage, Subagent } from '../lib/types'
import { opensOutput } from '../lib/backgroundTasks'
import { ansiToHtml } from '../lib/highlight'
import { isPressablePath } from '../lib/pathLinks'
import { changeCounts, describeFileChange } from '../lib/fileEdit'
import { DIFF_ADDED_INK_CLASS, DIFF_REMOVED_INK_CLASS } from '../lib/diff'
import { ChangeView, changeSectionLabel } from './DiffView'
import { formatBytes, formatToolDuration } from '../lib/format'
import { ImageThumb } from './ImageThumb'
import { PathButton, PlainPath } from './PathButton'
import { FileCwdContext, FileMessageContext, fileOpenHandlers, messageImages, useLongPress } from '../lib/fileOpen'

/** Tools whose salient input lives in a `file_path` field. */
const FILE_PATH_TOOLS = new Set(['Read', 'Edit', 'Write'])

/**
 * The tool name a subagent launch shows up under. Mirrors the server's own
 * `SUBAGENT_TOOLS` (`server/src/transcript/subagents.ts`) rather than
 * importing it — `web` and `server` are separate npm workspaces with no
 * shared module for this. The current CLI calls it `Agent`; `Task` is the
 * name an older CLI's transcript, still on disk, used instead (spec
 * 2026-09-22-subagent-transcript-panel-design.md § 5 / task 9 brief).
 */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])

/** What started a row's chip: the subagent or the background task joined on its `toolUseId`. */
export type ToolRowChipTarget = { kind: 'subagent'; subagent: Subagent } | { kind: 'task'; task: BackgroundTask }

/**
 * The phone's seam into the tool row (spec 2026-10-05-mobile-next § 2, § 3).
 * Absent — the desktop and every panel — the row is exactly as it was. Given
 * — the phone's session screen provides it around its transcript — the row
 * draws two things the phone's canvas asks for and the desktop's does not:
 *
 * - under a row that started a subagent or a background task, the 44 px chip
 *   `renderChip` returns (canvas 10g), in place of the inline `OPEN →` /
 *   `OUTPUT →`, which the chip opens instead;
 * - an image result as a full-width preview under the row, open or folded,
 *   with the ⤢ mark (canvas 10d), in place of the 96 px thumbnail in the
 *   expanded body.
 *
 * `panels/` never imports the phone: the phone hands its chip in.
 */
export interface PhoneToolRow {
  renderChip(target: ToolRowChipTarget): ReactNode
}

export const PhoneToolRowContext = createContext<PhoneToolRow | null>(null)

/** Input fields that name a file (spec: 2026-09-19-file-viewer-design §
 * Where paths come from) — pressable in the collapsed label and in the
 * expanded INPUT's pretty-print. */
const PATH_INPUT_FIELDS = new Set(['file_path', 'notebook_path'])

/**
 * The path a tool row can open — in the file viewer, or the lightbox for an
 * image — or null: `file_path` of the `FILE_PATH_TOOLS`, `notebook_path` of
 * NotebookEdit. Known-binary extensions stay plain text — `isPressablePath`
 * decides, same as prose matching.
 */
export function pressablePathOf(toolName: string | undefined, toolInput: unknown): string | null {
  const path = filePathOf(toolName, toolInput)
  return path !== null && isPressablePath(path) ? path : null
}

/** The file a path-bearing tool names, pressable or not. */
function filePathOf(toolName: string | undefined, toolInput: unknown): string | null {
  if (!toolInput || typeof toolInput !== 'object') return null
  const input = toolInput as Record<string, unknown>
  let path: unknown
  if (toolName && FILE_PATH_TOOLS.has(toolName)) path = input.file_path
  else if (toolName === 'NotebookEdit') path = input.notebook_path
  return typeof path === 'string' ? path : null
}

/**
 * How long a tool call took, in ms: the gap between its `tool_use`'s
 * publish `timestamp` and its `tool_result`'s. `undefined` — never `0` —
 * when either side has no timestamp (a transcript from before Task 1, or a
 * frame the SDK gave no time for) or the call hasn't finished yet
 * (`toolResult` absent covers the "still running" case for free, since a
 * running call has no result to carry a timestamp at all), OR the gap
 * comes out negative. A negative gap is not a fast call, it is a clock
 * lying: two timestamps stamped by `new Date().toISOString()`/the SDK's own
 * clock, minutes or hours apart in wall time, can still land end-before-
 * start across an NTP correction or a local clock adjustment mid-session.
 * Clamping that to `0` (an earlier version of this function did) would
 * render `formatToolDuration`'s forbidden fabricated `0s` — the exact lie
 * the brief calls out — just laundered through this function instead of
 * that one. Treating it as unknown, like every other unknown here, is the
 * only option that isn't a guess. Shared by `ToolRow`'s own row and
 * `summarizeToolRun`'s (`TranscriptView.tsx`) sum across a folded run, so
 * the two can never disagree about what counts as "no duration".
 */
export function toolDurationMs(toolUse: ChatMessage, toolResult?: ChatMessage): number | undefined {
  if (!toolUse.timestamp || !toolResult?.timestamp) return undefined
  const start = Date.parse(toolUse.timestamp)
  const end = Date.parse(toolResult.timestamp)
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined
  if (end < start) return undefined
  return end - start
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
  if (toolName && SUBAGENT_TOOLS.has(toolName) && typeof input.description === 'string') {
    return input.description
  }

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
          if (path !== null && isPressablePath(path)) {
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
          // A path the phone can only long-press (`lib/fileOpen.ts`); the
          // desktop configures none and keeps the line as one text node.
          if (path !== null && fileOpenHandlers()?.longPress) {
            return (
              <span key={index}>
                {match[1]}
                <PlainPath path={path}>{match[3]}</PlainPath>
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
  /**
   * The session's own live `subagents` (spec § 5, canvas 11a) — joined
   * against `toolUse.toolUseId` to decide whether THIS row is an
   * `Agent`/`Task` call with a still-reachable live agent behind it, in
   * which case it gains an `OPEN →` control. Omitted (or no match) renders
   * no control at all: `Transcript` (the parent session's own transcript)
   * passes the real list; `SubagentPanel`'s own `TranscriptView` never
   * does, so a nested Agent/Task call inside a subagent's transcript stays
   * a plain row — depth-2 agents have no moon and no panel (spec's own
   * "DEPTH 2" row, out of scope to build here; this is what leaves it
   * alone without special-casing depth).
   */
  subagents?: Subagent[]
  /** Opens the subagent panel for the row's matched agent. Absent alongside
   * `subagents` for the same reason. */
  onOpenSubagent?: (subagent: Subagent) => void
  /** The session's background tasks, for a background `Bash` or `Monitor` row's `OUTPUT →`. */
  backgroundTasks?: BackgroundTask[]
  onOpenTaskOutput?: (task: BackgroundTask) => void
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
export function ToolRow({
  toolUse,
  toolResult,
  subagents,
  onOpenSubagent,
  backgroundTasks,
  onOpenTaskOutput,
}: ToolRowProps) {
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
  // A label that is a path no press can open: on the phone a long-press on
  // the row copies it (`lib/fileOpen.ts`), while a tap still folds the row.
  // Held by the row's own button because the label lets touches through to
  // it. Empty handlers on the desktop.
  const filePath = pressablePath === null ? filePathOf(toolUse.toolName, toolUse.toolInput) : null
  const rowLongPress = useLongPress(filePath !== null && filePath === label ? filePath : null)
  const duration = formatToolDuration(toolDurationMs(toolUse, toolResult))

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
  // The `OPEN →` control (spec § 5, canvas 11a). Joined on `toolUseId`.
  //
  // An ENDED agent still matches and still gets its control: "unlike the
  // moon this is part of the record forever … still reachable after
  // scrolling back through a long session" (spec § 5). Its moon has left
  // the map (subagent list spec § 5), so this row and the detail panel's
  // subagent list are the ways left in — which is why the list this joins
  // against (`sessions[id].subagents`) carries every agent the session ever
  // had. The session list carries only the running ones, but a transcript is
  // only open for the selected session, whose history `select` reads from
  // `GET /api/sessions/:id` (`loadSessionHistory`); `map/sceneModel.ts`
  // narrows it to the running ones.
  //
  // What genuinely renders no control — not a disabled one, since there is
  // nothing to press and nothing to explain — is a row with no match at
  // all: a nested depth-2 call, for which `subagents` is deliberately never
  // passed (see `subagents`' own prop doc), or an agent the server has
  // genuinely forgotten (a restart; `subagents` comes back empty).
  const openableSubagent =
    toolUse.toolName && SUBAGENT_TOOLS.has(toolUse.toolName) && toolUse.toolUseId
      ? subagents?.find((a) => a.toolUseId === toolUse.toolUseId)
      : undefined
  // The same for a background `Bash` or `Monitor` call (26a): its task, joined
  // on the launching call, and `OUTPUT →` when it has output to open.
  const launchesTask = toolUse.toolUseId && (toolUse.toolName === 'Bash' || toolUse.toolName === 'Monitor')
  const openableTask = launchesTask
    ? backgroundTasks?.find((task) => task.toolUseId === toolUse.toolUseId && opensOutput(task))
    : undefined

  // The phone's chip and wide image (`PhoneToolRowContext`). A task chip
  // stands under its row whether or not the task has output to open — it
  // still tells the truth about how the task ended; the chip decides what a
  // press does.
  const phone = useContext(PhoneToolRowContext)
  const chipTarget: ToolRowChipTarget | null = !phone
    ? null
    : openableSubagent && onOpenSubagent
      ? { kind: 'subagent', subagent: openableSubagent }
      : (() => {
          const task = launchesTask && onOpenTaskOutput ? backgroundTasks?.find((t) => t.toolUseId === toolUse.toolUseId) : undefined
          return task ? { kind: 'task', task } : null
        })()
  const wideImages = phone && toolResult?.images?.length ? toolResult.images : null

  return (
    // A path in this call opens from the tree the call was made in.
    <FileCwdContext.Provider value={toolUse.cwd}>
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
          {...rowLongPress}
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
              Orbital does not have.

              Canvas `Feature - Transcript blocks` 20d-G. The counts are the
              one place the diff keeps green and red: they are numbers on the
              row, never on a band, so they cannot be confused with the body's
              luminance system. 20d-G picks these two values specifically to
              clear the experiments tag's green, which the previous `+n`
              sat on top of. */}
          {counts && (counts.added > 0 || counts.removed > 0) && (
            <span data-diff-stat className="shrink-0 tabular-nums">
              {counts.added > 0 && (
                <span className={DIFF_ADDED_INK_CLASS}>+{counts.added}</span>
              )}
              {counts.added > 0 && counts.removed > 0 && ' '}
              {counts.removed > 0 && (
                <span className={DIFF_REMOVED_INK_CLASS}>−{counts.removed}</span>
              )}
            </span>
          )}
          {duration && (
            // Canvas 11b: "Read: eslint.config.js · 0.3s" — the row's own
            // gap between its tool_use and tool_result timestamps. Absent
            // (not "0s") when either side has no timestamp, or the call is
            // still running — see `toolDurationMs`.
            <span className="shrink-0 text-[rgba(160,190,225,.5)]">· {duration}</span>
          )}
          {!phone && openableSubagent && onOpenSubagent && (
            // Canvas 11a: `oklch(85% .12 205)`, tracked .12em. A sibling of
            // the expand button (not inside it) for the same reason
            // `PathButton` is — its own press, not the row's toggle.
            <span className="pointer-events-auto shrink-0">
              <button
                type="button"
                data-open-subagent
                aria-label={`Open subagent transcript: ${openableSubagent.name}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onOpenSubagent(openableSubagent)
                }}
                className="font-mono text-[10.5px] tracking-[0.12em] text-[oklch(85%_0.12_205)] hover:underline"
              >
                OPEN →
              </button>
            </span>
          )}
          {!phone && openableTask && onOpenTaskOutput && (
            <span className="pointer-events-auto shrink-0">
              <button
                type="button"
                data-open-task-output
                aria-label={`Open output: ${openableTask.label}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onOpenTaskOutput(openableTask)
                }}
                className="font-mono text-[10.5px] tracking-[0.12em] text-[oklch(85%_0.12_205)] hover:underline"
              >
                OUTPUT →
              </button>
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

      {phone && chipTarget && phone.renderChip(chipTarget)}
      {wideImages && toolResult && (
        // Canvas 10d: the phone shows what a call made right under its row,
        // full width; a press opens the viewer at it, paging through the
        // result's images.
        <FileMessageContext.Provider value={{ messageId: toolResult.id, images: messageImages(toolResult) }}>
          <div className="flex flex-col gap-2 px-2.5 pb-2.5">
            {wideImages.map((image) => (
              <ImageThumb key={image.ref} image={image} messageId={toolResult.id} variant="tool-wide" source={toolUse.toolName ?? 'tool result'} />
            ))}
          </div>
        </FileMessageContext.Provider>
      )}

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
          {/* A file change that went through says nothing its diff does
              not ("has been updated successfully"); only a failed one's
              result — the error — is worth the space. */}
          {toolResult && (!change || failed) && !(wideImages && !toolResult.text) && (
            <div>
              <SectionLabel>RESULT</SectionLabel>
              {wideImages ? (
                // The images already stand under the row (above); the text is what is left.
                <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[10.5px] leading-[1.6] text-[rgba(160,190,225,.75)]">
                  {toolResult.text}
                </pre>
              ) : toolResult.images?.length ? (
                // An image result is a body under the row, like a <pre>
                // output block (canvas 7b): 96px thumb, mono readout beside
                // it — dimensions and size are all an image block carries.
                // The phone's viewer pages through the result's images
                // (`lib/fileOpen.ts`); the desktop provides nothing.
                <FileMessageContext.Provider
                  value={fileOpenHandlers() ? { messageId: toolResult.id, images: messageImages(toolResult) } : null}
                >
                <div className="flex flex-col gap-2">
                  {toolResult.images.map((image) => (
                    <div key={image.ref} className="flex items-start gap-2.5">
                      <ImageThumb
                        image={image}
                        messageId={toolResult.id}
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
                </FileMessageContext.Provider>
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
    </FileCwdContext.Provider>
  )
}
