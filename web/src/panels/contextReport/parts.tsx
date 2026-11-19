import { useCallback, useState, type CSSProperties } from 'react'
import {
  formatShare,
  formatReportTokens,
  type BreakdownGroup,
  type BreakdownItem,
  type BreakdownSection,
  type CategorySlot,
  type ContextReportView,
  type ReserveRow,
} from '../../lib/contextReport'
import { copyToClipboard } from '../../lib/clipboard'
import { swatch } from '../../lib/palette'
import type { ContextReport } from '../../lib/types'
import { contextLevelOklch, oklchCss, type ContextLevel, type ContextThresholds } from '../../lib/usage'
import { useLongPressAction } from '../../lib/fileOpen'
import { Button } from '../../ui/Button'
import { REVIEW_SCROLLBAR } from '../../ui/Dialog'

/*
 * The pieces of the `/context` report, drawn the same on the Mac's dialog and
 * the phone's sheet (canvas `Feature - Context report` 70a–70f); `phone`
 * steps the rows up to 70f's touch sizes. Every value is read off the canvas.
 */

/** A category's colour: its fixed slot (70e, `--data-1` … `--data-7` in `theme.css`). */
export const slotColour = (slot: CategorySlot): string => `var(--data-${slot})`

/** The fill's colour: the gauge's, exactly as the arc and the detail panel's bar (adr `the-context-gauge-is-a-traffic-light`). */
export const gaugeColour = (level: ContextLevel): string => oklchCss(contextLevelOklch(level))

/** 70b: past the second mark the figure goes back to ink beside the red fill. */
export const figureInk = (level: ContextLevel): string => (level === 'critical' ? swatch('ink-100') : gaugeColour(level))

/** 70e: the autocompact buffer's hatch. */
const HATCH = `repeating-linear-gradient(135deg,${swatch('line', 0.5)} 0 1.5px,transparent 1.5px 4.5px)`
const ring = (alpha: number): string => `inset 0 0 0 1px ${swatch('line', alpha)}`

/** 70c's footer line, and the phone's line under As text. */
export function snapshotLine(time: string | null): string {
  return `${time ? `a snapshot from ${time}` : 'a snapshot'} · it doesn’t update · run /context again for a new one`
}

const MONO_CAPTION = 'font-mono fs-9.5 tracking-[0.14em] text-ink-900/45'
const SQUARE = 'block h-2.5 w-2.5 flex-none rounded-[2.5px] box-border'

/** 70c: the figure, used / window, the model (Mac) and the over-limit line. */
export function Headline({ report, view, phone }: { report: ContextReport; view: ContextReportView; phone: boolean }) {
  const gauge = gaugeColour(view.level)
  return (
    <>
      <div className="flex items-center gap-3">
        <span className={SQUARE} style={{ background: gauge }} />
        <span
          className={`whitespace-nowrap font-mono leading-none font-medium tracking-[-0.02em] ${phone ? 'fs-28' : 'fs-30'}`}
          style={{ color: figureInk(view.level) }}
        >
          {report.percentage} %
        </span>
        <span className="flex min-w-0 flex-col gap-[3px]">
          <span className="whitespace-nowrap font-mono fs-13 text-ink-100">
            {formatReportTokens(report.totalTokens)} / {formatReportTokens(report.rawMaxTokens)}
          </span>
          <span className="whitespace-nowrap fs-11.5 text-ink-900/60">{view.windowNoun}</span>
        </span>
        {!phone && report.model && (
          <>
            <span className="flex-1" />
            <span className="whitespace-nowrap rounded-[5px] border border-line/18 bg-space/50 px-[9px] py-1 font-mono fs-10.5 text-ink-100">
              {report.model}
            </span>
          </>
        )}
      </div>
      {view.overLine && (
        <div className="-mt-1 flex items-center gap-2 font-mono fs-11 text-ink-100">
          <span className={SQUARE} style={{ border: `1.5px solid ${gauge}` }} />
          {view.overLine}
        </div>
      )}
    </>
  )
}

/**
 * 70e's two bars: the window at true scale — used in the gauge colour, free
 * as an empty track, the buffer hatched at its end, the thresholds marked
 * above — and, carried down by a tapered band, the used part spread to full
 * width in category colours.
 */
