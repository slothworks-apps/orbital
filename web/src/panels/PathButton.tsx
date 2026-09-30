import { useEffect, useRef, useState } from 'react'
import { useOrbital } from '../store/store'

/**
 * The pressable file path (spec: 2026-09-19-file-viewer-design § The
 * pressable path; canvas 8a/8e). One component used by all three sites —
 * tool-row labels, expanded INPUT values and assistant prose. A real
 * `<button>` in tab order (⏎/space opens), `stopPropagation` on press so
 * the row it sits in never toggles.
 *
 * Canvas 8e: hit pad `1px 5px`, radius 4, negative margin `0 -5px` so row
 * metrics hold; resting dotted underline `rgba(150,205,255,.3)` at 2px
 * offset; hover pill `rgba(150,205,255,.12)` + solid `oklch(85% .12 205/.8)`
 * underline at `.12s ease` (faster than the row's `.16s` — the smaller
 * target answers first); active fill `.18`; focus ring
 * `0 0 0 2px oklch(85% .12 205 / .55)`.
 *
 * ## Opening in the editor is the modifier's meaning, not the click's
 *
 * Spec 2026-09-23-ide-bridge-design § Talking back to the editor, canvas
 * `Feature - IDE bridge.dc.html` artboard 20d. The file viewer stays what a
 * press means; holding {@link IDE_MODIFIER_LABEL} while pressing sends the
 * path to the editor instead. A held modifier rather than a second control:
 * a path appears dozens of times in one transcript, and a button beside
 * every one of them would cost more than the secondary action is worth.
 *
 * The gesture appears ONLY when the selected session reports an editor. With
 * none, the modifier does nothing, nothing is drawn differently, and the
 * component is exactly what it was before this existed.
 */

/** How long the press's receipt stays up (canvas 20d, 20f: "holds 1.6s"). */
export const IDE_RECEIPT_MS = 1600

/**
 * The held modifier, and what it is called in the one place the gesture is
 * taught (the file viewer's header link).
 *
 * Option rather than ⌘, per canvas 20d's own reasoning: ⌘-click already means
 * "new window" to hands trained by browsers, while ⌥ is free across the panel
 * and is JetBrains' own "alternate" key.
 */
export const IDE_MODIFIER_LABEL = '⌥'

/**
 * Canvas 20d, the ⌥ suffix and the receipt that replaces it: mono 10px in
 * `rgba(160,190,225,.55)`, 8px after the path. 20f's metrics table confirms
 * both, and records "new colours: none" — every value here is already in the
 * panel's vocabulary.
 */
const IDE_SUFFIX_CLASS = 'pl-2 font-mono text-[10px] text-[rgba(160,190,225,.55)]'

/** Where the button sits — only ink and box metrics differ (canvas 8a). */
export type PathButtonVariant = 'row' | 'input' | 'prose' | 'code'

export interface PathButtonProps {
  /** The path as written — shown verbatim and sent to the store on press. */
  path: string
  /** Parsed `:line` target, if the site carried one. */
  line?: number | null
  variant?: PathButtonVariant
  /**
   * Display suffix after the path (`:42`, or `:42:7` from a prose match —
   * the column stays in the hit area even though only the line is kept).
   * Defaults to `:line` when a line is set.
   */
  suffix?: string
}

const VARIANT_CLASSES: Record<PathButtonVariant, string> = {
  // 8a collapsed-row label: #e8eef8 ink over the row's own mono type.
  row: 'mx-[-5px] px-[5px] py-px text-[#e8eef8]',
  // 8a INPUT frame: the value's slightly softer ink, same box.
  input: 'mx-[-5px] px-[5px] py-px text-[rgba(220,235,255,.9)]',
  // 8a assistant prose: mono 11.5px inside 13px prose, tighter box.
  prose: 'mx-[-4px] px-[4px] py-px font-mono text-[11.5px] text-[#e8eef8]',
  // Inside an inline code chip, which already sets the type and the box:
  // only the ink and a hit pad that stays within the chip's padding.
  code: 'mx-[-2px] px-[2px] py-0 text-[#e8eef8]',
}

