import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { tagColor } from '../lib/types'
import type { Tag, TagRule } from '../lib/types'
import { Panel } from '../ui/Panel'
import { Select } from '../ui/Select'
import { Toggle } from '../ui/Checkbox'
import { Input } from '../ui/Input'
import { Chip } from '../ui/Chip'

export interface TagsRulesProps {
  open: boolean
  onClose: () => void
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
 * Tag list + auto-tag rule table (artboard 1e), rendered as the same
 * 1120×740 floating glass panel `Settings` (artboard 1h) uses — back
 * chevron, SETTINGS kicker, title, save status — with a two-column body:
 * tags on the left (400px, per the export), the selected tag's rules on the
 * right. Entered from the sidebar footer's "tags & rules" row or from
 * Settings' nav.
 */
export function TagsRules({ open, onClose }: TagsRulesProps) {
  const tags = useOrbital(useShallow((s) => s.tags))
  const rules = useOrbital(useShallow((s) => s.rules))
  const sessions = useOrbital(useShallow((s) => s.sessions))

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
   * Text for the polite live region under the rules list. Native drag-and-drop
   * announces nothing, and a keyboard move that only changed DOM order would
   * be silent too, so every reorder (mouse or keyboard) reports where the rule
   * landed.
   */
  const [reorderStatus, setReorderStatus] = useState('')
  /** Drives the header's "saved · just now" (canvas 1e) — set by every mutation that actually landed. */
  const [saved, setSaved] = useState(false)

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

  // The panel stays mounted across `open`, so the save status has to be
  // cleared on entry — "just now" must never be left over from a past visit.
  useEffect(() => {
    if (open) {
      setSaved(false)
      setEditingRuleId(null)
      setReorderStatus('')
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Escape peels one layer at a time: an open rule row first, the panel
      // only once every row is back at rest.
      if (editingRuleId != null) {
        closeRule(true)
        return
      }
      onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose, editingRuleId])

  // Sample-path preview, debounced.
  useEffect(() => {
    if (!open || !previewPath.trim()) {
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
  }, [open, previewPath])

  if (!open) return null

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
      setSaved(true)
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
      setSaved(true)
    } catch (err) {
      reportError(err, 'Failed to rename tag')
    }
  }

  async function handleHue(id: number, hue: number) {
    try {
      await api.patchTag(id, { hue })
      useOrbital.setState((state) => ({ tags: replaceTag(state.tags, id, { hue }) }))
      setSaved(true)
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
      setSaved(true)
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
      setSaved(true)
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
      setSaved(true)
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
      setSaved(true)
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
        setSaved(true)
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
      setSaved(true)
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
      setSaved(true)
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
      setSaved(true)
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
    // Scrim verbatim from artboard 1e: rgba(2,4,9,.5) + a 3px blur.
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(2,4,9,.5)] p-6 backdrop-blur-[3px]">
      <Panel
        side="float"
        className="flex h-[740px] max-h-full w-full max-w-[1120px] flex-col overflow-hidden"
      >
        {/* Header (1e: 22px 28px 18px, back chevron · kicker + title · save status). */}
        <div className="flex items-center gap-3.5 border-b border-panel-border/60 px-7 pb-[18px] pt-[22px]">
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-[7px] border border-panel-border text-sm text-text-muted transition-colors hover:bg-white/5 hover:text-text-bright"
          >
            ‹
          </button>
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[10px] tracking-[0.2em] text-accent/80">SETTINGS</div>
            <h2 className="mt-1 text-xl font-bold tracking-[-0.01em] text-text-bright">Tags &amp; rules</h2>
          </div>
          {saved && (
            <span
              data-testid="save-status"
              className="shrink-0 font-mono text-[10.5px] tracking-[0.06em] text-text-muted"
            >
              saved · just now
            </span>
          )}
        </div>

        {/* 1e's body grid is a fixed 400px tags column + the rules column; below
            `lg` the two stack so neither gets squeezed into unreadability. */}
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[400px_minmax(0,1fr)]">
          {/* Left: tags */}
          <div className="flex min-h-0 flex-col border-b border-panel-border/60 lg:border-b-0 lg:border-r lg:border-r-panel-border/60">
            <div className="flex items-center px-6 pb-2.5 pt-[18px] font-mono text-[10px] tracking-[0.18em] text-text-muted">
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

            <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-4">
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
                        <div className="flex items-center gap-2" role="group" aria-label={`Hue for ${tag.name}`}>
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

            <p className="px-6 pb-5 pt-3.5 text-[11.5px] leading-[1.5] text-[rgba(160,190,225,.6)]">
              Tag hue drives the planet&apos;s atmosphere and ring. Untagged sessions fall back to{' '}
              <span className="font-mono text-[rgba(200,220,245,.8)]">{defaultTag?.name ?? 'the default tag'}</span>.
            </p>
          </div>

          {/* Right: the selected tag's rules */}
          <div className="flex min-h-0 flex-col">
            <div className="flex items-center gap-3 px-7 pb-2.5 pt-[18px] font-mono text-[10px] tracking-[0.18em] text-text-muted">
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
              className={`grid ${RULE_GRID} items-center gap-3 px-7 py-1.5 font-mono text-[9.5px] tracking-[0.14em] text-[rgba(160,190,225,.45)]`}
            >
              <span />
              <span>CONDITION</span>
              <span>PATTERN</span>
              <span>→ TAG</span>
              <span>ON</span>
              <span />
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-5">
              {sortedRules.map((rule, idx) => {
                const ruleTag = tags.find((t) => t.id === rule.tag_id)
                const hue = ruleTag?.hue ?? 210
                const tagName = ruleTag?.name ?? 'unknown tag'
                const editing = editingRuleId === rule.id
                const enabled = rule.enabled === 1
                const pattern = patternDrafts[rule.id] ?? rule.pattern
                /** Selecting a tag card MARKS its rules here — it never hides the others. */
                const targetsSelected = ruleTag != null && ruleTag.id === effectiveTagId

                return (
                  <div
                    key={rule.id}
                    data-rule-row={rule.id}
                    data-rule-mode={editing ? 'editing' : 'resting'}
                    data-rule-enabled={enabled}
                    data-tag-match={targetsSelected}
                    aria-current={targetsSelected ? 'true' : undefined}
                    data-drop-target={dropIndex === idx && dragRuleId !== rule.id ? 'true' : undefined}
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
                    style={
                      // The mark is the tag-card treatment from the left column
                      // (canvas 1e: hue border at .4 over a .06 hue fill), so
                      // the two read as the same object. Deliberately NOT a
                      // dim — 1e already spends opacity on disabled rules.
                      !editing && targetsSelected
                        ? {
                            borderColor: `oklch(80% .13 ${hue} / .4)`,
                            background: `oklch(80% .13 ${hue} / .06)`,
                          }
                        : undefined
                    }
                    className={[
                      'grid items-center gap-3 rounded-[9px] border px-2 py-[11px] transition-colors',
                      RULE_GRID,
                      editing
                        ? // 1e's edit row: accent border at .5 over a .06 accent fill.
                          'border-accent/50 bg-accent/6'
                        : targetsSelected
                          ? ''
                          : 'border-[rgba(150,205,255,.08)] bg-[rgba(4,8,16,.35)]',
                      // 1e dims a disabled rule rather than restyling it.
                      enabled ? '' : 'opacity-60',
                      // Drag feedback (no 1e equivalent — its mock is static):
                      // the travelling row fades, the row under the pointer
                      // takes an accent ring so the landing slot is obvious.
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
                          const row = e.currentTarget.closest('[data-rule-row]')
                          if (row instanceof HTMLElement && typeof dt.setDragImage === 'function') {
                            dt.setDragImage(row, 16, row.offsetHeight / 2)
                          }
                        }}
                        // Fires whether the drop was accepted or the row was
                        // released outside the list — either way, clean up.
                        onDragEnd={() => {
                          setDragRuleId(null)
                          setDropIndex(null)
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
                          value={rule.condition}
                          onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                            void handleCondition(rule, e.target.value as TagRule['condition'])
                          }
                        >
                          {CONDITION_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </Select>

                        <Input
                          id={patternFieldId(rule.id)}
                          font="mono"
                          size="sm"
                          aria-label={`Pattern for rule ${idx + 1}`}
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
                            the select: dot and chevron painted around a
                            transparent native control (`color-scheme: dark`
                            keeps the popup on-theme, since the select itself
                            contributes no background). */}
                        <span
                          className="relative inline-flex min-w-0 items-center rounded-full border py-[3px] pl-[9px] pr-6"
                          style={{ borderColor: `oklch(80% .13 ${hue} / .4)` }}
                        >
                          <span
                            aria-hidden
                            className="mr-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                            style={{ background: tagColor(hue) }}
                          />
                          <select
                            aria-label={`Target tag for rule ${idx + 1}`}
                            value={rule.tag_id}
                            onChange={(e) => void handleTargetTag(rule, Number(e.target.value))}
                            style={{ colorScheme: 'dark' }}
                            className="min-w-0 flex-1 cursor-pointer appearance-none bg-transparent text-[11px] font-semibold text-text-bright focus:outline-none"
                          >
                            {tags.map((tag) => (
                              <option key={tag.id} value={tag.id}>
                                {tag.name}
                              </option>
                            ))}
                          </select>
                          <span
                            aria-hidden
                            className="pointer-events-none absolute right-2 text-[9px] text-text-muted"
                          >
                            ▾
                          </span>
                        </span>
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
              className="mx-7 mb-5 mt-3 flex items-center gap-3 rounded-[9px] border border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.35)] px-3.5 py-3"
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
        </div>
      </Panel>
    </div>
  )
}
