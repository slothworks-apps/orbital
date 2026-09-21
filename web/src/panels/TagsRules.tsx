import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { tagColor } from '../lib/types'
import type { Tag, TagRule } from '../lib/types'
import { EscapeBoundary, useEscapeLayer } from '../ui/escapeLayer'
import { Select } from '../ui/Select'
import { Toggle } from '../ui/Checkbox'
import { Input } from '../ui/Input'
import { Chip } from '../ui/Chip'

export interface TagsRulesSectionProps {
  /** True while this is the section Settings is showing. Gates the reset, the
   *  debounced preview and the Escape layer, none of which should run for a
   *  section the user cannot see. */
  active: boolean
  /** Stamps the dialog header's "saved · just now" — the header belongs to
   *  `Settings` now, so every mutation that lands reports upward. */
  onSaved: () => void
}

/** The design canvas's 8-swatch hue picker, verbatim from artboard 1e. */
const HUE_SWATCHES = [210, 250, 290, 330, 20, 60, 110, 150]

const CONDITION_OPTIONS: Array<{ value: TagRule['condition']; label: string }> = [
  { value: 'path_matches', label: 'path matches' },
  { value: 'title_contains', label: 'title contains' },
  { value: 'permission_is', label: 'permission is' },
]

/**
 * Rules table columns. The first five are verbatim from artboard 1e
 * (`24px 1fr 1fr 130px 44px`: grip · condition · pattern · → tag · on); the
 * trailing 28px holds the delete control, which 1e's static mock has no need
 * for. Reordering is NOT a column of its own — it lives on 1e's own `⋮⋮`
 * grip. Every column is `minmax(0, …)` so a narrow window squeezes the table
 * instead of clipping the delete off the right edge. The header row, every
 * rule row and the column captions all share this one definition so they
 * stay aligned.
 */
const RULE_GRID = 'grid-cols-[24px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,130px)_44px_28px]'

/** Id (not a ref — `Input` doesn't take one) so the header's "+ new tag" can focus the field when it's empty. */
const NEW_TAG_FIELD_ID = 'tags-rules-new-tag'

/** Same trick for the per-row pattern field: opening a row focuses it by id. */
const patternFieldId = (ruleId: number) => `tags-rules-pattern-${ruleId}`

/** Debounce for the pattern/preview text inputs — same window as the rest of the app's debounced PATCHes. */
const DEBOUNCE_MS = 400

/**
 * Vertical gap between rule rows, verbatim from artboard 1e
 * (`gap:4px` on the rules list) and mirrored by the list's `gap-1`. A row's
 * "slot" is its own height plus this, which is what neighbours have to travel
 * to close over it during a drag.
 */
const RULE_ROW_GAP = 4

/**
 * The drag gap-preview transition. `cubic-bezier(.2,.8,.2,1)` is the export's
 * panel easing; 180ms sits in the responsive half of the 150–200ms band — long
 * enough to read as motion, short enough that the rows have settled before the
 * pointer reaches the next row. Only applied WHILE a drag is live: on drop the
 * DOM genuinely reorders, and a row transitioning its transform back to 0 from
 * its new layout position would slide the wrong way for 180ms. `motion-safe:`
 * keeps the gap itself (useful layout feedback) while dropping the animation
 * for `prefers-reduced-motion: reduce`.
 */
const DRAG_SHIFT_TRANSITION =
  'motion-safe:transition-transform motion-safe:duration-[180ms] motion-safe:ease-[cubic-bezier(.2,.8,.2,1)]'

function replaceTag(tags: Tag[], id: number, patch: Partial<Tag>): Tag[] {
  return tags.map((t) => (t.id === id ? { ...t, ...patch } : t))
}

