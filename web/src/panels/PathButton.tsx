import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { fileOpenHandlers, useFileCwd, useFileMessage, useFindsByName, useLongPress, useMessageId } from '../lib/fileOpen'
import { GAVE_UP, outcomeOf, usePendingPress, type FoundFile } from '../lib/findByName'
import { isMediaPath } from '../lib/pathLinks'
import { insideWorkspace, relativeUnder, treeRoots } from '../lib/pathMenu'
import { ideHere } from '../lib/devices'
import { workingDirOf } from '../lib/types'
import { leafOf } from '../lib/whereForm'
import { MediaViewer } from './MediaViewer'
import { PathMenu, type PathMenuProps } from './PathMenu'

/**
 * The pressable file path (spec: 2026-09-19-file-viewer-design § The
 * pressable path; canvas 8a/8e). One component used by all three sites —
 * tool-row labels, expanded INPUT values and assistant prose. A
 * `<span role="button">` in tab order (⏎/space opens), `stopPropagation` on
 * press so the row it sits in never toggles. Not a `<button>`: a button is
 * never truly inline, so a path longer than the line turned into a centred
 * block of its own instead of wrapping with the sentence around it.
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
 *
 * ## A bare name, and the right-click
 *
 * Spec 2026-11-02-bare-file-names-and-path-menu-design, canvas `Feature - Path
 * menu glyphs`. A `bare` path is a file name with no directory, from a code
 * span: a press asks the server where it lies first, holding the pressed pill
 * meanwhile and the ellipsis past `FIND_PENDING_MS` (1e); one match opens as
 * its full path would, several or none open the chooser under the link (1c).
 * A right-click on any path opens its menu at the pointer (1b), on the
 * desktop only — the phone keeps its long-press.
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
const IDE_SUFFIX_CLASS = 'pl-2 font-mono fs-10 text-ink-900/55'

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
  /** `path` is a bare file name, looked up on a press (`data-bare` from `rehypePathLinks`). */
  bare?: boolean
}

const VARIANT_CLASSES: Record<PathButtonVariant, string> = {
  // 8a collapsed-row label: #e8eef8 ink over the row's own mono type.
  row: 'mx-[-5px] px-[5px] py-px text-ink-100',
  // 8a INPUT frame: the value's slightly softer ink, same box.
  input: 'mx-[-5px] px-[5px] py-px text-ink-200/90',
  // 8a assistant prose: mono 11.5px inside 13px prose, tighter box.
  prose: 'mx-[-4px] px-[4px] py-px font-mono fs-11.5 text-ink-100',
  // Inside an inline code chip, which already sets the type and the box:
  // only the ink and a hit pad that stays within the chip's padding.
  code: 'mx-[-2px] px-[2px] py-0 text-ink-100',
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
  // `ideHere`: another device's session has no editor here to send a path to.
  const ideName = useOrbital((s) =>
    s.ui.selectedId ? (ideHere(s.sessions[s.ui.selectedId])?.ideName ?? null) : null
  )
  const workspaceRoot = useOrbital((s) =>
    s.ui.selectedId ? (ideHere(s.sessions[s.ui.selectedId])?.workspaceRoot ?? null) : null
  )
  return { ideName, workspaceRoot }
}