/**
 * The two facts the gesture needs about the editor covering the selected
 * session. Read off the session shape rather than fetched: it is live state of
 * the directory, republished whenever an editor comes or goes, so the gesture
 * appears and disappears on its own (adr `orbital-speaks-to-the-ide-itself`).
 *
 * Two string selectors rather than one for the `ide` object, deliberately.
 * The session republishes on every SELECTION change — which is every caret
 * move in the editor — and each republish is a new object, so selecting the
 * object would re-render every path in the transcript at typing speed. The
 * strings compare equal and nothing re-renders.
 */
function useSelectedIde(): { ideName: string | null; workspaceRoot: string | null } {
  const ideName = useOrbital((s) =>
    s.ui.selectedId ? (s.sessions[s.ui.selectedId]?.ide?.ideName ?? null) : null
  )
  const workspaceRoot = useOrbital((s) =>
    s.ui.selectedId ? (s.sessions[s.ui.selectedId]?.ide?.workspaceRoot ?? null) : null
  )
  return { ideName, workspaceRoot }
}

/**
 * Canvas 20d, "only when it'd work": ⌥ does nothing and shows nothing unless
 * an editor window's workspace contains that file.
 *
 * A relative path is one the session wrote about its own `cwd`, which sits
 * inside the workspace by construction — so only an absolute path is checked,
 * and only against the root the editor reported.
 */
function insideWorkspace(path: string, workspaceRoot: string): boolean {
  if (!path.startsWith('/')) return true
  return path === workspaceRoot || path.startsWith(`${workspaceRoot}/`)
}

