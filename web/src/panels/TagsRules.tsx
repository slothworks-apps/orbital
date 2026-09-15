import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { tagColor } from '../lib/types'
import type { Tag, TagRule } from '../lib/types'
import { Panel } from '../ui/Panel'
import { Button } from '../ui/Button'
import { Select } from '../ui/Select'
import { Toggle } from '../ui/Checkbox'
import { Input } from '../ui/Input'
import { Chip } from '../ui/Chip'

export interface TagsRulesProps {
  open: boolean
  onClose: () => void
}

/** The design canvas's 8-swatch hue picker (artboard 1e). */
const HUE_SWATCHES = [210, 225, 270, 330, 10, 60, 90, 150]

const CONDITION_OPTIONS: Array<{ value: TagRule['condition']; label: string }> = [
  { value: 'path_matches', label: 'path matches' },
  { value: 'title_contains', label: 'title contains' },
  { value: 'permission_is', label: 'permission is' },
]

/** Debounce for the pattern/preview text inputs — same window as the rest of the app's debounced PATCHes. */
const DEBOUNCE_MS = 400

function replaceTag(tags: Tag[], id: number, patch: Partial<Tag>): Tag[] {
  return tags.map((t) => (t.id === id ? { ...t, ...patch } : t))
}

function replaceRule(rules: TagRule[], id: number, patch: Partial<TagRule>): TagRule[] {
  return rules.map((r) => (r.id === id ? { ...r, ...patch } : r))
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
 * Tag list + auto-tag rule table (artboard 1e), rendered as an overlay
 * `Panel` (not `Dialog` — too much content for the ~28rem modal width) from
 * the sidebar footer's "tags & rules" entry point.
 */
export function TagsRules({ open, onClose }: TagsRulesProps) {
  const tags = useOrbital(useShallow((s) => s.tags))
  const rules = useOrbital(useShallow((s) => s.rules))
  const sessions = useOrbital(useShallow((s) => s.sessions))

  const [newTagName, setNewTagName] = useState('')
  const [previewPath, setPreviewPath] = useState('')
  const [previewResult, setPreviewResult] = useState<{ tagId: number | null; ruleId: number | null } | null>(null)
  const [patternDrafts, setPatternDrafts] = useState<Record<number, string>>({})

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

  function sessionCount(tagId: number): number {
    return Object.values(sessions).filter((s) => s.tagIds.includes(tagId)).length
  }

  function ruleCount(tagId: number): number {
    return rules.filter((r) => r.tag_id === tagId).length
  }

  async function handleCreateTag() {
    const name = newTagName.trim()
    if (!name) return
    try {
      await api.createTag({ name, hue: HUE_SWATCHES[tags.length % HUE_SWATCHES.length] })
      const refreshed = await api.listTags()
      useOrbital.setState({ tags: refreshed })
      setNewTagName('')
    } catch (err) {
      reportError(err, 'Failed to create tag')
    }
  }

  async function handleRenameTag(id: number, name: string) {
    try {
      await api.patchTag(id, { name })
      useOrbital.setState((state) => ({ tags: replaceTag(state.tags, id, { name }) }))
    } catch (err) {
      reportError(err, 'Failed to rename tag')
    }
  }

  async function handleHue(id: number, hue: number) {
    try {
      await api.patchTag(id, { hue })
      useOrbital.setState((state) => ({ tags: replaceTag(state.tags, id, { hue }) }))
    } catch (err) {
      reportError(err, 'Failed to update tag color')
    }
  }

  async function handleDeleteTag(tag: Tag) {
    if (tag.is_default) return
    try {
      await api.deleteTag(tag.id)
      useOrbital.setState((state) => ({ tags: state.tags.filter((t) => t.id !== tag.id) }))
      void resyncSessions()
    } catch (err) {
      reportError(err, 'Failed to delete tag')
    }
  }

  async function handleAddRule() {
    const targetTagId = tags.find((t) => t.is_default)?.id ?? tags[0]?.id
    if (targetTagId == null) return
    try {
      await api.createTagRule({ tagId: targetTagId, condition: 'path_matches', pattern: '' })
      const refreshed = await api.listTagRules()
      useOrbital.setState({ rules: refreshed })
      void resyncSessions()
    } catch (err) {
      reportError(err, 'Failed to add rule')
    }
  }

  // Drag-to-reorder (as sketched in artboard 1e) is deferred to a later
  // version — up/down buttons swap `position` with the adjacent row instead
  // via two PATCHes, which is enough to express the same first-match-wins
  // ordering without a drag-and-drop implementation in v1.
  async function handleReorder(rule: TagRule, direction: 'up' | 'down') {
    const idx = sortedRules.findIndex((r) => r.id === rule.id)
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1
    if (idx < 0 || swapIdx < 0 || swapIdx >= sortedRules.length) return
    const other = sortedRules[swapIdx]
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-space/70 p-6 backdrop-blur-sm">
      <Panel
        side="float"
        className="flex max-h-full w-full max-w-4xl flex-col gap-4 overflow-y-auto p-5"
      >
        <div className="flex items-center justify-between">
          <h2 className="font-mono text-sm font-semibold tracking-wide text-text-soft">Tags &amp; rules</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            Close
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          {/* Left: tag list */}
          <div className="flex flex-col gap-3">
            <h3 className="font-mono text-[11px] tracking-[0.15em] text-text-muted">TAGS</h3>
            <ul className="flex flex-col gap-2">
              {tags.map((tag) => (
                <li key={tag.id} className="flex flex-col gap-1.5 rounded-md border border-panel-border p-2">
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: tagColor(tag.hue) }}
                    />
                    <TagNameField tag={tag} onCommit={(name) => void handleRenameTag(tag.id, name)} />
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={Boolean(tag.is_default)}
                      onClick={() => void handleDeleteTag(tag)}
                      aria-label={`Delete ${tag.name}`}
                    >
                      Delete
                    </Button>
                  </div>
                  <div className="font-mono text-[11px] text-text-muted">
                    {sessionCount(tag.id)} sessions · {ruleCount(tag.id)} rules
                  </div>
                  <div className="flex flex-wrap gap-1" role="group" aria-label={`Hue for ${tag.name}`}>
                    {HUE_SWATCHES.map((hue) => (
                      <button
                        key={hue}
                        type="button"
                        aria-label={`Hue ${hue}`}
                        aria-pressed={tag.hue === hue}
                        onClick={() => void handleHue(tag.id, hue)}
                        className={[
                          'h-4 w-4 rounded-full border transition-transform',
                          tag.hue === hue ? 'scale-110 border-text-bright' : 'border-transparent',
                        ].join(' ')}
                        style={{ background: tagColor(hue) }}
                      />
                    ))}
                  </div>
                </li>
              ))}
            </ul>
            <div className="flex gap-1.5">
              <Input
                aria-label="New tag name"
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                placeholder="New tag"
              />
              <Button variant="ghost" size="sm" onClick={() => void handleCreateTag()}>
                + new tag
              </Button>
            </div>
          </div>

          {/* Right: rules table */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h3 className="font-mono text-[11px] tracking-[0.15em] text-text-muted">AUTO-TAG RULES</h3>
              <Button variant="ghost" size="sm" onClick={() => void handleAddRule()}>
                + Add rule
              </Button>
            </div>
            <p className="text-[11px] text-text-muted">evaluated top → bottom, first match wins</p>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse text-left text-xs">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wide text-text-muted">
                    <th className="pb-1 pr-2">#</th>
                    <th className="pb-1 pr-2">condition</th>
                    <th className="pb-1 pr-2">pattern</th>
                    <th className="pb-1 pr-2">tag</th>
                    <th className="pb-1 pr-2">on</th>
                    <th className="pb-1" />
                  </tr>
                </thead>
                <tbody>
                  {sortedRules.map((rule, idx) => (
                    <tr key={rule.id} className="border-t border-panel-border align-middle">
                      <td className="py-1.5 pr-2">
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            aria-label={`Move rule ${idx + 1} up`}
                            disabled={idx === 0}
                            onClick={() => void handleReorder(rule, 'up')}
                            className="disabled:opacity-30"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            aria-label={`Move rule ${idx + 1} down`}
                            disabled={idx === sortedRules.length - 1}
                            onClick={() => void handleReorder(rule, 'down')}
                            className="disabled:opacity-30"
                          >
                            ↓
                          </button>
                          <span className="text-text-muted">{idx + 1}</span>
                        </div>
                      </td>
                      <td className="py-1.5 pr-2">
                        <Select
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
                      </td>
                      <td className="py-1.5 pr-2">
                        <Input
                          aria-label={`Pattern for rule ${idx + 1}`}
                          value={patternDrafts[rule.id] ?? rule.pattern}
                          onChange={(e) => handlePatternDraft(rule, e.target.value)}
                          className="min-w-[8rem]"
                        />
                      </td>
                      <td className="py-1.5 pr-2">
                        <Select
                          aria-label={`Target tag for rule ${idx + 1}`}
                          value={rule.tag_id}
                          onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                            void handleTargetTag(rule, Number(e.target.value))
                          }
                        >
                          {tags.map((tag) => (
                            <option key={tag.id} value={tag.id}>
                              {tag.name}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="py-1.5 pr-2">
                        <Toggle
                          aria-label={`Enable rule ${idx + 1}`}
                          checked={rule.enabled === 1}
                          onChange={(checked) => void handleEnabled(rule, checked)}
                        />
                      </td>
                      <td className="py-1.5">
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => void handleDeleteRule(rule)}
                          aria-label={`Delete rule ${idx + 1}`}
                        >
                          Delete
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col gap-1.5 rounded-md border border-panel-border p-2">
              <span className="font-mono text-[10px] uppercase tracking-wide text-text-muted">Preview</span>
              <div className="flex items-center gap-2" data-testid="preview-result">
                <Input
                  aria-label="Sample path"
                  font="mono"
                  value={previewPath}
                  onChange={(e) => setPreviewPath(e.target.value)}
                  placeholder="/home/tomin/work/sample"
                  className="flex-1"
                />
                {previewTag ? (
                  <>
                    <Chip label={previewTag.name} hue={previewTag.hue} />
                    {previewRuleIndex != null && previewRuleIndex > 0 && (
                      <span className="font-mono text-[11px] text-text-muted">rule #{previewRuleIndex}</span>
                    )}
                  </>
                ) : previewPath.trim() ? (
                  <span className="font-mono text-[11px] text-text-muted">no match</span>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <p className="border-t border-panel-border pt-3 text-[11px] text-text-muted">
          Tag hue drives the planet&apos;s atmosphere · untagged sessions fall back to the default tag.
        </p>
      </Panel>
    </div>
  )
}