export function WindowChart({
  report,
  view,
  thresholds,
}: {
  report: ContextReport
  view: ContextReportView
  thresholds: ContextThresholds
}) {
  const gauge = gaugeColour(view.level)
  const fill = view.fill * 100
  return (
    <div className="flex flex-col">
      <div className={`relative h-4 ${MONO_CAPTION}`}>
        <span className="absolute left-0 top-0">WINDOW · {formatReportTokens(report.rawMaxTokens)}</span>
        {[thresholds.warn, thresholds.critical].map((mark) => (
          <span key={mark}>
            <span className="absolute top-px -translate-x-1/2 tracking-[0.02em]" style={{ left: `${mark}%` }}>
              {mark}
            </span>
            <span className="absolute top-3 block h-1 w-px bg-ink-900/40" style={{ left: `${mark}%` }} />
          </span>
        ))}
      </div>
      <div className="relative h-2.5 rounded-[3px] bg-line/6" style={{ boxShadow: ring(0.16) }}>
        <span
          className="absolute inset-y-0 right-0 block rounded-r-[3px]"
          style={{ width: `${view.buffer * 100}%`, background: HATCH, boxShadow: ring(0.3) }}
        />
        <span
          title={`${formatReportTokens(report.totalTokens)} / ${formatReportTokens(report.rawMaxTokens)}`}
          className="absolute inset-y-0 left-0 block rounded-l-[3px]"
          style={{ width: `${fill}%`, background: gauge, boxShadow: `2px 0 0 ${swatch('raised')}` }}
        />
        {view.spills && (
          // 70e: over the limit, one detached notch past the end.
          <span className="absolute inset-y-0 -right-[9px] block w-1.5 rounded-r-[2px]" style={{ background: gauge }} />
        )}
      </div>
      <div
        className="h-4"
        style={{
          clipPath: `polygon(0 0,${fill}% 0,100% 100%,0 100%)`,
          background: `linear-gradient(180deg,${swatch('line', 0.1)},${swatch('line', 0.04)})`,
        }}
      />
      <div className="flex h-3.5 gap-0.5 overflow-hidden rounded-[3px]">
        {view.used.map((c) => (
          <span
            key={c.name}
            title={`${c.name} · ${formatReportTokens(c.tokens)}`}
            className="block min-w-0.5"
            style={{ flex: `${c.tokens} 1 0`, background: slotColour(c.slot) }}
          />
        ))}
      </div>
      <div className={`mt-1.5 ${MONO_CAPTION}`}>IN USE · {formatReportTokens(report.totalTokens)}</div>
    </div>
  )
}

function reserveSwatch(kind: ReserveRow['kind']): CSSProperties {
  if (kind === 'buffer') return { background: HATCH, boxShadow: ring(0.35) }
  if (kind === 'free') return { background: swatch('line', 0.06), boxShadow: ring(0.3) }
  return { border: `1px dashed ${swatch('ink-900', 0.45)}` }
}

function LegendRow({ name, tokens, share, swatchStyle, phone }: {
  name: string
  tokens: number
  share: string
  swatchStyle: CSSProperties
  phone: boolean
}) {
  return (
    <div className={`flex items-center gap-[9px] ${phone ? 'h-[30px] fs-13.5' : 'h-[26px] fs-12.5'}`}>
      <span className={SQUARE} style={swatchStyle} />
      <span className="min-w-0 flex-1 truncate text-ink-100">{name}</span>
      <span className="font-mono fs-11.5 text-ink-100">{formatReportTokens(tokens)}</span>
      <span className="block w-[54px] shrink-0 text-right font-mono fs-11 text-ink-900/60">{share}</span>
    </div>
  )
}

/**
 * 70c's legend: the used categories, then the buffer, free space and any
 * kind the CLI added since, then the deferred rows that are not in the
 * window at all. The Mac sets it in two columns; the phone in one (70f).
 */
