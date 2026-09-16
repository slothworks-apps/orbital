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
 * trailing 68px is a row-actions column 1e's static mock has no need for —
 * it draws a drag grip, but drag-to-reorder is deferred, so the working
 * reorder arrows and the delete control live here instead. Every column is
 * `minmax(0, …)` so a narrow window squeezes the table instead of clipping
 * the actions off the right edge. The header row, every rule row and the
 * column captions all share this one definition so they stay aligned.
 */
const RULE_GRID = 'grid-cols-[24px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,130px)_44px_68px]'

/** Id (not a ref — `Input` doesn't take one) so the header's "+ new tag" can focus the field when it's empty. */
const NEW_TAG_FIELD_ID = 'tags-rules-new-tag'

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
      className="h-[22px] w-[22px] shrink-0 rounded-full"
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
  /** Rules are managed per tag (canvas 1e): the selected tag card on the left drives the rules list. */
  const [selectedTagId, setSelectedTagId] = useState<number | null>(null)
  const [previewPath, setPreviewPath] = useState('')
  const [previewResult, setPreviewResult] = useState<{ tagId: number | null; ruleId: number | null } | null>(null)
  const [patternDrafts, setPatternDrafts] = useState<Record<number, string>>({})
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

  useEffect(() => {
    // Unmount cleanup only — timers are otherwise managed per-call below.
    return () => {
      Object.values(patternTimers.current).forEach(clearTimeout)
    }
  }, [])

  // The panel stays mounted across `open`, so the save status has to be
  // cleared on entry — "just now" must never be left over from a past visit.
  useEffect(() => {
    if (open) setSaved(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

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

  const sortedRules = [...rules].sort((a, b) => a.position - b.position)
  const effectiveTagId = selectedTagId ?? tags[0]?.id ?? null
  const tagRules = sortedRules.filter((r) => r.tag_id === effectiveTagId)
  const defaultTag = tags.find((t) => t.is_default)

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
      void resyncSessions()
    } catch (err) {
      reportError(err, 'Failed to delete tag')
    }
  }

  async function handleAddRule() {
    const targetTagId = effectiveTagId ?? tags.find((t) => t.is_default)?.id ?? tags[0]?.id
    if (targetTagId == null) return
    try {
      await api.createTagRule({ tagId: targetTagId, condition: 'path_matches', pattern: '' })
      const refreshed = await api.listTagRules()
      useOrbital.setState({ rules: refreshed })
      setSaved(true)
      void resyncSessions()
    } catch (err) {
      reportError(err, 'Failed to add rule')
    }
  }

  // Drag-to-reorder (the `⋮⋮` grip artboard 1e draws on every row) is
  // deferred to a later version — the grip is rendered decoratively
  // (`aria-hidden`, not focusable) and the up/down buttons in the row's
  // actions cell do the real work, swapping `position` with the adjacent row
  // via two PATCHes. That expresses the same first-match-wins ordering
  // without a drag-and-drop implementation in v1.
  async function handleReorder(rule: TagRule, direction: 'up' | 'down') {
    // Swap within the selected tag's own list — the design manages rules per
    // tag, so "up/down" means the neighbor of the same tag.
    const idx = tagRules.findIndex((r) => r.id === rule.id)
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1
    if (idx < 0 || swapIdx < 0 || swapIdx >= tagRules.length) return
    const other = tagRules[swapIdx]
    try {
      await Promise.all([
        api.patchTagRule(rule.id, { position: other.position }),
        api.patchTagRule(other.id, { position: rule.position }),
      ])
      useOrbital.setState((state) => ({
        rules: state.rules.map((r) => {
          if (r.id === rule.id) return { ...r, position: other.position }
          if (r.id === other.id) return { ...r, position: rule.position }
          return r
        }),
      }))
      setSaved(true)
      void resyncSessions()
    } catch (err) {
      reportError(err, 'Failed to reorder rules')
      // The two PATCHes above aren't transactional — one can have already
      // landed server-side while the other rejected, so a plain toast would
      // leave the store's optimistic-free (but now stale) view silently
      // wrong. Refetch to find out what the server actually ended up with.
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

  function handlePatternDraft(rule: TagRule, value: string) {
    setPatternDrafts((drafts) => ({ ...drafts, [rule.id]: value }))

    const existing = patternTimers.current[rule.id]
    if (existing) clearTimeout(existing)

    patternTimers.current[rule.id] = setTimeout(() => {
      delete patternTimers.current[rule.id]
      api
        .patchTagRule(rule.id, { pattern: value })
        .then(() => {
          useOrbital.setState((state) => ({ rules: replaceRule(state.rules, rule.id, { pattern: value }) }))
          setSaved(true)
          void resyncSessions()
        })
        .catch((err) => {
          reportError(err, 'Failed to update rule pattern')
          void resyncRules()
        })
    }, DEBOUNCE_MS)
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
                  // Canvas 1e: the selected card drives the rules list on the
                  // right, is tinted in the tag's OWN hue (border …/.4 over a
                  // …/.06 fill) and is the only one showing swatches +
                  // delete. Selection follows focus as well as clicks so the
                  // card is reachable by keyboard without wrapping its inner
                  // controls in another interactive element.
                  <li
                    key={tag.id}
                    data-tag-card={tag.id}
                    data-selected={isSelected}
                    aria-current={isSelected ? 'true' : undefined}
                    onClick={() => setSelectedTagId(tag.id)}
                    onFocusCapture={() => setSelectedTagId(tag.id)}
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
                      <TagPlanet hue={tag.hue} selected={isSelected} />
                      <div className="min-w-0 flex-1">
                        {/* 1e marks the editable name with a dashed underline on
                            the selected card (there: inline-block under the
                            text; here it spans the field's width). */}
                        <div
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
                      <div className="flex items-center gap-2">
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
              AUTO-TAG RULES · {tagRules.length}
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
              {tagRules.map((rule, idx) => {
                const ruleTag = tags.find((t) => t.id === rule.tag_id)
                return (
                  <div
                    key={rule.id}
                    data-rule-row={rule.id}
                    className={[
                      'grid items-center gap-3 rounded-[9px] border border-[rgba(150,205,255,.08)] bg-[rgba(4,8,16,.35)] px-2 py-[11px]',
                      RULE_GRID,
                      // 1e dims a disabled rule rather than restyling it.
                      rule.enabled === 1 ? '' : 'opacity-60',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {/* Drag grip: decorative only — drag-to-reorder is deferred,
                        so it is never focusable and carries no label; the arrows
                        in the actions cell are the working control. */}
                    <span aria-hidden data-rule-grip className="text-center text-sm text-[rgba(160,190,225,.4)]">
                      ⋮⋮
                    </span>

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
                      font="mono"
                      aria-label={`Pattern for rule ${idx + 1}`}
                      value={patternDrafts[rule.id] ?? rule.pattern}
                      onChange={(e) => handlePatternDraft(rule, e.target.value)}
                      className="min-w-0"
                    />

                    {/* 1e draws the target tag as a hue-bordered pill. Ours has
                        to stay editable, so the pill IS the select: dot and
                        chevron are painted around a transparent native control
                        (`color-scheme: dark` keeps the popup on-theme, since
                        the select itself contributes no background). */}
                    <span
                      className="relative inline-flex min-w-0 items-center rounded-full border py-[3px] pl-[9px] pr-6"
                      style={{ borderColor: `oklch(80% .13 ${ruleTag?.hue ?? 210} / .4)` }}
                    >
                      <span
                        aria-hidden
                        className="mr-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: tagColor(ruleTag?.hue ?? 210) }}
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

                    <Toggle
                      aria-label={`Enable rule ${idx + 1}`}
                      checked={rule.enabled === 1}
                      onChange={(checked) => void handleEnabled(rule, checked)}
                    />

                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        aria-label={`Move rule ${idx + 1} up`}
                        disabled={idx === 0}
                        onClick={() => void handleReorder(rule, 'up')}
                        className="h-5 w-5 rounded text-text-muted transition-colors hover:bg-white/5 hover:text-text-bright disabled:opacity-25 disabled:hover:bg-transparent"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label={`Move rule ${idx + 1} down`}
                        disabled={idx === tagRules.length - 1}
                        onClick={() => void handleReorder(rule, 'down')}
                        className="h-5 w-5 rounded text-text-muted transition-colors hover:bg-white/5 hover:text-text-bright disabled:opacity-25 disabled:hover:bg-transparent"
                      >
                        ↓
                      </button>
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
