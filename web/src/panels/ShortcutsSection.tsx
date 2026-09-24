import { useEffect, useRef, useState } from 'react'
import { bindingCount, keymapGroups, type Row } from '../lib/keymap'
import { Keycap } from '../ui/Keycap'

/**
 * Settings → Shortcuts (spec 2026-09-23-shortcuts-design § 6, canvas
 * `Feature - Shortcuts.dc.html` artboard A): the live keymap, read-only.
 *
 * Nothing here is clickable beyond the filter. Rebinding is not built, and a
 * row that looks pressable but does nothing would promise it, so rows are
 * plain list items with no hover. For the same reason there is no "Restore
 * defaults" button, and the filter carries no `/` glyph — it would read as a
 * key that focuses it, and no key does.
 */
export function ShortcutsSection() {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const groups = keymapGroups(query)
  const shown = groups.reduce((sum, group) => sum + group.rows.length, 0)

  // The filter is the only control in the pane, so opening the section is
  // taken as the intent to type into it.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <div className="flex min-h-0 flex-col">
      {/* Filter bar: 16/32/14 padding, hairline under it (artboard A). */}
      <div className="shrink-0 border-b border-[rgba(150,205,255,.08)] px-8 pb-3.5 pt-4">
        <div className="flex items-center gap-2.5 rounded-[9px] border border-panel-border bg-[rgba(4,8,16,.45)] px-3 py-2">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by action or key"
            aria-label="Filter shortcuts"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-text-bright outline-none"
          />
          {query.trim() !== '' && (
            <span className="shrink-0 font-mono text-[10px] tracking-[0.06em] text-[rgba(160,190,225,.5)]">
              {shown}/{bindingCount()}
            </span>
          )}
        </div>
      </div>

      {/* List: 6/32/22 padding, scrolls under the pinned filter bar. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-[22px] pt-1.5">
        {groups.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 py-16">
            <div className="font-mono text-[11px] tracking-[0.14em] text-[rgba(160,190,225,.6)]">
              NO MATCH
            </div>
            <div className="text-[12.5px] text-[rgba(160,190,225,.6)]">
              Nothing bound to that. Try a modifier glyph, or an action word like “fit”.
            </div>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.scope} className="pt-[18px]">
              <div className="flex items-baseline gap-2.5 pb-2">
                <h3
                  data-testid="shortcut-group-title"
                  className="font-mono text-[10px] font-normal tracking-[0.18em] text-[rgba(160,190,225,.6)]"
                >
                  {group.title}
                </h3>
                <span className="font-mono text-[10px] tracking-[0.04em] text-[rgba(160,190,225,.4)]">
                  {group.when}
                </span>
              </div>
              <ul>
                {group.rows.map((row) => (
                  <ShortcutRow key={row.id} row={row} />
                ))}
              </ul>
            </section>
          ))
        )}

        <div className="mt-[22px] border-t border-[rgba(150,205,255,.08)] pt-3.5 font-mono text-[10.5px] leading-[1.6] text-[rgba(160,190,225,.5)]">
          Bindings are read from the live keymap · rebinding lands later
        </div>
      </div>
    </div>
  )
}

/** One binding: label and note on the left, its caps ragged on the right. */
function ShortcutRow({ row }: { row: Row }) {
  return (
    <li
      data-testid="shortcut-row"
      className="flex min-h-10 items-center gap-4 rounded-lg border-t border-[rgba(150,205,255,.08)] px-2.5 py-[7px]"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13px] font-medium text-text-bright">{row.label}</span>
        {row.note && (
          <span className="font-mono text-[10px] tracking-[0.04em] text-[rgba(160,190,225,.5)]">
            {row.note}
          </span>
        )}
      </div>
      <div className="flex flex-none items-center gap-[7px]">
        {row.caps.map((glyphs, i) => (
          <Keycap key={i} display={glyphs} />
        ))}
        {row.muted && (
          <>
            <span className="font-mono text-[10.5px] text-[rgba(160,190,225,.45)]">/</span>
            <Keycap muted display={row.muted} />
          </>
        )}
        {row.gesture && <Keycap gesture display={row.gesture} />}
      </div>
    </li>
  )
}
