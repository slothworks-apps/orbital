import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useCommand } from '../lib/commands'
import { shortcutLabel } from '../lib/keymap'
import { mediaCountLine, mediaTiles, toolMediaCount } from '../lib/media'
import type { MediaItem } from '../lib/types'
import { useHideTool, useMedia, useSessionMedia } from '../store/media'
import { useEscapeLayer } from '../ui/escapeLayer'
import { POPUP_SHELL } from '../ui/usePopupPosition'
import { HideToolChip, MediaTileButton, OnlyToolHidden } from './MediaParts'
import { MediaViewer } from './MediaViewer'

/**
 * ▦ — the session's media as a header readout (canvas `Feature - Media`
 * 24b, 24h A). A fact about the session like its folder and branch, so it
 * sits on that line, after them. A glyph only: no count, and no state when
 * nothing has arrived — it is simply absent then, and simply there at rest
 * once the first item lands, with no fade, pulse or highlight
 * (`docs/why-orbital.md`, Calm).
 *
 * A press opens the glance popover: the latest tiles, the Hide tool images
 * switch, and Open gallery. While the gallery shows, the readout wears its
 * active chip and a press returns to the transcript.
 */

/** 24b: the glance holds the latest 8 tiles, 4 to a row. */
const GLANCE_TILES = 8
/** 24b: the popover is the panel's width less 14px either side, 5px under the readout. */
const POPOVER_INSET_PX = 14
const POPOVER_GAP_PX = 5

/** 24b: 2×2 squares of 4px, 1.5px apart — the header's box-built glyph grammar. */
function MediaGlyph() {
  return (
    <span aria-hidden className="grid grid-cols-[4px_4px] gap-[1.5px]">
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className="block h-1 w-1 rounded-[1px] bg-current" />
      ))}
    </span>
  )
}

export function MediaReadout({ sessionId, onScreen }: { sessionId: string; onScreen: boolean }) {
  const [open, setOpen] = useState(false)
  const gallery = useMedia((s) => s.gallery === sessionId)
  const items = useSessionMedia(sessionId, open || gallery)
  const [viewing, setViewing] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const has = (items?.length ?? 0) > 0

  const toggleGallery = useCallback(() => {
    setOpen(false)
    const media = useMedia.getState()
    media.setGallery(media.gallery === sessionId ? null : sessionId)
  }, [sessionId])
  // ⇧⌘G does nothing without media (24h A).
  useCommand('session.media', toggleGallery, onScreen && has)

  useEffect(() => {
    setOpen(false)
  }, [sessionId])

  if (!has && !gallery) return null
  const active = open || gallery

  return (
    <span className="ml-2.5 flex flex-none">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Media of this session"
        aria-expanded={open}
        aria-pressed={gallery}
        title={gallery ? 'Back to the transcript' : `Media · ${shortcutLabel('session.media')}`}
        onClick={() => (gallery ? toggleGallery() : setOpen((v) => !v))}
        className={[
          'orbital-no-drag -my-[3px] grid h-[22px] w-[22px] place-items-center rounded-[5px] border p-0 transition-[border-color] duration-[160ms] ease-[ease]',
          active
            ? 'border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)] text-[#e8eef8]'
            : 'border-[rgba(150,205,255,.14)] bg-transparent text-[rgba(200,220,245,.75)] hover:border-[rgba(150,205,255,.3)]',
        ].join(' ')}
      >
        <MediaGlyph />
      </button>
      {open && items && (
        <GlancePopover
          sessionId={sessionId}
          items={items}
          triggerRef={triggerRef}
          onClose={() => setOpen(false)}
          onOpenGallery={toggleGallery}
          onOpenItem={(item) => {
            setOpen(false)
            setViewing(item.id)
          }}
        />
      )}
      <MediaViewer
        open={viewing !== null}
        sessionId={sessionId}
        target={viewing ? { kind: 'item', id: viewing } : null}
        onClose={() => setViewing(null)}
      />
    </span>
  )
}

/** 24b: the dropdown shell, hung under the readout across the panel's width. */
function GlancePopover({
  sessionId,
  items,
  triggerRef,
  onClose,
  onOpenGallery,
  onOpenItem,
}: {
  sessionId: string
  items: MediaItem[]
  triggerRef: RefObject<HTMLButtonElement | null>
  onClose: () => void
  onOpenGallery: () => void
  onOpenItem: (item: MediaItem) => void
}) {
  const popupRef = useRef<HTMLDivElement | null>(null)
  const [hideTool, setHideTool] = useHideTool(sessionId)
  useEscapeLayer(true, onClose)

  // Placed off the panel, not the trigger: 24b spans the panel less its inset.
  useLayoutEffect(() => {
    const place = () => {
      const trigger = triggerRef.current
      const popup = popupRef.current
      if (!trigger || !popup) return
      const bound = trigger.closest('[data-media-bound]')?.getBoundingClientRect()
      const anchor = trigger.getBoundingClientRect()
      const left = bound ? bound.left + POPOVER_INSET_PX : anchor.right - popup.offsetWidth
      popup.style.top = `${anchor.bottom + POPOVER_GAP_PX}px`
      popup.style.left = `${left}px`
      if (bound) popup.style.width = `${bound.width - 2 * POPOVER_INSET_PX}px`
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  })

  // `pointerdown`, like the menus: a click would land after the next control had been pressed.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) return
      onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [onClose, triggerRef])

  const tiles = mediaTiles(items, hideTool).slice(0, GLANCE_TILES)
  const tool = toolMediaCount(items)

  return createPortal(
    <div
      ref={popupRef}
      role="dialog"
      aria-label="Media"
      className={['orbital-no-drag fixed z-[60] w-[422px] overflow-hidden', POPUP_SHELL].join(' ')}
    >
      <div className="flex items-center gap-2 border-b border-[rgba(150,205,255,.08)] px-3 py-[9px] font-mono text-[9.5px] tracking-[0.14em] text-[rgba(160,190,225,.6)]">
        <span className="min-w-0 flex-1 truncate">{mediaCountLine(items, hideTool)}</span>
        {tool > 0 && <HideToolChip on={hideTool} onToggle={() => setHideTool(!hideTool)} />}
      </div>
      {tiles.length > 0 || !hideTool || tool === 0 ? (
        <div className="grid grid-cols-4 gap-[5px] px-3 py-2.5">
          {tiles.map((tile) => (
            <MediaTileButton key={tile.key} sessionId={sessionId} tile={tile} variant="glance" onOpen={onOpenItem} />
          ))}
        </div>
      ) : (
        <OnlyToolHidden hidden={tool} onShow={() => setHideTool(false)} className="h-[118px]" />
      )}
      <button
        type="button"
        onClick={onOpenGallery}
        className="flex w-full items-center gap-2 border-t border-[rgba(150,205,255,.08)] px-3 py-[9px] text-left font-mono text-[10.5px] text-[#e8eef8] transition-colors duration-[160ms] hover:bg-[rgba(150,205,255,.09)]"
      >
        Open gallery
        <span className="flex-1" />
        <span className="text-[rgba(160,190,225,.5)]">
          latest {GLANCE_TILES} · {shortcutLabel('session.media')}
        </span>
      </button>
    </div>,
    document.body,
  )
}
