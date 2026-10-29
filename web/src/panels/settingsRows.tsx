import { createContext, useContext, type ReactNode } from 'react'
import {
  NOT_SHARING,
  SCOPE_LABEL,
  listSeparator,
  rowIsDeviceOnly,
  scopeOfKeys,
  type GroupSharing,
  type SettingsScope,
} from '../lib/settingsScope'
import { Button } from '../ui/Button'
import { KindGlyph } from '../ui/KindGlyph'
import { QuietLabel } from '../ui/PrimaryLabel'

/**
 * The Settings dialog's row primitives, shared by `Settings.tsx` and the
 * sections that live in their own files (`DevicesSection.tsx`).
 */

/** Debounce for the free-text fields — the rest of this panel's controls
 * (cards, segmented steps, toggles, selects) are discrete clicks and PATCH
 * immediately. */
export const DEBOUNCE_MS = 400

/**
 * Who shares settings with this device (`groupSharing`), set once by the
 * dialog. Nothing is marked while `shown` is false: alone, or with phones
 * only, Settings is drawn as it was before the group shared anything.
 */
const SharingContext = createContext<SettingsSharing>(NOT_SHARING)
export const SharingProvider = SharingContext.Provider

/** `openDevices`: what "update it" does; absent on Devices itself, where it reads as words. */
export type SettingsSharing = GroupSharing & { openDevices?: () => void }

export function useGroupSharing(): SettingsSharing {
  return useContext(SharingContext)
}

/** The scope of the section the rows below belong to (`ScopeSection`). */
const ScopeContext = createContext<SettingsScope | null>(null)

/**
 * A run of `SectionLabel` and rows under one scope: from the keys its rows
 * edit (`scopeOfKeys`), or said outright for a section whose rows are not
 * settings (tags, rules, profiles, devices). Renders no DOM.
 */
export function ScopeSection({
  keys,
  scope,
  children,
}: {
  keys?: readonly string[]
  scope?: SettingsScope
  children: ReactNode
}) {
  const value = scope ?? scopeOfKeys(keys ?? [])
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>
}

/** The section's scope while the dialog marks scopes; null otherwise. */
export function useShownScope(): SettingsScope | null {
  const { shown } = useContext(SharingContext)
  const scope = useContext(ScopeContext)
  return shown ? scope : null
}

/** Whether a row editing `setting` carries THIS MAC ONLY: only in a mixed section, and only if none of its keys is shared. */
export function useDeviceOnlyMark(setting: string | readonly string[] | undefined): boolean {
  const scope = useShownScope()
  if (scope !== 'mixed' || setting === undefined) return false
  return rowIsDeviceOnly(typeof setting === 'string' ? [setting] : setting)
}

/**
 * A section heading's right end (canvas `Feature - Shared settings` 63c):
 * mono 9.5 at .14em; THIS MAC ONLY leads with the desktop glyph, 7px off.
 */
export function ScopeLabel({ scope }: { scope: SettingsScope }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-[7px] font-mono fs-9.5 tracking-[0.14em] text-ink-900/55">
      {scope === 'device' && (
        <span className="flex text-ink-500/70">
          <KindGlyph kind="desktop" untitled />
        </span>
      )}
      {SCOPE_LABEL[scope]}
    </span>
  )
}

/**
 * A row's title, with THIS MAC ONLY 9px after it when `mark` — the pill a
 * per-device row of a mixed section carries beside its name (63c): PRIMARY's
 * pill.
 */
export function RowTitle({ title, mark }: { title: string; mark: boolean }) {
  if (!mark) return <div className="fs-13.5 font-semibold text-ink-100">{title}</div>
  return (
    <div className="flex items-center gap-[9px] fs-13.5 font-semibold text-ink-100">
      <span>{title}</span>
      <QuietLabel>THIS MAC ONLY</QuietLabel>
    </div>
  )
}

/**
 * The line at the top of every tab while the group shares settings (canvas
 * 63a, 63c): who they apply on, and under it each Mac or server too old to
 * share them, with "update it" opening Devices. `scope`: a tab with no
 * section heading to carry its label carries it here, at the right end.
 */
export function GroupLine({ scope, className = '' }: { scope?: SettingsScope; className?: string }) {
  const { shown, names, old, openDevices } = useContext(SharingContext)
  if (!shown) return null
  return (
    <div
      data-testid="group-line"
      className={`flex flex-col gap-1 pb-3.5 pt-2.5 font-sans fs-12 leading-[1.5] text-ink-900/72 ${className}`}
    >
      <div className="flex items-baseline gap-3">
        <p className="min-w-0 flex-1 [text-wrap:pretty]">
          Shared settings apply on every Mac and server in this group:{' '}
          {names.map((name, i) => (
            <span key={i}>
              {listSeparator(i, names.length)}
              <span className="text-ink-200/90">{name}</span>
            </span>
          ))}
          . Phones read them.
        </p>
        {scope && <ScopeLabel scope={scope} />}
      </div>
      {old.map((m) => (
        <p key={m.id} className="[text-wrap:pretty]">
          <span className="text-ink-200/90">{m.name}</span> doesn’t share settings yet —{' '}
          {openDevices ? (
            <Button variant="dashed-link" size="inline" onClick={openDevices}>
              update it
            </Button>
          ) : (
            'update it'
          )}
          .
        </p>
      ))}
    </div>
  )
}

/** Mono section kicker inside the settings content column (canvas 1h):
 * 8px/4px above the first group, 14px/4px above every later one. While the
 * group shares settings, its right end says the section's scope (63c). */
export function SectionLabel({ children, first = false }: { children: ReactNode; first?: boolean }) {
  const scope = useShownScope()
  const kicker = `pb-1 font-mono fs-10 tracking-[0.18em] text-ink-900/60 ${first ? 'pt-2' : 'pt-3.5'}`
  if (!scope) return <div className={kicker}>{children}</div>
  return (
    <div className={`flex items-center gap-3 ${kicker}`}>
      <span className="min-w-0 flex-1">{children}</span>
      <ScopeLabel scope={scope} />
    </div>
  )
}

/** One settings row per canvas 1h: label + description left, 320px control
 * column right, 13px vertical padding over a hairline top rule.
 *
 * `dimmed` is a row with nothing to act on yet (canvas `Feature -
 * Notifications off` 1c, background-only while every event is off): its words
 * at .45, the same as a disabled control beside them. */
export function Row({
  title,
  desc,
  dimmed = false,
  narrow = false,
  setting,
  children,
}: {
  title: string
  desc: ReactNode
  dimmed?: boolean
  /** The settings keys the row edits: it is marked THIS MAC ONLY in a mixed section when none is shared. */
  setting?: string | readonly string[]
  /** Canvas 50a's rows: a 300px control column 32px from the words. */
  narrow?: boolean
  children: ReactNode
}) {
  const mark = useDeviceOnlyMark(setting)
  const grid = narrow ? 'grid-cols-[minmax(0,1fr)_300px] gap-8' : 'grid-cols-[1fr_320px] gap-6'
  return (
    <div className={`grid ${grid} items-start border-t border-line/8 py-[13px]`}>
      <div className={dimmed ? 'opacity-45' : undefined}>
        <RowTitle title={title} mark={mark} />
        <div className="mt-1 fs-12 leading-[1.5] text-ink-900/70 [text-wrap:pretty]">
          {desc}
        </div>
      </div>
      <div className="flex min-w-0 flex-col items-start gap-2.5">{children}</div>
    </div>
  )
}