function replaceRule(rules: TagRule[], id: number, patch: Partial<TagRule>): TagRule[] {
  return rules.map((r) => (r.id === id ? { ...r, ...patch } : r))
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function conditionLabel(condition: TagRule['condition']): string {
  return CONDITION_OPTIONS.find((o) => o.value === condition)?.label ?? condition
}

/**
 * Compile error for a `path_matches` pattern, or null when it's fine. The
 * server treats the pattern as a JS regex and silently matches nothing when
 * it doesn't compile, so this is the only place the user learns why a rule
 * never fires. Empty is fine (a fresh rule); the leading `~` the server
 * expands is an ordinary character to the regex engine, so validity of the
 * raw text is validity of what the server runs.
 */
function patternError(pattern: string): string | null {
  const trimmed = pattern.trim()
  if (!trimmed) return null
  try {
    new RegExp(trimmed)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** One-line reading of a rule — shared by the row button's label, the grip's label and the reorder announcement. */
function describeRule(rule: TagRule, tagName: string, pattern: string): string {
  return `${conditionLabel(rule.condition)} ${pattern || '(no pattern)'} → ${tagName}`
}

/**
 * The resting row's target-tag pill, verbatim from artboard 1e: `3px 9px`
 * inside a 999px border tinted `oklch(80% .13 H / .4)`, an 11px/600 label and
 * a 6px dot in the tag's own hue, `width: fit-content`.
 */
function TagPill({ hue, name }: { hue: number; name: string }) {
  return (
    <span
      data-rule-tag-pill
      className="inline-flex w-fit min-w-0 items-center gap-1.5 rounded-full border px-[9px] py-[3px] text-[11px] font-semibold text-text-bright"
      style={{ borderColor: `oklch(80% .13 ${hue} / .4)` }}
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: tagColor(hue) }}
      />
      <span className="truncate">{name}</span>
    </span>
  )
}

/**
 * Refetches rules from the server and replaces the store's copy wholesale.
 * Called from every rule-mutation handler's `catch` block (in addition to
 * `reportError`'s toast) so a failed PATCH — or, for the reorder swap
 * specifically, a *partial* failure where one of its two PATCHes succeeded
 * and the other didn't — can never leave the client silently diverged from
 * the server. There's no DB uniqueness constraint on `position`, so a
 * half-applied swap is a real possibility, not just a theoretical one.
 */
async function resyncRules(): Promise<void> {
  try {
    const refreshed = await api.listTagRules()
    useOrbital.setState({ rules: refreshed })
  } catch {
    // The resync itself failed (server unreachable, say) — nothing more to
    // do here; the toast from the triggering mutation already told the user
    // something went wrong, and the next successful mutation (or reopening
    // the panel, which re-fetches via loadInitial) will resync again.
  }
}

/**
 * Refetches sessions and re-applies them into the store as upserts.
 *
 * Rule/tag mutations that trigger server-side `regenerateRuleTags` (create,
 * patch, delete of a rule; the reorder swap; tag delete) change which tags
 * apply to which sessions, but the server has no push channel for that —
 * only the sessions the runner/registry itself upserts get a WS event. Left
 * alone, a session's `tagIds` in the client store would silently drift from
 * what the server now computes until something else (a reload, an unrelated
 * WS upsert) happened to refresh it. Called after every SUCCESSFUL mutation
 * of that kind, in addition to (not instead of) `resyncRules` for the rules
 * list itself.
 */
async function resyncSessions(): Promise<void> {
  try {
    const refreshed = await api.listSessions({ limit: 200 })
    refreshed.forEach((session) => useOrbital.getState().applySessionsEvent({ event: 'upsert', session }))
  } catch {
    // Best-effort — same rationale as resyncRules above.
  }
}

/**
 * The 22px planet marble 1e uses instead of a flat colour dot — the same
 * radial body fill for every tag, with the tag's own hue carried by the rim
 * and the glow (canvas 1e: `0 0 14px …/.7` on the selected card, `0 0 12px
 * …/.6` on the resting ones).
 */
function TagPlanet({ hue, selected }: { hue: number; selected: boolean }) {
  return (
    <span
      aria-hidden
      data-tag-planet
      // `block` is load-bearing, not decoration: a <span> defaults to inline,
      // which ignores width/height. It only looked right while the planet
      // happened to be a flex item — wrapping it in a button collapsed it to
      // a 2px sliver. Sizing itself keeps it correct in any container.
      className="block h-[22px] w-[22px] shrink-0 rounded-full"
      style={{
        background: 'radial-gradient(circle at 50% 45%, oklch(30% .05 220), oklch(20% .04 225) 70%)',
        border: `1px solid oklch(80% .13 ${hue} / .55)`,
        boxShadow: selected ? `0 0 14px oklch(80% .13 ${hue} / .7)` : `0 0 12px oklch(80% .13 ${hue} / .6)`,
      }}
    />
  )
}

/** Inline-editable tag name — local draft so keystrokes don't get clobbered by store updates, committed on blur/Enter (mirrors DetailPanel's title field). */
function TagNameField({ tag, onCommit }: { tag: Tag; onCommit: (name: string) => void }) {
  const [draft, setDraft] = useState(tag.name)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (!editing) setDraft(tag.name)
  }, [tag.name, editing])

  function commit() {
    setEditing(false)
    const next = draft.trim()
    if (!next || next === tag.name) {
      setDraft(tag.name)
      return
    }
    onCommit(next)
  }

  return (
    <Input
      variant="inline"
      aria-label={`Tag name for ${tag.name}`}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setEditing(true)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}

/**
 * Tag list + auto-tag rule table — the two middle columns of artboard 1e.
 *
 * This used to be a dialog of its own. In the current canvas 1e is the same
 * Settings dialog as 1h with "Tags & rules" selected in its nav, so what
 * lives here is only the body: a 330px tag column and the rule table beside
 * it. The panel, the header and Escape-to-close belong to `Settings`.
 */
