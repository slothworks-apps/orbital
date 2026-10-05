import type { ClaudeDirPrefillSource } from '../lib/claudeDirs'
import { claudeDirChoosable, claudeDirSubline } from '../lib/claudeDirs'
import { shortcutLabel } from '../lib/keymap'
import type { ClaudeDirName } from '../lib/types'
import { ClaudeDirMark } from '../ui/ClaudeDirMark'
import { MenuButton, type MenuEntry } from '../ui/Menu'
import { Segmented } from '../ui/Segmented'

/**
 * Up to this many directories the New session dialog shows them as segments
 * in the form; past it the names would get too narrow, and the choice moves
 * to the header control (canvas 44c).
 */
export const CLAUDE_DIR_SEGMENTS_MAX = 3

/** Where the choice stands, as the dialog says it: what prefilled it, or that it was changed. */
export interface ClaudeDirOrigin {
  from: ClaudeDirPrefillSource
  /** The selected planet's title, when `from` is the planet. */
  planet?: string
  /** Picked by hand since the dialog opened, away from the prefill. */
  changed: boolean
}

function prefillPhrase(origin: ClaudeDirOrigin): string {
  switch (origin.from) {
    case 'planet':
      return `the selected planet · ${origin.planet ?? ''}`
    case 'last':
      return 'your last launch'
    case 'default':
    case 'first':
      return 'the default'
  }
}

/** The label row's hint (canvas 44c: "· from the selected planet · auth-refactor"). */
export function claudeDirOriginHint(origin: ClaudeDirOrigin): string {
  return origin.changed ? 'changed for this launch' : `from ${prefillPhrase(origin)}`
}

/** The dropdown's note under its rows (canvas 44c, the header control). */
function originNote(origin: ClaudeDirOrigin): string {
  return origin.changed
    ? 'CHANGED FOR THIS LAUNCH · BECOMES YOUR LAST LAUNCH'
    : `PREFILLED FROM ${prefillPhrase(origin).toUpperCase()}`
}

/**
 * Canvas 44c, two or three directories: the names as segments, 36px tall,
 * between the project and the model — the directory decides which models the
 * list offers, so the form reads top to bottom. Names only: a letter tile
 * beside a button's name would read as that button's key. A directory
 * missing on disk is shown, at half strength, and cannot be chosen.
 */
export function ClaudeDirSegments({
  dirs,
  value,
  onChange,
}: {
  dirs: readonly ClaudeDirName[]
  value: number | null
  onChange: (id: number) => void
}) {
  return (
    <Segmented
      label="Claude directory"
      size="field"
      className="w-full"
      value={value === null ? '' : String(value)}
      onChange={(id) => onChange(Number(id))}
      options={dirs.map((dir) => ({
        value: String(dir.id),
        label: dir.name,
        title: claudeDirSubline(dir),
        disabled: !claudeDirChoosable(dir),
      }))}
    />
  )
}

/**
 * Canvas 44c, four or more directories: one quiet control in the dialog's
 * header, beside esc — `CLAUDE DIR [W] Work ▾` — opening the shared dropdown
 * shell: every directory with its mark, path and account, ✓ on the choice.
 */
export function ClaudeDirHeaderControl({
  dirs,
  monograms,
  value,
  defaultId,
  origin,
  onChange,
}: {
  dirs: readonly ClaudeDirName[]
  monograms: Map<number, string>
  value: number | null
  defaultId: number | null
  origin: ClaudeDirOrigin
  onChange: (id: number) => void
}) {
  const chosen = dirs.find((d) => d.id === value) ?? null
  const entries: MenuEntry[] = [
    { heading: 'RUN THIS SESSION UNDER' },
    ...dirs.map((dir) => ({
      key: String(dir.id),
      label: dir.name,
      disabled: !claudeDirChoosable(dir),
      selected: dir.id === value,
      onSelect: () => onChange(dir.id),
      body: (
        <span className="flex min-w-0 items-start gap-[9px]">
          <span className="mt-px flex">
            <ClaudeDirMark mono={monograms.get(dir.id) ?? '?'} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
            <span className="flex min-w-0 items-center gap-[7px]">
              <span className="min-w-0 truncate font-sans text-[12.5px] font-semibold text-text-bright">{dir.name}</span>
              {dir.id === defaultId && (
                <span className="flex-none font-mono text-[8.5px] tracking-[0.12em] text-[rgba(160,190,225,.55)]">
                  DEFAULT
                </span>
              )}
            </span>
            <span className="truncate font-mono text-[10px] text-[rgba(160,190,225,.6)]">{claudeDirSubline(dir)}</span>
          </span>
        </span>
      ),
    })),
  ]
  return (
    <MenuButton
      aria-label="Claude directory"
      entries={entries}
      widthPx={310}
      align="right"
      footer={
        <div
          role="note"
          className="mx-[5px] mb-0.5 mt-[3px] border-t border-[rgba(150,205,255,.1)] pt-1.5 font-mono text-[9.5px] leading-normal tracking-[0.1em] text-[rgba(160,190,225,.5)]"
        >
          {originNote(origin)}
        </div>
      }
      renderTrigger={(props, open) => (
        <button
          {...props}
          type="button"
          title={`Claude directory for this session · ${shortcutLabel('composer.next-claude-dir')} next`}
          className={[
            'box-border flex max-w-60 items-center gap-2 rounded-[7px] border py-[5px] pl-2.5 pr-[9px] font-mono text-[10.5px] text-[rgba(214,230,248,.9)] transition-colors hover:bg-[rgba(150,205,255,.08)]',
            open ? 'border-[rgba(150,205,255,.26)] bg-[rgba(150,205,255,.1)]' : 'border-[rgba(150,205,255,.14)] bg-transparent',
          ].join(' ')}
        >
          <span className="flex-none text-[9px] tracking-[0.16em] text-[rgba(160,190,225,.55)]">CLAUDE DIR</span>
          {chosen && <ClaudeDirMark mono={monograms.get(chosen.id) ?? '?'} />}
          <span className="min-w-0 max-w-[120px] truncate">{chosen?.name ?? ''}</span>
          <span aria-hidden className="flex-none text-[8px] text-[rgba(160,190,225,.6)]">
            ▾
          </span>
        </button>
      )}
    />
  )
}
