import { tagColor, type Tag } from '../../lib/types'

/** canvas 10i, 10j: the mono caps line heading a menu sheet (the session's title, CHANGE TAG). */
export const SHEET_LABEL = 'px-2.5 pb-2 pt-0.5 font-mono text-[10px] tracking-[0.18em] text-[rgba(160,190,225,.6)]'

/**
 * Change tag, swapped into the ⋯ sheet (canvas 10i, 10j CHANGE TAG): the
 * Mac's tags as rows with their dot, ✓ and a faint fill on the current one.
 * Picking saves and closes; creating or editing tags stays on the Mac.
 */
export function TagSheet({
  tags,
  currentId,
  onPick,
}: {
  tags: readonly Tag[]
  currentId: number | undefined
  onPick: (tagId: number) => void
}) {
  return (
    <>
      <div className={SHEET_LABEL}>CHANGE TAG</div>
      {tags.map((tag) => {
        const current = tag.id === currentId
        return (
          // canvas 10i `tagRows`: the menu row's geometry; the current one tinted and ticked.
          <button
            key={tag.id}
            type="button"
            onClick={() => onPick(tag.id)}
            aria-pressed={current}
            className={[
              'flex h-13 w-full items-center gap-3 rounded-[10px] px-2.5 text-left text-[15px] text-text-bright',
              current ? 'bg-[rgba(150,205,255,.09)]' : '',
            ].join(' ')}
          >
            <span aria-hidden className="grid w-5 place-items-center">
              <span className="block h-2 w-2 rounded-full" style={{ background: tagColor(tag.hue) }} />
            </span>
            <span className="flex-1 truncate">{tag.name}</span>
            <span aria-hidden className={['text-[oklch(85%_.12_205)]', current ? 'opacity-100' : 'opacity-0'].join(' ')}>✓</span>
          </button>
        )
      })}
    </>
  )
}