export function TagsRulesSection({ active, onSaved }: TagsRulesSectionProps) {
  const tags = useOrbital(useShallow((s) => s.tags))
  const rules = useOrbital(useShallow((s) => s.rules))
  const sessions = useOrbital(useShallow((s) => s.sessions))

  /** Target-tag options for an open rule row — each carries its own tag's hue as the leading dot. */
  const tagOptions = useMemo(
    () => tags.map((tag) => ({ value: tag.id, label: tag.name, dotColor: tagColor(tag.hue) })),
    [tags],
  )

  const [newTagName, setNewTagName] = useState('')
  /**
   * Which tag card is selected, as a TRI-state: a tag id, `'none'` for an
   * explicit deselect, and `null` for "the user hasn't chosen yet", which
   * falls back to the head of the list (canvas 1e opens with `work` selected).
   * A plain `number | null` couldn't tell "deselected" apart from "not yet
   * chosen", so there was no way back out of a selection.
   */
  const [selectedTagId, setSelectedTagId] = useState<number | 'none' | null>(null)
  const [previewPath, setPreviewPath] = useState('')
  const [previewResult, setPreviewResult] = useState<{ tagId: number | null; ruleId: number | null } | null>(null)
  const [patternDrafts, setPatternDrafts] = useState<Record<number, string>>({})
  /**
   * Canvas 1e draws rule rows in two modes: a readable table at rest
   * (condition and pattern as plain text, a hue-bordered tag pill, the ON
   * switch) and exactly ONE row swapped over to the condition dropdown + the
   * pattern field, wearing the accent border. This is that one row's id.
   */
  const [editingRuleId, setEditingRuleId] = useState<number | null>(null)
  /** Rule currently being dragged by its grip, and the row index it is hovering over. */
  const [dragRuleId, setDragRuleId] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  /**
   * Each row's slot height (own height + `RULE_ROW_GAP`), measured ONCE at
   * dragstart. Rows are not uniform — an open row is taller than a resting
   * one and a long pattern can wrap — so the distances are measured rather
   * than assumed. A ref, not state: it is written before the drag renders and
   * read during render, and must never itself trigger one.
   */
  const rowSlots = useRef<Map<number, number>>(new Map())
  /**
   * Text for the polite live region under the rules list. Native drag-and-drop
   * announces nothing, and a keyboard move that only changed DOM order would
   * be silent too, so every reorder (mouse or keyboard) reports where the rule
   * landed.
   */
  const [reorderStatus, setReorderStatus] = useState('')
  /** Drives the dialog header's "saved · just now" (canvas 1e) — called by every mutation that actually landed. */
  const markSaved = onSaved

  // Per-row debounce for the pattern field, keyed by rule id — a keystroke
  // in one row only resets that row's own timer, never every other row's
  // (the previous implementation re-derived every rule's timer from a
  // single effect over the whole `patternDrafts` object on every keystroke
  // in any field). Declared here (before the `if (!open) return null` below)
  // rather than down by `handlePatternDraft` — this component stays mounted
  // across `open` toggling (App renders it unconditionally), so every hook
  // must run on every render regardless of `open`, or React errors with
  // "Rendered more hooks than during the previous render" the first time
  // `open` flips. `handlePatternDraft` itself stays below; it just closes
  // over this ref.
  const patternTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({})
  /**
   * The value each pending timer would PATCH, kept in a ref (not just in
   * `patternDrafts` state) so `flushPattern` can commit it from an event
   * handler without depending on which render's closure it was called from.
   */
  const patternPending = useRef<Record<number, string>>({})
  /** Rule whose pattern field should take focus after the next render (a row just opened). */
  const focusOnOpen = useRef<number | null>(null)
  /** Rule whose resting row button should take focus after the next render (a row just closed). */
  const focusOnClose = useRef<number | null>(null)
  /**
   * Rule whose grip should take focus after the next render. A keyboard
   * reorder moves the row's DOM node, and focus must ride along with it or
   * the next ArrowDown would go nowhere — so it is re-asserted explicitly
   * rather than relying on the browser preserving focus across a move.
   */
  const focusGrip = useRef<number | null>(null)

  useEffect(() => {
    // Unmount cleanup only — timers are otherwise managed per-call below.
    return () => {
      Object.values(patternTimers.current).forEach(clearTimeout)
    }
  }, [])

  // Focus follows the mode switch: opening a row lands the caret in the
  // pattern field (the thing you almost always came to change), closing one
  // hands focus back to the row button you opened it from, so the keyboard
  // never gets dumped at the top of the document. No dep array — both arms
  // are guarded by refs that clear themselves.
  useEffect(() => {
    const opened = focusOnOpen.current
    if (opened != null) {
      focusOnOpen.current = null
      const field = document.getElementById(patternFieldId(opened))
      if (field instanceof HTMLInputElement) {
        field.focus()
        field.select()
      }
    }
    const closed = focusOnClose.current
    if (closed != null) {
      focusOnClose.current = null
      document.querySelector<HTMLElement>(`[data-rule-open="${closed}"]`)?.focus()
    }
    const moved = focusGrip.current
    if (moved != null) {
      focusGrip.current = null
      document.querySelector<HTMLElement>(`[data-rule-grip="${moved}"]`)?.focus()
    }
  })

  // Leaving for another section and coming back must not resume a half-open
  // row or replay an old announcement.
  useEffect(() => {
    if (active) {
      setEditingRuleId(null)
      setReorderStatus('')
    }
  }, [active])

  // Escape peels one layer at a time. This layer exists only while a rule row
  // is open: it takes the row back to rest and stops there, leaving the next
  // Escape to reach `Settings` and close the dialog. Registered from inside
  // Settings' `EscapeBoundary`, so it outranks the dialog; a select popup
  // opened inside a row registers deeper still and is peeled before either.
  useEscapeLayer(active && editingRuleId != null, () => closeRule(true))

  // Sample-path preview, debounced.
  useEffect(() => {
    if (!active || !previewPath.trim()) {
      setPreviewResult(null)
      return
    }
    const timer = setTimeout(() => {
      api
        .previewRule({ cwd: previewPath, title: '', permissionMode: null })
        .then(setPreviewResult)
        .catch(() => {
          // Best-effort preview; leave the last known result.
        })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [active, previewPath])

  // ONE global list, always. The server evaluates rules top → bottom and the
  // first match wins across every tag, so filtering the table down to the
  // selected tag would hide the rules that actually win and make this
  // column's own "evaluated top → bottom, first match wins" caption a lie.
  // Artboard 1e agrees: `work` is the selected card, yet all four rules are
  // listed (work / oncall / experiments / experiments). Selecting a tag card
  // only MARKS the rows that target it — see `targetsSelected` below.
  const sortedRules = [...rules].sort((a, b) => a.position - b.position)
  const effectiveTagId = selectedTagId === 'none' ? null : (selectedTagId ?? tags[0]?.id ?? null)
  const defaultTag = tags.find((t) => t.is_default)

  /** Clicking (or pressing) the already-selected card turns the marking off again. */
  function toggleTagSelection(tagId: number) {
    setSelectedTagId(effectiveTagId === tagId ? 'none' : tagId)
  }

  /**
   * How far (px) the row at `idx` must translate to PREVIEW the pending drop,
   * so the list visibly opens up around the landing slot instead of sitting
   * still under the cursor. Purely derived from `dragRuleId` + `dropIndex`:
   * the DOM order is never touched until the drop actually commits, and
   * clearing those two — which `drop`, `dragend` and a release outside the
   * list all already do — is what wipes every transform. There is no separate
   * cleanup path that could be missed and leave the list scrambled.
   *
   * Dragging DOWN: every row the dragged rule passes moves up by exactly the
   * slot it vacated; dragging UP, they move down. That distance is the DRAGGED
   * row's own slot regardless of how tall the rows it passes are, so mixed
   * heights are exact here, not approximated. The dragged row itself travels
   * the summed slots of everything it passes, so the faded placeholder lands
   * precisely in the gap that opened for it.
   */
  function dragShiftFor(idx: number): number {
    if (dragRuleId == null || dropIndex == null) return 0
    const from = sortedRules.findIndex((r) => r.id === dragRuleId)
    if (from < 0 || dropIndex === from) return 0
    const slot = (i: number) => rowSlots.current.get(sortedRules[i].id) ?? 0
    const down = dropIndex > from

    if (idx === from) {
      let travelled = 0
      if (down) for (let i = from + 1; i <= dropIndex; i++) travelled += slot(i)
      else for (let i = dropIndex; i < from; i++) travelled += slot(i)
      return down ? travelled : -travelled
    }
    if (down && idx > from && idx <= dropIndex) return -slot(from)
    if (!down && idx >= dropIndex && idx < from) return slot(from)
    return 0
  }

  function sessionCount(tagId: number): number {
    return Object.values(sessions).filter((s) => s.tagIds.includes(tagId)).length
  }

  function ruleCount(tagId: number): number {
    return rules.filter((r) => r.tag_id === tagId).length
  }

  /** Canvas 1e: "3 sessions · 2 rules", "2 sessions · default" — the rule count is dropped when a tag has none. */
  function tagMeta(tag: Tag): string {
    const parts = [plural(sessionCount(tag.id), 'session')]
    const ruleN = ruleCount(tag.id)
    if (ruleN > 0) parts.push(plural(ruleN, 'rule'))
    if (tag.is_default) parts.push('default')
    return parts.join(' · ')
  }

  async function handleCreateTag() {
    const name = newTagName.trim()
    if (!name) return
    try {
      await api.createTag({ name, hue: HUE_SWATCHES[tags.length % HUE_SWATCHES.length] })
      const refreshed = await api.listTags()
      useOrbital.setState({ tags: refreshed })
      setNewTagName('')
      markSaved()
    } catch (err) {
      reportError(err, 'Failed to create tag')
    }
  }

  // The header's "+ new tag" is 1e's only create affordance; the name field
  // below the list is ours (1e renames in place on the card instead). With
  // nothing typed yet, send focus there rather than no-oping silently.
  function handleNewTagClick() {
    if (!newTagName.trim()) {
      document.getElementById(NEW_TAG_FIELD_ID)?.focus()
      return
    }
    void handleCreateTag()
  }

  async function handleRenameTag(id: number, name: string) {
    try {
      await api.patchTag(id, { name })
      useOrbital.setState((state) => ({ tags: replaceTag(state.tags, id, { name }) }))
      markSaved()
    } catch (err) {
      reportError(err, 'Failed to rename tag')
    }
  }

  async function handleHue(id: number, hue: number) {
    try {
      await api.patchTag(id, { hue })
      useOrbital.setState((state) => ({ tags: replaceTag(state.tags, id, { hue }) }))
      markSaved()
    } catch (err) {
      reportError(err, 'Failed to update tag color')
    }
  }

  async function handleDeleteTag(tag: Tag) {
    if (tag.is_default) return
    try {
      await api.deleteTag(tag.id)
      useOrbital.setState((state) => ({ tags: state.tags.filter((t) => t.id !== tag.id) }))
      // Delete only ever fires from the selected card, so the selection is
      // now dangling — fall back to the first tag rather than leaving the
      // rules column pointing at a tag that no longer exists.
      setSelectedTagId(null)
      markSaved()
      // The rules column lists every rule, so the deleted tag's rules would
      // sit there as orphan rows until something else refreshed them — the
      // server cascades the delete, so ask it what's left.
      void resyncRules()
      void resyncSessions()
    } catch (err) {
      reportError(err, 'Failed to delete tag')
    }
  }

  async function handleAddRule() {
    // The selected card is a helpful DEFAULT for the new rule's target tag,
    // not a filter — the rule still appends to the one global list.
    const targetTagId = effectiveTagId ?? tags.find((t) => t.is_default)?.id ?? tags[0]?.id
    if (targetTagId == null) return
    try {
      const id = await api.createTagRule({ tagId: targetTagId, condition: 'path_matches', pattern: '' })
      const refreshed = await api.listTagRules()
      useOrbital.setState({ rules: refreshed })
      markSaved()
      // A brand-new rule has nothing to read yet, so it opens straight into
      // edit mode with the caret in its (empty) pattern field.
      openRule(id)
      void resyncSessions()
    } catch (err) {
      reportError(err, 'Failed to add rule')
    }
  }

  /**
   * Puts one row into edit mode, committing and closing whichever row was
   * open before it — canvas 1e only ever draws a single row in edit mode.
   */
  function openRule(id: number) {
    if (editingRuleId === id) return
    if (editingRuleId != null) flushPattern(editingRuleId)
    setEditingRuleId(id)
    focusOnOpen.current = id
  }

  /** Returns the open row to rest, flushing its pending pattern PATCH first. */
  function closeRule(restoreFocus: boolean) {
    if (editingRuleId == null) return
    flushPattern(editingRuleId)
    if (restoreFocus) focusOnClose.current = editingRuleId
    setEditingRuleId(null)
  }

  /**
   * Moves a rule to `toIndex` in the ONE global evaluation order — the order
   * that decides which rule wins is shared by every tag, so a move has to be
   * able to cross a tag boundary.
   *
   * This is the single reorder path: 1e's `⋮⋮` grip drives it by drag AND by
   * ArrowUp/ArrowDown, so mouse and keyboard can never drift apart. It
   * persists through the same `patchTagRule({ position })` endpoint the old
   * up/down arrows used — one PATCH per rule whose position actually changed
   * (a one-step nudge is still exactly two, a long drag is however many it
   * takes), then normalises positions to 0…n-1.
   */
  async function moveRule(rule: TagRule, toIndex: number) {
    const total = sortedRules.length
    const from = sortedRules.findIndex((r) => r.id === rule.id)
    if (from < 0) return
    const to = Math.max(0, Math.min(total - 1, toIndex))
    const tagName = tags.find((t) => t.id === rule.tag_id)?.name ?? 'unknown tag'
    const label = describeRule(rule, tagName, patternDrafts[rule.id] ?? rule.pattern)
    if (to === from) {
      // Dropping a row on itself, or pressing Arrow at either end. Say so
      // rather than leaving a keyboard user wondering whether the key worked.
      setReorderStatus(`${label} is already at position ${from + 1} of ${total}`)
      return
    }

    // A pattern PATCH still sitting in its debounce must not land after the
    // reorder — same commit-on-exit contract the row modes use.
    if (editingRuleId != null) flushPattern(editingRuleId)

    const next = [...sortedRules]
    next.splice(from, 1)
    next.splice(to, 0, rule)
    const changed = next
      .map((r, i) => ({ id: r.id, position: i, was: r.position }))
      .filter((c) => c.was !== c.position)
    if (!changed.length) return

    // Optimistic: the list has to re-render under the pointer (and under the
    // caret, for a held-down Arrow key) before the round trip comes back. A
    // failure resyncs from the server below, which is the authority anyway.
    const positions = new Map(changed.map((c) => [c.id, c.position]))
    useOrbital.setState((state) => ({
      rules: state.rules.map((r) => {
        const position = positions.get(r.id)
        return position === undefined ? r : { ...r, position }
      }),
    }))
    setReorderStatus(`${label} moved to position ${to + 1} of ${total}`)

    try {
      await Promise.all(changed.map((c) => api.patchTagRule(c.id, { position: c.position })))
      markSaved()
      void resyncSessions()
    } catch (err) {
      reportError(err, 'Failed to reorder rules')
      // The PATCHes aren't transactional — some can have landed server-side
      // while another rejected, so a plain toast would leave the store's
      // (now optimistically reordered) view silently wrong. Refetch to find
      // out what the server actually ended up with.
      void resyncRules()
    }
  }

  async function handleCondition(rule: TagRule, condition: TagRule['condition']) {
    try {
      await api.patchTagRule(rule.id, { condition })
      useOrbital.setState((state) => ({ rules: replaceRule(state.rules, rule.id, { condition }) }))
      markSaved()
      void resyncSessions()
    } catch (err) {
      reportError(err, 'Failed to update rule')
      void resyncRules()
    }
  }

  function commitPattern(ruleId: number, value: string) {
    delete patternTimers.current[ruleId]
    delete patternPending.current[ruleId]
    api
      .patchTagRule(ruleId, { pattern: value })
      .then(() => {
        useOrbital.setState((state) => ({ rules: replaceRule(state.rules, ruleId, { pattern: value }) }))
        markSaved()
        void resyncSessions()
      })
      .catch((err) => {
        reportError(err, 'Failed to update rule pattern')
        void resyncRules()
      })
  }

  function handlePatternDraft(rule: TagRule, value: string) {
    setPatternDrafts((drafts) => ({ ...drafts, [rule.id]: value }))
    patternPending.current[rule.id] = value

    const existing = patternTimers.current[rule.id]
    if (existing) clearTimeout(existing)

    patternTimers.current[rule.id] = setTimeout(() => commitPattern(rule.id, value), DEBOUNCE_MS)
  }

  /**
   * Sends a row's in-flight pattern edit now instead of waiting out the
   * debounce — leaving edit mode (another row opened, Escape, Enter, focus
   * left the row) has to COMMIT, not discard.
   */
  function flushPattern(ruleId: number) {
    const timer = patternTimers.current[ruleId]
    if (!timer) return
    clearTimeout(timer)
    const pending = patternPending.current[ruleId]
    if (pending === undefined) {
      delete patternTimers.current[ruleId]
      return
    }
    commitPattern(ruleId, pending)
  }

  async function handleTargetTag(rule: TagRule, tagId: number) {
    try {
      await api.patchTagRule(rule.id, { tag_id: tagId })
      useOrbital.setState((state) => ({ rules: replaceRule(state.rules, rule.id, { tag_id: tagId }) }))
      markSaved()
      void resyncSessions()
    } catch (err) {
      reportError(err, 'Failed to update rule target tag')
      void resyncRules()
    }
  }

  async function handleEnabled(rule: TagRule, enabled: boolean) {
    const next: 0 | 1 = enabled ? 1 : 0
    try {
      await api.patchTagRule(rule.id, { enabled: next })
      useOrbital.setState((state) => ({ rules: replaceRule(state.rules, rule.id, { enabled: next }) }))
      markSaved()
      void resyncSessions()
    } catch (err) {
      reportError(err, 'Failed to toggle rule')
      void resyncRules()
    }
  }

  async function handleDeleteRule(rule: TagRule) {
    try {
      // Drop any pending pattern PATCH for a row that's about to cease to
      // exist, and take it out of edit mode if that's where it was.
      const timer = patternTimers.current[rule.id]
      if (timer) clearTimeout(timer)
      delete patternTimers.current[rule.id]
      delete patternPending.current[rule.id]
      if (editingRuleId === rule.id) setEditingRuleId(null)
      await api.deleteTagRule(rule.id)
      useOrbital.setState((state) => ({ rules: state.rules.filter((r) => r.id !== rule.id) }))
      markSaved()
      void resyncSessions()
    } catch (err) {
      reportError(err, 'Failed to delete rule')
      void resyncRules()
    }
  }

  const previewTag = previewResult?.tagId != null ? tags.find((t) => t.id === previewResult.tagId) : undefined
  const previewRuleIndex =
    previewResult?.ruleId != null ? sortedRules.findIndex((r) => r.id === previewResult.ruleId) + 1 : null

  return (
    // The rows' select popups open inside this section, so they must outrank
    // both it and the dialog for Escape (see `ui/escapeLayer`). A provider
    // renders no DOM, so the two columns below stay direct grid items of
    // Settings' body.
    <EscapeBoundary>
          {/* Left: tags. The column's 330px width is Settings' grid to set —
              what lives here is the column's own chrome (1e: 18/20/10 header,
              12px list gutter). */}
          <div className="flex min-h-0 flex-col border-r border-panel-border/60">
            <div className="flex items-center px-5 pb-2.5 pt-[18px] font-mono text-[10px] tracking-[0.18em] text-text-muted">
              TAGS · {tags.length}
              <span className="flex-1" />
              <button
                type="button"
                onClick={handleNewTagClick}
                className="font-mono tracking-[0.04em] text-accent transition-opacity hover:opacity-80"
              >
                + new tag
              </button>
            </div>

            <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3">
              {tags.map((tag) => {
                const isSelected = tag.id === effectiveTagId
                return (
                  // Canvas 1e: the selected card marks its rules on the right,
                  // is tinted in the tag's OWN hue (border …/.4 over a …/.06
                  // fill) and is the only one showing swatches + delete.
                  // Clicking the card body toggles the selection; the inner
                  // controls stop the click so renaming or recolouring never
                  // deselects out from under you. Keyboard users get the same
                  // toggle on the planet button below — selection used to
                  // follow focus instead, which made deselecting impossible
                  // (focus landing back in the card re-selected it at once).
                  <li
                    key={tag.id}
                    data-tag-card={tag.id}
                    data-selected={isSelected}
                    aria-current={isSelected ? 'true' : undefined}
                    onClick={() => toggleTagSelection(tag.id)}
                    style={
                      isSelected
                        ? {
                            borderColor: `oklch(80% .13 ${tag.hue} / .4)`,
                            background: `oklch(80% .13 ${tag.hue} / .06)`,
                          }
                        : undefined
                    }
                    className={[
                      'cursor-pointer rounded-xl border transition-colors',
                      isSelected
                        ? 'flex flex-col gap-3 p-3.5'
                        : 'flex items-center gap-3 border-[rgba(150,205,255,.1)] px-3.5 py-3 hover:bg-white/5',
                    ].join(' ')}
                  >
                    <div className="flex items-center gap-3">
                      {/* The planet is 1e's anchor for the card, so it doubles
                          as the keyboard-reachable select/DEselect toggle —
                          `aria-pressed` carries the state, no extra chrome. */}
                      <button
                        type="button"
                        data-tag-select={tag.id}
                        aria-pressed={isSelected}
                        aria-label={`Mark rules for ${tag.name}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleTagSelection(tag.id)
                        }}
                        // `grid` (not the default `block`) so the planet stays
                        // a sized box: `TagPlanet` is a <span>, and an inline
                        // child ignores its own width/height, which collapsed
                        // the 22px marble to a 2px sliver.
                        className="grid shrink-0 place-items-center rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        <TagPlanet hue={tag.hue} selected={isSelected} />
                      </button>
                      <div className="min-w-0 flex-1">
                        {/* 1e marks the editable name with a dashed underline on
                            the selected card (there: inline-block under the
                            text; here it spans the field's width). Renaming
                            must not toggle the card's selection. */}
                        <div
                          onClick={(e) => e.stopPropagation()}
                          className={
                            isSelected ? 'border-b border-dashed border-[rgba(150,205,255,.3)]' : undefined
                          }
                        >
                          <TagNameField tag={tag} onCommit={(name) => void handleRenameTag(tag.id, name)} />
                        </div>
                        <div className="mt-0.5 font-mono text-[10.5px] text-[rgba(160,190,225,.6)]">
                          {tagMeta(tag)}
                        </div>
                      </div>
                      <span className="shrink-0 font-mono text-[10.5px] text-[rgba(160,190,225,.55)]">
                        hue {tag.hue}
                      </span>
                    </div>

                    {isSelected && (
                      // Recolouring or deleting must not toggle the card off.
                      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        {/* 1e gaps the swatches by 8px, but that row does not
                            fit the 330px column it now lives in: eight 22px
                            swatches plus the 8px gaps plus "delete" come to
                            ~280px against ~277px of card, so the canvas's own
                            mock overflows by a hair and ours (two more pixels
                            of panel border) clips the word. 6px buys back the
                            difference; wrapping the row instead would drop
                            "delete" onto a line of its own. */}
                        <div className="flex items-center gap-1.5" role="group" aria-label={`Hue for ${tag.name}`}>
                          {HUE_SWATCHES.map((hue) => (
                            <button
                              key={hue}
                              type="button"
                              aria-label={`Hue ${hue}`}
                              aria-pressed={tag.hue === hue}
                              onClick={() => void handleHue(tag.id, hue)}
                              // 1e: 22px swatch, current one ringed with a 2px
                              // white outline at 2px offset.
                              className="h-[22px] w-[22px] shrink-0 rounded-full outline-white aria-pressed:outline-2 aria-pressed:outline-offset-2"
                              style={{ background: tagColor(hue) }}
                            />
                          ))}
                        </div>
                        <span className="flex-1" />
                        <button
                          type="button"
                          disabled={Boolean(tag.is_default)}
                          onClick={() => void handleDeleteTag(tag)}
                          aria-label={`Delete ${tag.name}`}
                          className="shrink-0 font-mono text-[11px] text-[rgba(160,190,225,.6)] transition-colors hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-[rgba(160,190,225,.6)]"
                        >
                          delete
                        </button>
                      </div>
                    )}
                  </li>
                )
              })}

              {/* Ours, not 1e's: 1e creates from the header and renames in
                  place, but a name has to come from somewhere — a dashed row
                  mirroring the rules table's "+ Add rule". */}
              <li className="rounded-xl border border-dashed border-[rgba(150,205,255,.2)] px-3 py-1.5">
                <Input
                  id={NEW_TAG_FIELD_ID}
                  variant="inline"
                  aria-label="New tag name"
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleCreateTag()
                  }}
                  placeholder="New tag name…"
                />
              </li>
            </ul>

            <p className="px-5 pb-5 pt-3.5 text-[11.5px] leading-[1.5] text-[rgba(160,190,225,.6)]">
              Tag hue drives the planet&apos;s atmosphere and ring. Untagged sessions fall back to{' '}
              <span className="font-mono text-[rgba(200,220,245,.8)]">{defaultTag?.name ?? 'the default tag'}</span>.
            </p>
          </div>

          {/* Right: the selected tag's rules */}
          <div className="flex min-h-0 flex-col">
            <div className="flex items-center gap-3 px-[22px] pb-2.5 pt-[18px] font-mono text-[10px] tracking-[0.18em] text-text-muted">
              AUTO-TAG RULES · {sortedRules.length}
              <span className="flex-1" />
              <span className="tracking-[0.04em] text-[rgba(160,190,225,.5)]">
                evaluated top → bottom, first match wins
              </span>
            </div>

            {/* Column captions (1e: 9.5px mono at .14em, 6px 28px). The list
                below insets by 20px and each row by another 8px, so the two
                grids line up on the same 28px gutter. */}
            <div
              className={`grid ${RULE_GRID} items-center gap-3 px-[22px] py-1.5 font-mono text-[9.5px] tracking-[0.14em] text-[rgba(160,190,225,.45)]`}
            >
              <span />
              <span>CONDITION</span>
              <span>PATTERN</span>
              <span>→ TAG</span>
              <span>ON</span>
              <span />
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3.5">
              {sortedRules.map((rule, idx) => {
                const ruleTag = tags.find((t) => t.id === rule.tag_id)
                const hue = ruleTag?.hue ?? 210
                const tagName = ruleTag?.name ?? 'unknown tag'
                const editing = editingRuleId === rule.id
                const enabled = rule.enabled === 1
                const pattern = patternDrafts[rule.id] ?? rule.pattern
                const regexError = rule.condition === 'path_matches' ? patternError(pattern) : null
                /** Selecting a tag card MARKS its rules here — it never hides the others. */
                const targetsSelected = ruleTag != null && ruleTag.id === effectiveTagId
                const shift = dragShiftFor(idx)

                const rowStyle: CSSProperties = {}
                // The mark is the tag-card treatment from the left column
                // (canvas 1e: hue border at .4 over a .06 hue fill), so the
                // two read as the same object. Deliberately NOT a dim — 1e
                // already spends opacity on disabled rules.
                if (!editing && targetsSelected) {
                  rowStyle.borderColor = `oklch(80% .13 ${hue} / .4)`
                  rowStyle.background = `oklch(80% .13 ${hue} / .06)`
                }
                // Transform only — never top/margin/height, which would
                // relayout the list on every dragover and fight the drag.
                if (shift !== 0) rowStyle.transform = `translateY(${shift}px)`

                return (
                  <div
                    key={rule.id}
                    data-rule-row={rule.id}
                    data-rule-mode={editing ? 'editing' : 'resting'}
                    data-rule-enabled={enabled}
                    data-tag-match={targetsSelected}
                    aria-current={targetsSelected ? 'true' : undefined}
                    data-drop-target={dropIndex === idx && dragRuleId !== rule.id ? 'true' : undefined}
                    data-rule-shift={shift === 0 ? undefined : shift < 0 ? 'up' : 'down'}
                    // Clicking anywhere in a resting row opens it; the toggle,
                    // the grip and the delete button stop the click before it
                    // gets here, so they stay usable in BOTH modes.
                    onClick={editing ? undefined : () => openRule(rule.id)}
                    // Every row is a drop target for a grip drag. `dragOver`
                    // must preventDefault or the browser refuses the drop.
                    onDragOver={
                      dragRuleId == null
                        ? undefined
                        : (e) => {
                            e.preventDefault()
                            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
                            setDropIndex(idx)
                          }
                    }
                    onDrop={
                      dragRuleId == null
                        ? undefined
                        : (e) => {
                            e.preventDefault()
                            const dragged = rules.find((r) => r.id === dragRuleId)
                            setDragRuleId(null)
                            setDropIndex(null)
                            // Dropping a row on itself lands on `to === from`
                            // in moveRule, which no-ops (and says so).
                            if (dragged) void moveRule(dragged, idx)
                          }
                    }
                    onBlur={
                      editing
                        ? (e) => {
                            // Focus left the row entirely (tabbed past the last
                            // control, clicked another control) — commit and
                            // close. `relatedTarget === null` (focus went
                            // nowhere) deliberately leaves the row open.
                            const next = e.relatedTarget
                            if (next instanceof Node && !e.currentTarget.contains(next)) closeRule(false)
                          }
                        : undefined
                    }
                    style={rowStyle}
                    className={[
                      'grid items-center gap-3 rounded-[9px] border px-2 py-[11px]',
                      RULE_GRID,
                      // Exactly ONE transition-property utility is ever in the
                      // list, so there is no ordering race between them: while
                      // a drag is live the rows animate their gap-preview
                      // transform, otherwise they fade colour as before.
                      dragRuleId == null ? 'transition-colors' : DRAG_SHIFT_TRANSITION,
                      editing
                        ? // 1e's edit row: accent border at .5 over a .06 accent fill.
                          'border-accent/50 bg-accent/6'
                        : targetsSelected
                          ? ''
                          : 'border-[rgba(150,205,255,.08)] bg-[rgba(4,8,16,.35)]',
                      // 1e dims a disabled rule rather than restyling it.
                      enabled ? '' : 'opacity-60',
                      // Drag feedback (no 1e equivalent — its mock is static):
                      // the travelling row fades to a placeholder that rides
                      // into the gap it will land in, and the row under the
                      // pointer takes an accent ring.
                      dragRuleId === rule.id ? 'opacity-40' : '',
                      dropIndex === idx && dragRuleId !== rule.id ? 'ring-1 ring-accent/60' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {/* 1e's `⋮⋮` grip, now the real reorder control: draggable
                        with the pointer AND operable from the keyboard with
                        ArrowUp/ArrowDown, because native HTML5 drag-and-drop
                        is not keyboard-accessible on its own and this is the
                        only way to reorder. Visually unchanged from the
                        export. It also carries the row's non-visual "this
                        targets the selected tag" marker, so the mark never
                        rests on colour alone (sr-only is out of flow, so it
                        claims no grid column). */}
                    <span className="relative text-center">
                      <button
                        type="button"
                        data-rule-grip={rule.id}
                        draggable
                        aria-label={`Reorder rule ${idx + 1} of ${sortedRules.length}: ${describeRule(
                          rule,
                          tagName,
                          pattern,
                        )}`}
                        title="Drag to reorder, or press arrow up / arrow down"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
                          // Stop the scroll container from scrolling instead.
                          e.preventDefault()
                          focusGrip.current = rule.id
                          void moveRule(rule, e.key === 'ArrowUp' ? idx - 1 : idx + 1)
                        }}
                        onDragStart={(e) => {
                          const rowEl = e.currentTarget.closest('[data-rule-row]')
                          // Measure every row's slot in ONE read pass, before
                          // anything writes to the DOM, so the gap preview
                          // never interleaves reads and writes mid-drag.
                          if (rowEl instanceof HTMLElement) {
                            const slots = new Map<number, number>()
                            rowEl.parentElement
                              ?.querySelectorAll<HTMLElement>('[data-rule-row]')
                              .forEach((el) => {
                                slots.set(Number(el.dataset.ruleRow), el.offsetHeight + RULE_ROW_GAP)
                              })
                            rowSlots.current = slots
                          }
                          setDragRuleId(rule.id)
                          // Same commit-on-exit contract as leaving a row:
                          // a debounced pattern PATCH must not land after the
                          // reorder it was interleaved with.
                          if (editingRuleId != null) flushPattern(editingRuleId)
                          const dt = e.dataTransfer
                          if (!dt) return
                          dt.effectAllowed = 'move'
                          // Firefox refuses to start a drag without payload.
                          dt.setData('text/plain', String(rule.id))
                          if (rowEl instanceof HTMLElement && typeof dt.setDragImage === 'function') {
                            dt.setDragImage(rowEl, 16, rowEl.offsetHeight / 2)
                          }
                        }}
                        // Fires whether the drop was accepted or the row was
                        // released outside the list — either way, clean up.
                        onDragEnd={() => {
                          setDragRuleId(null)
                          setDropIndex(null)
                          rowSlots.current = new Map()
                        }}
                        className="block w-full cursor-grab rounded text-sm text-[rgba(160,190,225,.4)] transition-colors hover:text-text-soft focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent active:cursor-grabbing"
                      >
                        ⋮⋮
                      </button>
                      {targetsSelected && <span className="sr-only">Targets the selected tag</span>}
                    </span>

                    {editing ? (
                      <>
                        <Select
                          font="sans"
                          className="w-full"
                          aria-label={`Condition for rule ${idx + 1}`}
                          options={CONDITION_OPTIONS}
                          value={rule.condition}
                          onChange={(condition) => void handleCondition(rule, condition)}
                        />

                        <Input
                          id={patternFieldId(rule.id)}
                          font="mono"
                          size="sm"
                          aria-label={`Pattern for rule ${idx + 1}`}
                          invalid={regexError != null}
                          title={regexError ?? undefined}
                          placeholder={rule.condition === 'path_matches' ? 'regex, e.g. slothworks/orbital' : undefined}
                          value={pattern}
                          onChange={(e) => handlePatternDraft(rule, e.target.value)}
                          onKeyDown={(e) => {
                            // Enter commits and returns the row to the table.
                            if (e.key === 'Enter') closeRule(true)
                          }}
                          className="min-w-0"
                        />

                        {/* 1e leaves the target tag as a static pill even in
                            edit mode, but its mock has no need to RE-target a
                            rule. Ours does, so in edit mode only, the pill IS
                            the select — `Select`'s `pill` variant owns the
                            dot, the hue-tinted border and the chevron. */}
                        <Select
                          variant="pill"
                          font="sans"
                          className="min-w-0"
                          aria-label={`Target tag for rule ${idx + 1}`}
                          options={tagOptions}
                          value={rule.tag_id}
                          onChange={(tagId) => void handleTargetTag(rule, tagId)}
                        />
                      </>
                    ) : (
                      // At rest the three reading columns are ONE button
                      // spanning them (subgrid keeps it on the table's own
                      // tracks). A button whose children are all plain spans
                      // stays valid markup — no interactive nesting — and is
                      // what makes the row openable from the keyboard.
                      <button
                        type="button"
                        data-rule-open={rule.id}
                        aria-label={`Edit rule ${idx + 1}: ${conditionLabel(rule.condition)} ${
                          pattern || '(no pattern)'
                        } → ${tagName}`}
                        onClick={() => openRule(rule.id)}
                        className="col-span-3 grid grid-cols-subgrid items-center rounded-[5px] text-left focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                      >
                        {/* 1e resting row: 13px sans condition, 12px mono pattern. */}
                        <span className="truncate text-[13px]">{conditionLabel(rule.condition)}</span>
                        <span className="truncate font-mono text-[12px] text-text-bright">
                          {pattern || <span className="text-text-muted">—</span>}
                        </span>
                        <TagPill hue={hue} name={tagName} />
                      </button>
                    )}

                    {/* The ON switch is identical in both of 1e's modes. */}
                    <span onClick={(e) => e.stopPropagation()}>
                      <Toggle
                        aria-label={`Enable rule ${idx + 1}`}
                        checked={enabled}
                        onChange={(checked) => void handleEnabled(rule, checked)}
                      />
                    </span>

                    {/* Delete stays live in both modes — removing a rule must
                        never be gated behind opening it first. Reordering is
                        not here: it belongs to the grip. */}
                    <div className="flex items-center justify-end" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        aria-label={`Delete rule ${idx + 1}`}
                        onClick={() => void handleDeleteRule(rule)}
                        className="h-5 w-5 rounded text-text-muted transition-colors hover:bg-red-400/10 hover:text-red-400"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                )
              })}

              {/* 1e: a dashed row spanning the table, not a button in the header. */}
              <button
                type="button"
                data-testid="add-rule-row"
                onClick={() => void handleAddRule()}
                className="flex w-full items-center justify-center gap-2 rounded-[9px] border border-dashed border-[rgba(150,205,255,.2)] p-3 text-[12.5px] font-semibold text-accent transition-colors hover:border-accent/50 hover:bg-accent/5"
              >
                + Add rule
              </button>
            </div>

            {/* Reorder announcements. Neither native drag-and-drop nor a
                keyboard move announces itself, so every move reports where
                the rule landed, politely (never interrupting). */}
            <p role="status" aria-live="polite" data-testid="reorder-status" className="sr-only">
              {reorderStatus}
            </p>

            {/* Preview footer (1e: PREVIEW · path · → · chip · matched rule N). */}
            <div
              data-testid="preview-result"
              className="mx-[22px] mb-5 mt-3 flex flex-wrap items-center gap-3 rounded-[9px] border border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.35)] px-3.5 py-3"
            >
              <span className="shrink-0 font-mono text-[10px] tracking-[0.16em] text-[rgba(160,190,225,.55)]">
                PREVIEW
              </span>
              <Input
                variant="inline"
                font="mono"
                aria-label="Sample path"
                value={previewPath}
                onChange={(e) => setPreviewPath(e.target.value)}
                placeholder="~/experiments/exp-vector-search"
                className="min-w-0 flex-1"
              />
              {previewTag ? (
                <>
                  <span aria-hidden data-testid="preview-arrow" className="shrink-0 text-[rgba(160,190,225,.5)]">
                    →
                  </span>
                  <Chip label={previewTag.name} hue={previewTag.hue} active />
                  {previewRuleIndex != null && previewRuleIndex > 0 && (
                    <span className="shrink-0 font-mono text-[10.5px] text-[rgba(160,190,225,.5)]">
                      matched rule {previewRuleIndex}
                    </span>
                  )}
                </>
              ) : previewPath.trim() ? (
                <span className="shrink-0 font-mono text-[10.5px] text-[rgba(160,190,225,.5)]">no match</span>
              ) : null}
            </div>
          </div>
    </EscapeBoundary>
  )
}
