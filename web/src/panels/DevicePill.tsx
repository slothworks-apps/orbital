import { useState } from 'react'
import { useOrbital } from '../store/store'
import { kindOs, memberOf, pillWords, runsOn, type RunsOn } from '../lib/devices'
import { KindGlyph } from '../ui/KindGlyph'
import type { ApiSession } from '../lib/types'

/** The RUNS ON dot (canvas 50f `fbDot`, `fbDotBd`): the accent while live, a ring while offline, light for an update. */
const DOT_STYLE: Record<RunsOn['dot'], { background: string; border?: string }> = {
  live: { background: 'oklch(85% .12 205)' },
  offline: { background: 'transparent', border: '1.3px solid rgba(200,215,235,.6)' },
  update: { background: 'rgba(232,238,248,.85)' },
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
  const members = useOrbital((s) => s.remote?.group?.members)
  const [hovered, setHovered] = useState(false)
  // Read when the card opens: its `seen 12 min ago` needs no ticking clock.
  const card = hovered ? runsOn(session, members, Date.now()) : null
  const words = pillWords(session, members)
  const kind = memberOf(session, members)?.kind ?? session.machine?.kind ?? 'desktop'

  return (
    <div
      data-device-pill
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      // `orbital-no-drag`: the main window's drag band, and a detached
      // window's title bar, would take the pointer near the top.
      className={[
        'orbital-no-drag z-30 box-border flex h-5 cursor-default items-center gap-1.5 whitespace-nowrap rounded-[10px] border border-solid px-[9px] font-mono text-[10px] text-[rgba(214,230,248,.9)] shadow-[0_6px_18px_rgba(0,0,0,.45)] backdrop-blur-[12px] transition-[background,border-color] duration-[120ms] ease-[ease]',
        placement === 'edge' ? 'absolute top-[-10px] left-[22px]' : 'relative mr-2.5 flex-none',
      ].join(' ')}
      // Canvas 50f `fbBg`/`fbBd`: the tag hue at .1 over the panel's own dark, .18 and .85 on hover.
      style={{
        borderColor: `oklch(80% .13 ${hue} / ${hovered ? 0.85 : 0.55})`,
        background: `linear-gradient(oklch(80% .13 ${hue} / ${hovered ? 0.18 : 0.1}),oklch(80% .13 ${hue} / ${hovered ? 0.18 : 0.1})),rgba(10,15,27,.92)`,
      }}
    >
      <KindGlyph kind={kind} untitled />
      {words}
      {card && (
        // Canvas 50f RUNS ON: under the pill, its left edge on the pill's.
        <div className="absolute top-[calc(100%+8px)] left-[-1px] box-border flex w-[250px] flex-col gap-[5px] whitespace-normal rounded-[10px] border border-solid border-[rgba(150,205,255,.18)] bg-[rgb(10,16,28)] px-[13px] pt-[11px] pb-3 shadow-[0_18px_50px_rgba(0,0,0,.6)]">
          <div className="text-[9.5px] tracking-[0.16em] text-[rgba(160,190,225,.6)]">RUNS ON</div>
          <div className="font-sans text-[12.5px] font-semibold text-[#e8eef8]">{card.name}</div>
          <div className="text-[10px] text-[rgba(160,190,225,.65)]">{kindOs(card.kind, card.os)}</div>
          <div className="flex items-center gap-[7px] text-[10px] text-[rgba(200,220,245,.85)]">
            <span aria-hidden className="box-border block size-1.5 flex-none rounded-full" style={DOT_STYLE[card.dot]} />
            {card.words}
          </div>
        </div>
      )}
    </div>
  )
}