export function PathButton({ path, line = null, variant = 'row', suffix, bare = false }: PathButtonProps) {
  const openFile = useOrbital((s) => s.openFile)
  const openInIde = useOrbital((s) => s.openInIde)
  const { ideName, workspaceRoot } = useSelectedIde()
  // The tree the message this path sits in was written in, when it sits in
  // one (spec 2026-10-07-live-working-tree-design § 4) — read against there.
  const cwd = useFileCwd()
  // OPEN state (8e): the path whose file is currently open renders dimmed,
  // no underline emphasis, and pressing it is a no-op. The same path written
  // in another tree is another file.
  const isOpen = useOrbital((s) => s.ui.fileViewer?.path === path && s.ui.fileViewer.cwd === cwd)
  const lineSuffix = suffix ?? (line !== null ? `:${line}` : '')

  const [hovered, setHovered] = useState(false)
  const [held, setHeld] = useState(false)
  /** The editor the last ⌥-click or menu row sent the file to, while its receipt holds. */
  const [receipt, setReceipt] = useState<string | null>(null)
  // An image or PDF path opens the media view in place instead of the text
  // viewer, on that item of the session's media (spec
  // 2026-10-09-session-media-design); it is not a viewer state, so it lives
  // here rather than in the store. The path it opens on: the one written, or
  // where a bare name was found.
  const media = isMediaPath(path)
  const [mediaPath, setMediaPath] = useState<string | null>(null)
  const buttonRef = useRef<HTMLSpanElement | null>(null)
  // The wait for the server: a bare name's lookup, or a right-click locating the file.
  const pending = usePendingPress()
  // The chooser or the menu, while open. `n` keys each opening, so a second
  // right-click is a new menu, back on its first view.
  const [popup, setPopup] = useState<(Pick<PathMenuProps, 'at' | 'start' | 'picks'> & { n: number }) | null>(null)
  const retry = useRef<() => void>(() => {})
  const selectedId = useOrbital((s) => s.ui.selectedId)
  const receiptTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The phone's seam (`lib/fileOpen.ts`): when configured, a press goes to
  // its handler instead of the viewer or the media view, and a long-press is
  // its own gesture. Unconfigured, all three are inert.
  const routed = fileOpenHandlers()
  const fileMessage = useFileMessage()
  const messageId = useMessageId()
  const longPress = useLongPress(routed ? path : null)
  // Redraws when the answer changes: the phone learns its Mac's version from a hello that can come after the transcript.
  const findsByName = useFindsByName(bare)

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

  function showReceiptFor(editor: string) {
    setReceipt(editor)
    if (receiptTimer.current) clearTimeout(receiptTimer.current)
    receiptTimer.current = setTimeout(() => setReceipt(null), IDE_RECEIPT_MS)
  }

  function openPopup(next: Pick<PathMenuProps, 'at' | 'start' | 'picks'>) {
    setPopup((prev) => ({ ...next, n: (prev?.n ?? 0) + 1 }))
  }

  /** What the chooser's facts name: the directory looked in, and the device asked. */
  function lookupFacts() {
    const session = selectedId ? useOrbital.getState().sessions[selectedId] : undefined
    return {
      // 1c NO MATCH names the directory by its last segment: `web/`.
      under: `${leafOf(cwd ?? (session ? workingDirOf(session) : ''))}/`,
      device: session?.machine?.name || 'This Mac',
    }
  }

  const findTask = () =>
    selectedId ? api.findFiles(selectedId, path, cwd).catch(() => null) : Promise.resolve(null)

  /** Opens `target` as a press on it would: the media view, else the viewer. */
  function openHere(target: string) {
    if (isMediaPath(target)) setMediaPath(target)
    else openFile(target, line, cwd)
  }

  /** The phone's press, on `target`: the path as written, or where a bare name was found. */
  function openRouted(target: string) {
    routed?.open({ kind: 'path', path: target, line, messageId: fileMessage?.messageId, ...(cwd ? { cwd } : {}) })
  }

  /**
   * A press on a bare name (spec § What a press does): the lookup, then the
   * one match opened, the chooser under the link, or — refused by a Mac
   * without the route — the name opened as written, as before.
   */
  function pressBare() {
    retry.current = pressBare
    setPopup(null)
    pending.run(buttonRef.current, findTask, (answer) => {
      const outcome = outcomeOf(answer, path, lookupFacts())
      const open = (target: string) => (routed ? openRouted(target) : openHere(target))
      if (outcome.kind === 'as-written') return open(path)
      if (outcome.kind === 'open') return open(outcome.file.path)
      if (routed) {
        routed.choose?.({ choice: outcome.choice, open: (file: FoundFile) => openRouted(file.path), retry: pressBare })
        return
      }
      const at = buttonRef.current?.closest('code') ?? buttonRef.current
      if (at) openPopup({ at, start: { kind: 'choose', choice: outcome.choice }, picks: 'open' })
    })
  }

  /** The menu for the path as written, once the server has said where it lies. */
  function menuAsWritten(at: { x: number; y: number }) {
    const task = () =>
      selectedId ? api.locateFile(selectedId, path, cwd).catch(() => null) : Promise.resolve(null)
    pending.run(buttonRef.current, task, (found) => {
      const absolute = found === GAVE_UP ? null : found
      const session = selectedId ? useOrbital.getState().sessions[selectedId] : undefined
      openPopup({
        at,
        picks: 'actions',
        start: {
          kind: 'file',
          file: absolute
            ? { path: absolute, located: true, relative: session ? relativeUnder(absolute, treeRoots(session)) : null }
            : { path, located: false, relative: null },
        },
      })
    })
  }

  /**
   * A right-click (spec § The context menu), the desktop's alone. A bare name
   * is looked up first: one match shows its actions, several the chooser.
   * `preventDefault` also keeps the document's own text menu away.
   */
  function onMenu(event: ReactMouseEvent) {
    event.preventDefault()
    event.stopPropagation()
    const at = { x: event.clientX, y: event.clientY }
    const open = () => {
      retry.current = open
      setPopup(null)
      if (!bare) return menuAsWritten(at)
      pending.run(buttonRef.current, findTask, (answer) => {
        const outcome = outcomeOf(answer, path, lookupFacts())
        if (outcome.kind === 'as-written') return menuAsWritten(at)
        if (outcome.kind === 'open') {
          const { path: found, relative } = outcome.file
          return openPopup({ at, picks: 'actions', start: { kind: 'file', file: { path: found, located: true, relative } } })
        }
        openPopup({ at, picks: 'actions', start: { kind: 'choose', choice: outcome.choice } })
      })
    }
    open()
  }

  // The gesture is armed only where it could do something (canvas 20d, "only
  // when it'd work"). `isOpen` is left out on purpose: the file being open in
  // the viewer says nothing about whether it is worth opening in the editor,
  // so the dead press belongs to the plain click alone.
  // A bare name is not a path an editor can open until it is looked up.
  const reachable =
    !bare && ideName !== null && workspaceRoot !== null && insideWorkspace(path, workspaceRoot)
  const armed = reachable && held && hovered

  const showReceipt = receipt !== null
  // 20d writes the destination after the path while ⌥ is held, and replaces
  // it with the receipt on the press.
  const destination = showReceipt
    ? `opened in ${receipt}`
    : armed
      ? `↗ ${ideName}`
      : null

  // 1e: the pressed pill holds from the press until the answer replaces it,
  // and while the chooser or the menu it opened stands (1a's held chip).
  const holding = pending.phase !== 'idle' || popup !== null

  // The phone, against a Mac without the lookup: the name is drawn as it was
  // before bare names were pressable — text, never a link that fails.
  if (bare && !findsByName) {
    return (
      <>
        {path}
        {lineSuffix}
      </>
    )
  }

  const button = (
    <span
      ref={buttonRef}
      role="button"
      tabIndex={0}
      data-path-button
      data-bare={bare || undefined}
      data-pending={pending.phase !== 'idle' || undefined}
      data-open={isOpen || undefined}
      data-ide-armed={armed || undefined}
      data-ide-receipt={showReceipt || undefined}
      data-variant={routed ? variant : undefined}
      onPointerDown={longPress.onPointerDown}
      onPointerUp={longPress.onPointerUp}
      onPointerCancel={longPress.onPointerCancel}
      onContextMenu={routed ? longPress.onContextMenu : onMenu}
      onClickCapture={longPress.onClickCapture}
      onPointerEnter={(event) => {
        setHovered(true)
        setHeld(event.altKey)
      }}
      onPointerMove={(event) => {
        setHeld(event.altKey)
        longPress.onPointerMove?.(event)
      }}
      onPointerLeave={() => {
        setHovered(false)
        setHeld(false)
        longPress.onPointerLeave?.()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        // As a native button's Enter did: the click keeps ⌥, so ⌥⏎ still opens the editor.
        event.currentTarget.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, altKey: event.altKey, metaKey: event.metaKey, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey }),
        )
      }}
      onClick={(event) => {
        event.stopPropagation()
        if (bare) {
          pressBare()
          return
        }
        if (routed) {
          openRouted(path)
          return
        }
        // The modifier wins over everything, the OPEN state included: the
        // two destinations are different places, so a path already showing
        // in the viewer is still worth sending to the editor.
        if (reachable && event.altKey) {
          event.preventDefault()
          void openInIde(path, line).then((opened) => {
            if (opened && ideName !== null) showReceiptFor(ideName)
          })
          return
        }
        if (media) {
          setMediaPath(path)
          return
        }
        if (isOpen) return
        openFile(path, line, cwd)
      }}
      className={[
        'group/path relative inline rounded-[4px] underline underline-offset-2 [overflow-wrap:anywhere] box-decoration-clone',
        '[font:inherit] transition-[background-color,color,text-decoration-color] duration-[120ms] ease-[ease]',
        VARIANT_CLASSES[variant],
        armed
          ? // 20d ⌥+HOVER: the hover FILL is dropped — it is not the viewer
            // any more — and what is left is the solid accent underline over
            // bright ink. Dropping the fill is the whole tell: the same
            // gesture with a different destination, not a harder hover.
            'cursor-pointer text-ink-100 decoration-solid decoration-accent'
          : showReceipt
            ? // 20d AFTER ⌥-CLICK: the span reads at rest again while the
              // receipt holds beside it. The pointer is usually still on the
              // path, so the hover emphasis has to be suppressed rather than
              // merely not applied.
              'cursor-pointer decoration-dotted decoration-line/30'
            : holding
              ? // 1e PRESS: the pressed pill, a hover that stays.
                'cursor-pointer bg-line/16 text-ink-50 decoration-solid decoration-accent/80'
            : isOpen
              ? // 8e OPEN: dimmed pill, faded dotted underline, dead press.
                'cursor-default bg-line/6 text-ink-500/60 decoration-dotted decoration-line/20'
              : [
                  'cursor-pointer decoration-dotted decoration-line/30',
                  'hover:bg-line/12 hover:text-ink-50 hover:decoration-solid hover:decoration-accent/80',
                  'active:bg-line/18',
                  'focus-visible:bg-line/8 focus-visible:shadow-[0_0_0_2px_color-mix(in_oklab,var(--color-accent)_55%,transparent)] focus-visible:outline-none',
                ].join(' '),
      ].join(' ')}
    >
      {path}
      {lineSuffix && (
        <span
          className={
            isOpen && !armed && !showReceipt
              ? 'text-ink-900/60'
              : 'text-ink-900/60 group-hover/path:text-ink-700/75'
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
      {/* 1e STILL WAITING: a static ellipsis just past the chip, faded in
          over 200 ms once the wait passes FIND_PENDING_MS. Hung off the
          link, so nothing around it moves; no pulse, no spinner. The chip's
          own padding past this button's edge, plus 1e's 3px, sets it off. */}
      {bare && (
        <span
          aria-hidden
          className={[
            'pointer-events-none absolute left-full top-0 ml-[5px] text-ink-900/70 no-underline',
            pending.phase === 'slow' ? 'opacity-100 transition-opacity duration-200 ease-[ease]' : 'opacity-0',
          ].join(' ')}
        >
          …
        </span>
      )}
    </span>
  )

  if (routed) return button
  return (
    <>
      {button}
      {/* The views portal out of the DOM but not out of React's event tree:
          without this, a click on a backdrop or a menu row would bubble to
          the tool row the path sits in and toggle it. */}
      <span onClick={(event) => event.stopPropagation()} onContextMenu={(event) => event.stopPropagation()}>
        {media && (
          <MediaViewer
            open={mediaPath !== null}
            sessionId={selectedId}
            target={{ kind: 'path', path: mediaPath ?? path, cwd, messageId: fileMessage?.messageId ?? messageId }}
            onClose={() => setMediaPath(null)}
          />
        )}
        {popup && (
          <PathMenu
            key={popup.n}
            at={popup.at}
            start={popup.start}
            picks={popup.picks}
            sessionId={selectedId}
            line={line}
            onOpen={(file) => openHere(file.path)}
            onRetry={() => retry.current()}
            onEditorOpened={showReceiptFor}
            onClose={() => setPopup(null)}
          />
        )}
      </span>
    </>
  )
}

/**
 * A path no press can open (`isPressablePath` false) at a site that would
 * otherwise draw a `PathButton`. Unconfigured — the desktop — it is the bare
 * text it always was. With a `longPress` configured (the phone, spec
 * 2026-10-05-mobile-next § 8 Decision 8) it is a plain mono span carrying
 * that one gesture: never a link, never anything a tap does.
 */
export function PlainPath({ path, children }: { path: string; children?: ReactNode }) {
  const longPress = useLongPress(fileOpenHandlers()?.longPress ? path : null)
  const text = children ?? path
  if (!longPress.onPointerDown) return <>{text}</>
  return (
    <span data-path-plain className="font-mono" {...longPress}>
      {text}
    </span>
  )
}