export function Legend({ report, view, phone }: { report: ContextReport; view: ContextReportView; phone: boolean }) {
  const window = report.rawMaxTokens
  const used = view.used.map((c) => (
    <LegendRow
      key={c.name}
      name={c.name}
      tokens={c.tokens}
      share={formatShare(c.tokens, window)}
      swatchStyle={{ background: slotColour(c.slot) }}
      phone={phone}
    />
  ))
  const reserve = view.reserve.map((r) => (
    <LegendRow
      key={r.name}
      name={r.name}
      tokens={r.tokens}
      share={formatShare(r.tokens, window)}
      swatchStyle={reserveSwatch(r.kind)}
      phone={phone}
    />
  ))
  const deferred = view.deferred.length > 0 && (
    <div className="mt-2.5 border-t border-line/8 pt-[9px]">
      <div className={`pb-[3px] ${MONO_CAPTION}`}>NOT IN THE WINDOW · LOADED WHEN NEEDED</div>
      {view.deferred.map((d) => (
        <div
          key={d.name}
          className={`flex items-center gap-[9px] text-ink-900/60 ${phone ? 'h-7 fs-13' : 'h-6 fs-12'}`}
        >
          <span className={SQUARE} style={{ border: `1px dashed ${swatch('ink-900', 0.45)}` }} />
          <span className="min-w-0 flex-1 truncate">{d.name}</span>
          <span className="font-mono fs-11">{formatReportTokens(d.tokens)}</span>
          <span className="block w-[54px] shrink-0 text-right font-mono fs-11 text-ink-900/45">—</span>
        </div>
      ))}
    </div>
  )
  if (phone) {
    return (
      <div className="flex flex-col">
        {used}
        {used.length > 0 && reserve.length > 0 && <div className="my-[5px] h-px bg-line/8" />}
        {reserve}
        {deferred}
      </div>
    )
  }
  return (
    <div className="grid grid-cols-2 gap-9">
      <div className="flex flex-col">{used}</div>
      <div className="flex flex-col">
        {reserve}
        {deferred}
      </div>
    </div>
  )
}

/**
 * 70d: one row per section, sorted by total and closed; a section opens to
 * its groups (servers, plugins, files, agents), a group to its items.
 */
