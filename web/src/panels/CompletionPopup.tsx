import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { KeyboardEvent as ReactKeyboardEvent, Ref, RefObject } from 'react'
import { api } from '../lib/api'
import { matchCommands } from '../lib/commandMatch'
import { formatBytes } from '../lib/format'
import { useEscapeLayer } from '../ui/escapeLayer'
import { usePopupPosition } from '../ui/usePopupPosition'
import { usePresence } from '../ui/usePresence'
import { EXITING } from '../ui/motion'
import type { CompletionContext } from '../lib/composerTokens'
import type { CommandSource, CompletionKey, FileCompletionEntry, SlashCommand } from '../lib/types'

/**
 * The composer's completion list (spec: 2026-09-20-composer-design §
 * Completion popup; canvas 9b).
 *
 * Focus never leaves the textarea. The list is a `role="listbox"` of
 * `role="option"` rows wired to the field with `aria-activedescendant`, and
 * every key it owns arrives through the field: the composer offers each
 * keydown to `handleKeyDown` first and the popup answers whether it took it.
 * That is the only arrangement in which a completion list cannot steal the
 * caret, and it is why this is not built on `ui/Select` — that control's whole
 * contract is that focus sits on ITS trigger.
 */

/** 6 rows × 40px, then it scrolls (canvas 9b KEYBOARD, 9e METRICS). */
const VISIBLE_ROWS = 6
const ROW_HEIGHT_PX = 40
/** 8px between the well and the popup (canvas 9e: popup gap / placement). */
const POPUP_GAP = 8
/** Open .12s with a 4px rise, close .09s, opacity only (canvas 9e). */
const OPEN_MS = 120
const CLOSE_MS = 90
/**
 * Path probes are debounced per keystroke. 90ms is a judgement call — the
 * canvas only says "debounced": long enough that a burst of typing makes one
 * request, short enough that the list still feels like it is tracking the
 * field rather than catching up with it.
 */
const FILE_DEBOUNCE_MS = 90

/** Right-hand badge copy, verbatim from canvas 9b. */
function sourceLabel(source: CommandSource, name: string): string {
  switch (source) {
    case 'project':
      return 'project .claude'
    case 'user':
      return 'user ~/.claude'
    case 'plugin': {
      // Plugin commands are named `plugin:skill` (spec § Command catalog), so
      // the badge can name the plugin. Without the prefix it stays generic
      // rather than inventing one.
      const plugin = name.includes(':') ? name.slice(0, name.indexOf(':')) : null
      return plugin ? `plugin: ${plugin}` : 'plugin'
    }
    case 'built-in':
      return 'built-in'
  }
}

type Row =
  | {
      kind: 'command'
      /** Slug without its leading slash. */
      name: string
      description: string
      source: CommandSource
      insert: string
      keepOpen: false
    }
  | {
      kind: 'file'
      entry: FileCompletionEntry
      /** Directory part of the prefix these entries were read for ('' at the root). */
      dir: string
      insert: string
      keepOpen: boolean
    }

export interface CompletionHandle {
  /** Offers one keydown to the popup; true when the popup consumed it. */
  handleKeyDown: (e: ReactKeyboardEvent) => boolean
}

export interface CompletionPopupProps {
  /** The composer decides when the list is wanted; the popup animates itself out. */
  open: boolean
  /** The well — the popup matches its width and hangs off its edge (canvas 9e). */
  anchorRef: RefObject<HTMLElement | null>
  /** What is being completed at the caret. */
  context: CompletionContext
  /** Which session or directory the completions resolve against. */
  sessionKey: CompletionKey
  /** The catalog, fetched and cached by the composer (it needs it for the tint too). */
  commands: readonly SlashCommand[] | null
  /** Above on the panel floor, below in the dialog (canvas 9b / 9d). */
  placement: 'above' | 'below'
  /** `id` of the listbox, minted by the composer so it can point at it. */
  listboxId: string
  /** Replaces the typed fragment. `keepOpen` for a directory — the one case ⏎ does not close. */
  onAccept: (insert: string, keepOpen: boolean) => void
  /** Escape only. No match closes by rendering nothing, which is not the same thing. */
  onClose: () => void
  /** Keeps the field's `aria-activedescendant` pointing at the selected row. */
  onActiveDescendantChange: (id: string | null) => void
  ref?: Ref<CompletionHandle>
}

