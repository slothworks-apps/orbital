import { useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { toggleTag } from '../lib/tagFilter'
import { withViewTransition } from '../lib/viewTransition'
import { Chip } from '../ui/Chip'
import { DragGhost } from '../ui/DragGhost'
import { DropBar } from '../ui/DropBar'
import { useReorderDrag } from '../ui/useReorderDrag'

/** Half the row's 6 px gap: the drop bar stands in the middle of it (canvas `Feature - Tag chips` 80a). */
const BAR_INSET = 3

/**
 * The sidebar's tag filter (canvas `Feature - Tag chips` 80a, spec
 * 2026-10-25-tag-toggles-and-order-design): every chip toggles, ⌘-click
 * shows that one tag alone, Clear ends
 * the row while one is on, and a chip dragged along the row lands in the gap
 * the bar marks — the one tag order every list follows.
 */
export function TagFilterRow({ className }: { className: string }) {
  const tags = useOrbital(useShallow((s) => s.tags))
  const filterTagIds = useOrbital((s) => s.ui.filterTagIds)
  const setFilterTagIds = useOrbital((s) => s.setFilterTagIds)
  const moveTag = useOrbital((s) => s.moveTag)
  const rowRef = useRef<HTMLDivElement>(null)
  const { drag, onPointerDown, swallowClick } = useReorderDrag(rowRef, 'row', BAR_INSET, (from, to) => {
    const tag = tags[from]
    if (tag) void moveTag(tag.id, to)
  })
  const dragged = drag ? tags[drag.from] : undefined

  return (
    <div ref={rowRef} className={['relative', className].join(' ')} role="group" aria-label="Filter by tag">
      {tags.map((tag, idx) => (
        <span
          key={tag.id}
          data-reorder-item
          onPointerDown={(e) => onPointerDown(idx, e)}
          // The chip stays behind as a faint copy of itself while it is dragged (80e).
          className={['inline-flex touch-none', drag?.from === idx ? 'opacity-35' : ''].join(' ')}
        >
          <Chip
            label={tag.name}
            hue={tag.hue}
            activeTint="neutral"
            active={filterTagIds.includes(tag.id)}
            onClick={(e) => {
              if (swallowClick()) return
              // ⌘-click shows this tag alone; a plain click toggles it. Rows
              // that drop out fade where they stand, the rest glide into place (80a).
              const next = e.metaKey || e.ctrlKey ? [tag.id] : toggleTag(filterTagIds, tag.id)
              withViewTransition(() => setFilterTagIds(next))
            }}
          />
        </span>
      ))}
      {filterTagIds.length > 0 && <Chip label="Clear" muted onClick={() => withViewTransition(() => setFilterTagIds([]))} />}
      {drag?.drop && <DropBar bar={drag.drop.bar} />}
      {dragged && drag && (
        <DragGhost ghost={drag.ghost}>
          <Chip label={dragged.name} hue={dragged.hue} lifted />
        </DragGhost>
      )}
    </div>
  )
}