export function Breakdowns({ sections, phone }: { sections: BreakdownSection[]; phone: boolean }) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  if (sections.length === 0) return null
  const toggle = (key: string) => setOpen((o) => ({ ...o, [key]: !o[key] }))
  return (
    <div className="flex flex-col">
      <div className={`pb-1 ${MONO_CAPTION}`}>BREAKDOWN · HEAVIEST FIRST</div>
      {sections.map((section) => {
        const sectionOpen = Boolean(open[section.key])
        const colour = slotColour(section.slot)
        return (
          <div key={section.key} className="border-t border-line/8">
            <button
              type="button"
              aria-expanded={sectionOpen}
              onClick={() => toggle(section.key)}
              className={`flex w-full cursor-pointer items-center gap-2.5 text-left text-ink-100 hover:bg-line/4 ${phone ? 'h-13 px-1' : 'h-10 px-1.5'}`}
            >
              <span className="block w-2.5 shrink-0 font-mono fs-10 text-ink-900/60">{sectionOpen ? '▾' : '▸'}</span>
              <span className={SQUARE} style={{ background: colour }} />
              <span className={`whitespace-nowrap font-semibold ${phone ? 'fs-15' : 'fs-13'}`}>{section.name}</span>
              <span className="min-w-0 flex-1 truncate font-mono fs-10.5 text-ink-900/60">{section.sub}</span>
              <span className="font-mono fs-11.5">{formatReportTokens(section.tokens)}</span>
            </button>
            {sectionOpen && (
              <div className="flex flex-col pb-2 pl-[30px]">
                {section.groups.map((group) => {
                  const key = `${section.key}/${group.lead}`
                  return (
                    <GroupRow
                      key={key}
                      group={group}
                      colour={colour}
                      phone={phone}
                      open={Boolean(open[key])}
                      onToggle={() => toggle(key)}
                    />
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * The full name of a row whose lead is cut — a memory file's path, a long
 * server, plugin or agent name, a tool. 70d: the Mac's tooltip, the phone's
 * long-press. On the phone the long-press opens it in place under the row,
 * selectable, and another closes it; the canvas draws no more than that.
 */
function useFullName(phone: boolean) {
  const [shown, setShown] = useState(false)
  const toggle = useCallback(() => setShown((v) => !v), [])
  const press = useLongPressAction(phone ? toggle : null)
  return { shown: phone && shown, press }
}

function FullName({ text, inset }: { text: string; inset: string }) {
  return (
    <div data-selectable className={`break-all pb-2 font-mono fs-10.5 leading-[1.5] text-ink-900/60 ${inset}`}>
      {text}
    </div>
  )
}

function GroupRow({
  group,
  colour,
  phone,
  open,
  onToggle,
}: {
  group: BreakdownGroup
  colour: string
  phone: boolean
  open: boolean
  onToggle: () => void
}) {
  const opens = group.items.length > 0
  const groupOpen = opens && open
  const full = useFullName(phone)
  return (
    <div>
      <button
        type="button"
        aria-expanded={opens ? groupOpen : undefined}
        onClick={opens ? onToggle : undefined}
        title={phone ? undefined : group.full}
        {...full.press}
        className={`flex w-full items-center gap-[9px] pr-1.5 text-left text-ink-100 ${opens ? 'cursor-pointer' : 'cursor-default'} ${phone ? 'h-12' : 'h-[30px]'}`}
      >
        <span className="block w-[9px] flex-none font-mono fs-9.5 text-ink-900/60">
          {opens ? (groupOpen ? '▾' : '▸') : ''}
        </span>
        <span
          className={`min-w-0 flex-1 truncate ${
            group.mono ? `font-mono ${phone ? 'fs-12' : 'fs-11.5'}` : `font-sans ${phone ? 'fs-14' : 'fs-12.5'}`
          }`}
        >
          {group.lead}
        </span>
        <span className="flex-none whitespace-nowrap font-mono fs-10 text-ink-900/60">{group.tag}</span>
        {!phone && (
          // 70d: the row's weight against the heaviest of its section, in the section's colour.
          <span className="block h-1 w-16 flex-none overflow-hidden rounded-[2px] bg-line/8">
            <span
              className="block h-full rounded-[2px]"
              style={{ width: `${Math.max(2, group.share * 100)}%`, background: colour }}
            />
          </span>
        )}
        <span className="block w-[46px] flex-none text-right font-mono fs-11">{formatReportTokens(group.tokens)}</span>
      </button>
      {full.shown && <FullName text={group.full} inset="-mt-1.5 pl-[18px] pr-1.5" />}
      {groupOpen && (
        <div className="mb-1.5 ml-1 border-l border-line/12 pl-3.5">
          {group.items.map((item, i) => (
            <ItemRow key={`${item.name}:${i}`} item={item} phone={phone} />
          ))}
        </div>
      )}
    </div>
  )
}

function ItemRow({ item, phone }: { item: BreakdownItem; phone: boolean }) {
  const full = useFullName(phone)
  return (
    <>
      <div
        title={phone ? undefined : item.name}
        {...full.press}
        className={`flex items-center gap-2 pr-1.5 font-mono text-ink-400/85 ${phone ? 'h-10 fs-11.5' : 'h-6 fs-10.5'}`}
      >
        <span className="min-w-0 flex-1 truncate">{item.name}</span>
        <span className="text-ink-900/60">{formatReportTokens(item.tokens)}</span>
      </div>
      {full.shown && <FullName text={item.name} inset="-mt-1 pr-1.5" />}
    </>
  )
}

/** 70d: the CLI's own printout behind a disclosure, unchanged, with Copy. */
export function AsText({ text, phone }: { text: string; phone: boolean }) {
  const [open, setOpen] = useState(false)
  // 70d: "says Copied until the dialog closes" — the dialog remounts this per opening.
  const [copied, setCopied] = useState(false)
  return (
    <div className="border-t border-line/8">
      <div className={`flex items-center gap-2.5 ${phone ? 'h-13' : 'h-10'}`}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex h-full flex-1 cursor-pointer items-center gap-2.5 px-1.5 text-left text-ink-100"
        >
          <span className="block w-2.5 shrink-0 font-mono fs-10 text-ink-900/60">{open ? '▾' : '▸'}</span>
          <span className={`font-semibold ${phone ? 'fs-15' : 'fs-13'}`}>As text</span>
          <span className="font-mono fs-10.5 text-ink-900/60">the CLI’s printout</span>
        </button>
        {open && (
          <Button
            variant="hairline"
            size={phone ? 'copy-touch' : 'copy'}
            onClick={() => void copyToClipboard(text).then((ok) => ok && setCopied(true))}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        )}
      </div>
      {open && (
        <pre
          data-selectable
          className={`m-0 mb-1.5 overflow-auto whitespace-pre rounded-[9px] border border-line/8 bg-space/60 px-3.5 py-3 font-mono fs-11 leading-[1.6] text-ink-400/85 ${
            phone
              ? 'max-h-[360px] [scrollbar-width:none]'
              : `max-h-[240px] ${REVIEW_SCROLLBAR}`
          }`}
        >
          {text}
        </pre>
      )}
    </div>
  )
}