export function CompletionPopup({
  open,
  anchorRef,
  context,
  sessionKey,
  commands,
  placement,
  listboxId,
  onAccept,
  onClose,
  onActiveDescendantChange,
  ref,
}: CompletionPopupProps) {
  const popupRef = useRef<HTMLDivElement | null>(null)
  const optionId = (index: number) => `${listboxId}-opt-${index}`
  const { kind, prefix } = context
  // A stable string for the effect deps — the key object is rebuilt on every
  // render by the mount above, and its identity means nothing.
  const keyId = 'session' in sessionKey ? `s:${sessionKey.session}` : `c:${sessionKey.cwd}`

  /**
   * The last settled answer for a path prefix, prefix included. Keeping the
   * prefix with the entries is what stops a row from being inserted against a
   * fragment it was never read for, and lets the list keep showing the
   * previous answer for the ~90ms a new one is in flight instead of blinking
   * through empty.
   */
  const [files, setFiles] = useState<{ prefix: string; entries: FileCompletionEntry[] } | null>(null)

  useEffect(() => {
    if (!open || kind !== 'file') return
    let cancelled = false
    const timer = setTimeout(() => {
      api
        .filesComplete(sessionKey, prefix)
        .then((entries) => {
          if (!cancelled) setFiles({ prefix, entries })
        })
        .catch(() => {
          // A failed probe is "nothing to offer", not an error surface: the
          // popup closes and the user keeps typing the path by hand.
          if (!cancelled) setFiles({ prefix, entries: [] })
        })
    }, FILE_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // `sessionKey` is covered by `keyId`; depending on the object would refire
    // every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind, prefix, keyId])

  // A closed popup, or one that switched kind, must not reopen onto the last
  // answer for a different fragment.
  useEffect(() => {
    if (!open || kind !== 'file') setFiles(null)
  }, [open, kind])

  const rows = useMemo<Row[]>(() => {
    if (kind === 'command') {
      if (!commands) return []
      return matchCommands(commands, prefix).map((c) => ({
        kind: 'command' as const,
        name: c.name,
        description: c.description,
        source: c.source,
        insert: `/${c.name}`,
        keepOpen: false as const,
      }))
    }
    if (!files) return []
    const dir = files.prefix.slice(0, files.prefix.lastIndexOf('/') + 1)
    // Directories first (canvas 9b), otherwise the server's own alphabetical
    // order — a stable sort keeps it.
    return [...files.entries]
      .sort((a, b) => (a.dir === b.dir ? 0 : a.dir ? -1 : 1))
      .map((entry) => ({
        kind: 'file' as const,
        entry,
        dir,
        insert: `@${dir}${entry.name}${entry.dir ? '/' : ''}`,
        keepOpen: entry.dir,
      }))
  }, [kind, prefix, commands, files])

  const [selected, setSelected] = useState(0)
  // Rows swapping is a new list, so the selection returns to the top (9e:
  // "rows swap instantly, and selection resets to row 0").
  const rowsKey = rows.map((r) => r.insert).join('\u0000')
  useEffect(() => {
    setSelected(0)
  }, [rowsKey])

  const hasRows = rows.length > 0
  const shown = open && hasRows
  const { mounted, state } = usePresence(shown, OPEN_MS, CLOSE_MS)

  // Innermost escape layer, and only while the list is actually on screen: a
  // popup with nothing in it must not eat the press that closes the panel
  // (canvas 9e "esc, twice").
  useEscapeLayer(shown, onClose)

  useEffect(() => {
    onActiveDescendantChange(shown ? optionId(selected) : null)
    // `optionId` is derived from `listboxId`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, selected, listboxId, onActiveDescendantChange])
  useEffect(() => () => onActiveDescendantChange(null), [onActiveDescendantChange])

  usePopupPosition(mounted, anchorRef, popupRef, {
    gap: POPUP_GAP,
    prefer: placement,
    matchAnchorWidth: true,
  })

  // Keeps the selected row in view. `auto`, never smooth (9e: "scrolling the
  // list to keep it visible is auto, never smooth"). jsdom has no
  // `scrollIntoView`, hence the optional call.
  useLayoutEffect(() => {
    if (!shown) return
    document.getElementById(optionId(selected))?.scrollIntoView?.({ block: 'nearest' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, selected, listboxId])

  const accept = useCallback(
    (index: number) => {
      const row = rows[index]
      if (row) onAccept(row.insert, row.keepOpen)
    },
    [onAccept, rows],
  )

  useImperativeHandle(
    ref,
    () => ({
      handleKeyDown(e: ReactKeyboardEvent) {
        if (!shown) return false
        // A chord is never the list's: ⌘⏎ is the dialog's launch, and ⇧⏎ is
        // the panel's newline. The list owns the bare keys only.
        if (e.metaKey || e.ctrlKey || e.altKey) return false
        const last = rows.length - 1
        switch (e.key) {
          case 'ArrowDown':
            e.preventDefault()
            setSelected((i) => (i >= last ? 0 : i + 1))
            return true
          case 'ArrowUp':
            e.preventDefault()
            setSelected((i) => (i <= 0 ? last : i - 1))
            return true
          case 'Enter':
            if (e.shiftKey) return false
            e.preventDefault()
            accept(selected)
            return true
          case 'Tab':
            if (e.shiftKey) return false
            // Accept, and keep focus where it is — Tab out of a field with an
            // open list would leave the list pointing at nothing.
            e.preventDefault()
            accept(selected)
            return true
          default:
            return false
        }
      },
    }),
    [shown, rows.length, selected, accept],
  )

  if (!mounted) return null

  const entering = state === 'entering'
  const exiting = state === 'exiting'
  const total = kind === 'command' ? (commands?.length ?? 0) : rows.length
  const dirLabel = kind === 'file' && files ? files.prefix.slice(0, files.prefix.lastIndexOf('/') + 1) : ''

  return createPortal(
    <div
      ref={popupRef}
      data-completion-popup
      // Canvas 9b draws the popup literally: 10px radius, a flat
      // rgba(10,16,28,.96) fill, a .16 hairline and one soft drop shadow.
      // Portalled to <body> for the same reason ui/Select is — a Panel's
      // backdrop-filter becomes the containing block for fixed children, and
      // the panel clips its own overflow.
      className={[
        'fixed z-[60] flex flex-col overflow-hidden',
        'rounded-[10px] border border-[rgba(150,205,255,.16)] bg-[rgba(10,16,28,.96)]',
        'shadow-[0_26px_70px_rgba(0,0,0,.6)]',
        // 9e: open .12s cubic-bezier(.2,.9,.25,1), opacity with a 4px rise;
        // close .09s ease, opacity only. One duration and one easing at a
        // time — two of either would resolve by stylesheet order (web/CLAUDE.md).
        'motion-safe:transition-[opacity,translate]',
        exiting
          ? 'opacity-0 translate-y-0 motion-safe:duration-[90ms] motion-safe:ease-[ease]'
          : 'motion-safe:duration-[120ms] motion-safe:ease-[cubic-bezier(.2,.9,.25,1)]',
        !exiting && entering ? 'opacity-0 translate-y-1' : '',
        !exiting && !entering ? 'opacity-100 translate-y-0' : '',
        exiting ? EXITING : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* Header rail — 8px/12px over a .08 hairline, mono 9.5 tracked .14em (9b). */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[rgba(150,205,255,.08)] px-3 py-2 font-mono text-[9.5px] tracking-[0.14em] text-[rgba(160,190,225,.5)]">
        {kind === 'command' ? 'COMMANDS' : `FILES${dirLabel ? ` · ${dirLabel}` : ''}`}
        <span aria-hidden className="flex-1" />
        {rows.length} OF {total}
      </div>

      <div
        role="listbox"
        id={listboxId}
        aria-label="Completions"
        // 6 rows at 40px, then it scrolls (9b/9e).
        style={{ maxHeight: `${VISIBLE_ROWS * ROW_HEIGHT_PX}px` }}
        className="flex min-h-0 flex-col overflow-y-auto overscroll-contain"
      >
        {rows.map((row, index) => {
          const isSelected = index === selected
          return (
            <div
              key={row.insert}
              id={optionId(index)}
              role="option"
              aria-selected={isSelected}
              data-selected={isSelected}
              // 9b rows: 40px minimum, 6px/12px padding, 10px gap. Selected
              // takes the .14 fill, a 2px accent rail inset on the left, and a ✓.
              className={[
                'flex min-h-10 shrink-0 cursor-pointer items-center gap-2.5 px-3 py-1.5',
                isSelected
                  ? 'bg-[rgba(150,205,255,.14)] shadow-[inset_2px_0_0_var(--color-accent)]'
                  : '',
              ]
                .filter(Boolean)
                .join(' ')}
              // The list must never take focus off the field.
              onMouseDown={(e) => e.preventDefault()}
              // No hover preselect — it is out of scope (spec SCOPE), and the
              // click accepts the row it landed on rather than the selection,
              // so the pointer never needs to move the keyboard's place.
              onClick={() => accept(index)}
            >
              {row.kind === 'command' ? (
                <>
                  <div className="min-w-0 flex-1">
                    <div
                      className={`font-mono text-[12px] ${isSelected ? 'text-[#f2f9ff]' : 'text-text-bright'}`}
                    >
                      /{row.name}
                    </div>
                    {row.description && (
                      <div
                        className={`text-[10.5px] leading-[1.35] ${
                          isSelected ? 'text-[rgba(200,220,245,.7)]' : 'text-[rgba(160,190,225,.6)]'
                        }`}
                      >
                        {row.description}
                      </div>
                    )}
                  </div>
                  <span
                    className={`shrink-0 whitespace-nowrap font-mono text-[9px] tracking-[0.1em] ${
                      isSelected ? 'text-[rgba(190,215,240,.6)]' : 'text-[rgba(160,190,225,.45)]'
                    }`}
                  >
                    {sourceLabel(row.source, row.name)}
                  </span>
                </>
              ) : (
                <>
                  {/* 9b marks: a folder (12×10, a thick top edge) or a file
                      (12×12 square). `block`, because an inline span has no
                      size (web/CLAUDE.md). */}
                  {row.entry.dir ? (
                    <span
                      aria-hidden
                      className="block h-[10px] w-3 shrink-0 rounded-[2px] border border-t-[3px] border-[rgba(190,215,240,.55)]"
                    />
                  ) : (
                    <span
                      aria-hidden
                      className="block h-3 w-3 shrink-0 rounded-[2px] border border-[rgba(160,190,225,.28)]"
                    />
                  )}
                  <span
                    className={`min-w-0 truncate font-mono text-[12px] ${
                      isSelected ? 'text-[#f2f9ff]' : 'text-text-bright'
                    }`}
                  >
                    {row.entry.name}
                    {row.entry.dir && (
                      <span data-dir-slash className="text-[oklch(88%_.1_205)]">
                        /
                      </span>
                    )}
                  </span>
                  {row.dir && (
                    <span className="shrink-0 font-mono text-[10.5px] text-[rgba(160,190,225,.5)]">
                      {row.dir}
                    </span>
                  )}
                  <span aria-hidden className="flex-1" />
                  <span
                    className={`shrink-0 whitespace-nowrap font-mono text-[9.5px] tracking-[0.1em] ${
                      isSelected ? 'text-[rgba(190,215,240,.6)]' : 'text-[rgba(160,190,225,.45)]'
                    }`}
                  >
                    {row.entry.dir
                      ? // 9b prints `DIR · 24 ITEMS`; the wire only carries a
                        // count when the server has one, and an invented
                        // number is worse than a bare mark.
                        row.entry.size !== undefined
                        ? `DIR · ${row.entry.size} ITEMS`
                        : 'DIR'
                      : formatBytes(row.entry.size ?? 0)}
                  </span>
                </>
              )}
              {isSelected && (
                <span aria-hidden className="shrink-0 text-[11px] text-accent">
                  ✓
                </span>
              )}
            </div>
          )
        })}
      </div>

      {/* Footer rail — 7px/12px, mono 9.5 tracked .1em (9b/9e). */}
      <div className="flex shrink-0 items-center gap-2 border-t border-[rgba(150,205,255,.08)] px-3 py-[7px] font-mono text-[9.5px] tracking-[0.1em] text-[rgba(160,190,225,.45)]">
        ↑↓ MOVE · ⏎ OR TAB ACCEPT · ESC CLOSE
      </div>
    </div>,
    document.body,
  )
}