export function PathButton({ path, line = null, variant = 'row', suffix }: PathButtonProps) {
  const openFile = useOrbital((s) => s.openFile)
  const openInIde = useOrbital((s) => s.openInIde)
  const { ideName, workspaceRoot } = useSelectedIde()
  // OPEN state (8e): the path whose file is currently open renders dimmed,
  // no underline emphasis, and pressing it is a no-op.
  const isOpen = useOrbital((s) => s.ui.fileViewer?.path === path)
  const lineSuffix = suffix ?? (line !== null ? `:${line}` : '')

  const [hovered, setHovered] = useState(false)
  const [held, setHeld] = useState(false)
  const [receipt, setReceipt] = useState(false)
  const receiptTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Only while the pointer is over this path, so one listener exists at a
  // time no matter how many paths a transcript carries. The pointer events
  // below seed the state, because a modifier already down when the pointer
  // arrives raises no keydown of its own.
  useEffect(() => {
    if (!hovered || ideName === null) return
    const read = (event: KeyboardEvent) => setHeld(event.altKey)
    const drop = () => setHeld(false)
    window.addEventListener('keydown', read)
    window.addEventListener('keyup', read)
    // A modifier held while the window loses focus never reports its keyup.
    window.addEventListener('blur', drop)
    return () => {
      window.removeEventListener('keydown', read)
      window.removeEventListener('keyup', read)
      window.removeEventListener('blur', drop)
    }
  }, [hovered, ideName])

  useEffect(
    () => () => {
      if (receiptTimer.current) clearTimeout(receiptTimer.current)
    },
    []
  )

  // The gesture is armed only where it could do something (canvas 20d, "only
  // when it'd work"). `isOpen` is left out on purpose: the file being open in
  // the viewer says nothing about whether it is worth opening in the editor,
  // so the dead press belongs to the plain click alone.
  const reachable =
    ideName !== null && workspaceRoot !== null && insideWorkspace(path, workspaceRoot)
  const armed = reachable && held && hovered

  const showReceipt = receipt && ideName !== null
  // 20d writes the destination after the path while ⌥ is held, and replaces
  // it with the receipt on the press.
  const destination = showReceipt
    ? `opened in ${ideName}`
    : armed
      ? `↗ ${ideName}`
      : null

  return (
    <button
      type="button"
      data-path-button
      data-open={isOpen || undefined}
      data-ide-armed={armed || undefined}
      data-ide-receipt={showReceipt || undefined}
      onPointerEnter={(event) => {
        setHovered(true)
        setHeld(event.altKey)
      }}
      onPointerMove={(event) => setHeld(event.altKey)}
      onPointerLeave={() => {
        setHovered(false)
        setHeld(false)
      }}
      onClick={(event) => {
        event.stopPropagation()
        // The modifier wins over everything, the OPEN state included: the
        // two destinations are different places, so a path already showing
        // in the viewer is still worth sending to the editor.
        if (reachable && event.altKey) {
          event.preventDefault()
          void openInIde(path, line).then((opened) => {
            if (!opened) return
            setReceipt(true)
            if (receiptTimer.current) clearTimeout(receiptTimer.current)
            receiptTimer.current = setTimeout(() => setReceipt(false), IDE_RECEIPT_MS)
          })
          return
        }
        if (isOpen) return
        openFile(path, line)
      }}
      className={[
        'group/path inline rounded-[4px] border-0 bg-transparent underline underline-offset-2',
        '[font:inherit] transition-[background-color,color,text-decoration-color] duration-[120ms] ease-[ease]',
        VARIANT_CLASSES[variant],
        armed
          ? // 20d ⌥+HOVER: the hover FILL is dropped — it is not the viewer
            // any more — and what is left is the solid accent underline over
            // bright ink. Dropping the fill is the whole tell: the same
            // gesture with a different destination, not a harder hover.
            'cursor-pointer text-[#e8eef8] decoration-solid decoration-[oklch(85%_.12_205)]'
          : showReceipt
            ? // 20d AFTER ⌥-CLICK: the span reads at rest again while the
              // receipt holds beside it. The pointer is usually still on the
              // path, so the hover emphasis has to be suppressed rather than
              // merely not applied.
              'cursor-pointer decoration-dotted decoration-[rgba(150,205,255,.3)]'
            : isOpen
              ? // 8e OPEN: dimmed pill, faded dotted underline, dead press.
                'cursor-default bg-[rgba(150,205,255,.06)] text-[rgba(200,220,245,.6)] decoration-dotted decoration-[rgba(150,205,255,.2)]'
              : [
                  'cursor-pointer decoration-dotted decoration-[rgba(150,205,255,.3)]',
                  'hover:bg-[rgba(150,205,255,.12)] hover:text-[#f2f9ff] hover:decoration-solid hover:decoration-[oklch(85%_.12_205_/_.8)]',
                  'active:bg-[rgba(150,205,255,.18)]',
                  'focus-visible:bg-[rgba(150,205,255,.08)] focus-visible:shadow-[0_0_0_2px_oklch(85%_.12_205_/_.55)] focus-visible:outline-none',
                ].join(' '),
      ].join(' ')}
    >
      {path}
      {lineSuffix && (
        <span
          className={
            isOpen && !armed && !showReceipt
              ? 'text-[rgba(160,190,225,.45)]'
              : 'text-[rgba(160,190,225,.6)] group-hover/path:text-[rgba(190,215,240,.75)]'
          }
        >
          {lineSuffix}
        </span>
      )}
      {/* 20d: the destination while ⌥ is held, then the receipt for the
          press. Both hang off the path rather than replacing it — the path is
          what the person is reading, and swapping it out would move every
          glyph after it. Muted (`.55`) because it is a label on the gesture,
          not a second thing to read. */}
      {destination && (
        <span data-ide-destination className={IDE_SUFFIX_CLASS}>
          {destination}
        </span>
      )}
    </button>
  )
}
