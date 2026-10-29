import { useState } from 'react'
import { useOrbital } from '../store/store'
import { deviceKind, kindOs, pillWords, runsOn, type RunsOn } from '../lib/devices'
import { KindGlyph } from '../ui/KindGlyph'
import { MemberDot, type MemberDotState } from '../ui/MemberDot'
import { Tooltip } from '../ui/Tooltip'
import type { ApiSession } from '../lib/types'

/** Canvas 50f RUNS ON's width. */
const RUNS_ON_WIDTH_PX = 250

/** RUNS ON's dot (canvas 50f `fbDot`, `fbDotBd`): the accent while live, a ring while offline, light for an update. */
const RUNS_ON_DOT: Record<RunsOn['dot'], MemberDotState> = { live: 'online', offline: 'offline', update: 'update' }

/**
 * Canvas 50f RUNS ON: the device's name, kind and OS, and its state. Mounted
 * only while the card is up, so the roster is read only then; its `seen 12
 * min ago` is read when it opens and needs no ticking clock.
 */
function RunsOnCard({ session }: { session: ApiSession }) {
  const members = useOrbital((s) => s.remote?.group?.members)
  const [openedAt] = useState(() => Date.now())
  const card = runsOn(session, members, openedAt)
  return (
    <span className="flex flex-col gap-[5px] font-mono">
      <span className="fs-9.5 tracking-[0.16em] text-[rgba(160,190,225,.6)]">RUNS ON</span>
      <span className="font-sans fs-12.5 font-semibold text-[#e8eef8]">{card.name}</span>
      <span className="fs-10 text-[rgba(160,190,225,.65)]">{kindOs(card.kind, card.os)}</span>
      <span className="flex items-center gap-[7px] fs-10 text-[rgba(200,220,245,.85)]">
        <MemberDot state={RUNS_ON_DOT[card.dot]} sizePx={6} />
        {card.words}
      </span>
    </span>
  )
}

/**
 * The device a session runs on (canvas 50f): a 20 px pill riding the
 * panel's top edge, half on it, at the header's left padding, in the
 * session's tag hue — it covers the tag glint there and carries it on.
 * Hovering raises RUNS ON: the device's name, kind and OS, and its state.
 *
 * `edge` is the docked panel's top edge. A detached window has no edge
 * above the panel to ride (the window ends there, and its traffic lights
 * sit where the pill would), so there the pill sits `inline` in the title
 * bar, ahead of the path. Either way the caller mounts it outside the
 * panel's clipping shell or in a row that does not clip (web/CLAUDE.md →
 * "An overlay dies inside an overflow: hidden").
 */
export function DevicePill({
  session,
  hue,
  placement,
}: {
  session: ApiSession
  /** The session's tag hue (`tagColor`'s), for the border and the fill. */
  hue: number
  placement: 'edge' | 'inline'
}) {
  const [hovered, setHovered] = useState(false)
  // The pill's words and glyph as strings, so they settle: `remote` is
  // replaced on every status publish. The roster itself only while the card
  // is open (`RunsOnCard`).
  const words = useOrbital((s) => pillWords(session, s.remote?.group?.members))
  const kind = useOrbital((s) => deviceKind(session, s.remote?.group?.members))

  return (
    // The hover is the whole box, card included, so the pill stays lit while
    // the pointer is on the card under it.
    <div
      data-device-pill
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      // `orbital-no-drag`: the main window's drag band, and a detached
      // window's title bar, would take the pointer near the top.
      className={[
        'orbital-no-drag z-30 flex',
        placement === 'edge' ? 'absolute top-[-10px] left-[22px]' : 'relative mr-2.5 flex-none',
      ].join(' ')}
    >
      <Tooltip variant="panel" shell="flyout" widthPx={RUNS_ON_WIDTH_PX} content={<RunsOnCard session={session} />}>
        <div
          className="box-border flex h-fit min-h-5 cursor-default items-center gap-1.5 whitespace-nowrap rounded-[10px] border border-solid px-[9px] font-mono fs-10 text-[rgba(214,230,248,.9)] shadow-[0_6px_18px_rgba(0,0,0,.45)] backdrop-blur-[12px] transition-[background,border-color] duration-[120ms] ease-[ease]"
          // Canvas 50f `fbBg`/`fbBd`: the tag hue at .1 over the panel's own dark, .18 and .85 on hover.
          style={{
            borderColor: `oklch(80% .13 ${hue} / ${hovered ? 0.85 : 0.55})`,
            background: `linear-gradient(oklch(80% .13 ${hue} / ${hovered ? 0.18 : 0.1}),oklch(80% .13 ${hue} / ${hovered ? 0.18 : 0.1})),rgba(10,15,27,.92)`,
          }}
        >
          <KindGlyph kind={kind} untitled />
          {words}
        </div>
      </Tooltip>
    </div>
  )
}
