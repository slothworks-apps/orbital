import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import type { HarnessTemplate, KnownHarnessProject, TemplateScope } from '../lib/types'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { useEscapeLayer } from '../ui/escapeLayer'
import { useOrbital } from '../store/store'
import { DraftPopover } from './harnessTemplates/DraftPopover'
import { emptyDraft, sameDraft, toBody, toEditorDraft, type EditorDraft } from './harnessTemplates/editorDraft'
import { defaultScope, projectOfCwd, scopeKey, type ListFilter } from './harnessTemplates/logic'
import { ScopePicker } from './harnessTemplates/ScopePicker'
import { EditorHeader, TemplateEditor } from './harnessTemplates/TemplateEditor'
import { TemplateList } from './harnessTemplates/TemplateList'

interface Editing {
  /** null: a new template, not created yet. */
  id: number | null
  /** A conversation's draft: unsaved until Save, whatever the fields say. */
  isDraft: boolean
  original: EditorDraft
  originalScope: TemplateScope
  draft: EditorDraft
  scope: TemplateScope
  /** Bumped to remount the editor (another template, or a model's draft poured in). */
  revision: number
}

const byName = (a: HarnessTemplate, b: HarnessTemplate) => a.name.localeCompare(b.name)

/**
 * Settings → Harness templates (canvas Feature - Harness 30j–30m, spec
 * 2026-10-02-harness-redesign-design): the list under a project filter, the
 * editor in place of the whole Settings body, the Draft… popover, and the
 * scope asked before a template exists.
 *
 * `onEditingChange` tells Settings the editor is open, so it can give the
 * editor the whole panel: 30k has its own header and no nav.
 */
export function HarnessTemplatesSection({
  active,
  onSaved,
  onEditingChange,
}: {
  active: boolean
  onSaved: () => void
  onEditingChange?: (editing: boolean) => void
}) {
  const tags = useOrbital((s) => s.tags)
  const cameFromCwd = useOrbital((s) => (s.ui.selectedId ? s.sessions[s.ui.selectedId]?.cwd ?? null : null))
  const [templates, setTemplates] = useState<HarnessTemplate[] | null>(null)
  const [projects, setProjects] = useState<KnownHarnessProject[]>([])
  const [filter, setFilter] = useState<ListFilter>({ kind: 'all' })
  /** The harness panel's link: the project it was opened for (30c), before the selection. */
  const [focusProject, setFocusProject] = useState<{ root: string; name: string } | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedJustNow, setSavedJustNow] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [popover, setPopover] = useState<'new' | 'draft' | 'editorDraft' | null>(null)
  const [draftScope, setDraftScope] = useState<{ scope: TemplateScope; note: string | null } | null>(null)
  const [moving, setMoving] = useState<HarnessTemplate | null>(null)
  const [deleting, setDeleting] = useState<HarnessTemplate | null>(null)
  const [leaving, setLeaving] = useState(false)
  const pendingOpen = useRef<number | null>(null)

  const newRef = useRef<HTMLButtonElement | null>(null)
  const listDraftRef = useRef<HTMLButtonElement | null>(null)
  const editorDraftRef = useRef<HTMLButtonElement | null>(null)
  const moveAnchorRef = useRef<HTMLElement | null>(null)

  // The harness panel's links say where to start (store `harnessTemplatesFocus`); read once, then cleared.
  useEffect(() => {
    const focus = useOrbital.getState().harnessTemplatesFocus
    if (!focus) return
    useOrbital.setState({ harnessTemplatesFocus: null })
    if (focus.project) {
      setFocusProject(focus.project)
      setFilter({ kind: 'project', root: focus.project.root })
    }
    if (focus.templateId !== undefined) pendingOpen.current = focus.templateId
    if (focus.draft) {
      setDraftScope(
        focus.project
          ? { scope: { kind: 'project', ...focus.project }, note: 'where you came from' }
          : null,
      )
      // After the first paint, so the button it hangs off exists.
      requestAnimationFrame(() => setPopover('draft'))
    }
    // Mount only.
  }, [])

  useEffect(() => {
    if (!active) return
    let live = true
    Promise.all([api.listHarnessTemplates(), api.listHarnessProjects()])
      .then(([{ templates }, { projects }]) => {
        if (!live) return
        setTemplates(templates.slice().sort(byName))
        setProjects(projects)
        const wanted = pendingOpen.current !== null ? templates.find((t) => t.id === pendingOpen.current) : undefined
        pendingOpen.current = null
        if (wanted) open(wanted)
      })
      .catch((err) => reportError(err, 'Failed to load harness templates'))
    return () => {
      live = false
    }
  }, [active])

  const editorOpen = editing !== null
  useEffect(() => {
    onEditingChange?.(editorOpen)
  }, [editorOpen, onEditingChange])
  useEffect(() => () => onEditingChange?.(false), [onEditingChange])

  // A filter on a project nobody has templates in any more (the last one moved away) falls back to All.
  useEffect(() => {
    if (filter.kind !== 'project' || templates === null) return
    if (!templates.some((t) => t.scope.kind === 'project' && t.scope.root === filter.root)) setFilter({ kind: 'all' })
  }, [templates, filter])

  const cameFrom = focusProject ?? (cameFromCwd ? projectOfCwd(cameFromCwd, projects) : null)
  const cameFromRoot = cameFrom?.root ?? null

  /** 30m: the list filter's project, else where you came from, else Global — and why, for "Saves to". */
  function startingScope(): { scope: TemplateScope; note: string | null } {
    const scope = defaultScope(filter, cameFrom, projects)
    if (filter.kind === 'project') return { scope, note: 'from the list filter' }
    return { scope, note: scope.kind === 'project' ? 'where you came from' : null }
  }

  const dirty =
    editing !== null &&
    (editing.id === null ||
      editing.isDraft ||
      !sameDraft(editing.draft, editing.original) ||
      scopeKey(editing.scope) !== scopeKey(editing.originalScope))

  function open(template: HarnessTemplate) {
    const draft = toEditorDraft(template)
    setError(null)
    setSavedJustNow(false)
    setEditing((prev) => ({
      id: template.id,
      isDraft: template.draft,
      original: draft,
      originalScope: template.scope,
      draft,
      scope: template.scope,
      revision: (prev?.revision ?? 0) + 1,
    }))
  }

  function openNew(scope: TemplateScope, draft: EditorDraft = emptyDraft()) {
    setError(null)
    setSavedJustNow(false)
    setEditing((prev) => ({
      id: null,
      isDraft: false,
      original: draft,
      originalScope: scope,
      draft,
      scope,
      revision: (prev?.revision ?? 0) + 1,
    }))
  }

  function openListDraft() {
    setDraftScope(startingScope())
    setPopover('draft')
  }

  function back(force = false) {
    if (dirty && !force) {
      setLeaving(true)
      return
    }
    setLeaving(false)
    setEditing(null)
    setError(null)
  }
  useEscapeLayer(editorOpen, () => back())

  function upsert(saved: HarnessTemplate) {
    setTemplates((list) => [...(list ?? []).filter((t) => t.id !== saved.id), saved].sort(byName))
  }

  async function save() {
    if (!editing) return
    setSaving(true)
    setError(null)
    try {
      const moved = scopeKey(editing.scope) !== scopeKey(editing.originalScope)
      const saved =
        editing.id === null
          ? await api.createHarnessTemplate(toBody(editing.draft, editing.scope))
          : await api.updateHarnessTemplate(editing.id, toBody(editing.draft, moved ? editing.scope : undefined))
      upsert(saved)
      const draft = toEditorDraft(saved)
      setEditing((prev) =>
        prev && { ...prev, id: saved.id, isDraft: saved.draft, original: draft, originalScope: saved.scope, draft, scope: saved.scope },
      )
      setSavedJustNow(true)
      onSaved()
    } catch (err) {
      // The server names what is wrong ("step … needs a title"); that is the message.
      setError(err instanceof Error ? err.message : 'Failed to save the template')
    } finally {
      setSaving(false)
    }
  }

  async function duplicate(t: HarnessTemplate) {
    try {
      upsert(await api.duplicateHarnessTemplate(t.id))
      onSaved()
    } catch (err) {
      reportError(err, 'Failed to duplicate the template')
    }
  }

  async function move(t: HarnessTemplate, scope: TemplateScope) {
    setMoving(null)
    if (scopeKey(scope) === scopeKey(t.scope)) return
    try {
      // PUT clears the draft mark unless told otherwise; a move is not a Save.
      upsert(await api.updateHarnessTemplate(t.id, { ...toBody(toEditorDraft(t), scope), draft: t.draft }))
      onSaved()
    } catch (err) {
      reportError(err, 'Failed to move the template')
    }
  }

  async function remove(t: HarnessTemplate) {
    try {
      await api.deleteHarnessTemplate(t.id)
      setTemplates((list) => (list ?? []).filter((x) => x.id !== t.id))
      setDeleting(null)
      if (editing?.id === t.id) setEditing(null)
      onSaved()
    } catch (err) {
      reportError(err, 'Failed to delete the template')
    }
  }

  const status = editing
    ? dirty
      ? editing.isDraft && sameDraft(editing.draft, editing.original)
        ? 'draft · not saved'
        : 'unsaved changes'
      : savedJustNow
        ? 'saved · just now'
        : null
    : null

  const dialogs = (
    <>
      <Dialog
        open={deleting !== null}
        size="sm"
        eyebrow="HARNESS TEMPLATE"
        title={`Delete “${deleting?.name ?? ''}”?`}
        onClose={() => setDeleting(null)}
        footerCaption="esc cancel"
        footer={
          <>
            <Button variant="ghost" size="lg" onClick={() => setDeleting(null)}>
              Keep it
            </Button>
            <Button variant="primary" size="lg" onClick={() => deleting && void remove(deleting)}>
              Delete template
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-[1.55] text-[rgba(200,214,235,.85)] [text-wrap:pretty]">
          It is no longer offered when a harness starts. Sessions already following it keep their harness and its records.
        </p>
      </Dialog>
      <Dialog
        open={leaving}
        size="sm"
        eyebrow="HARNESS TEMPLATE"
        title="Leave without saving?"
        onClose={() => setLeaving(false)}
        footerCaption="esc keep editing"
        footer={
          <>
            <Button variant="ghost" size="lg" onClick={() => setLeaving(false)}>
              Keep editing
            </Button>
            <Button variant="primary" size="lg" onClick={() => back(true)}>
              Discard changes
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-[1.55] text-[rgba(200,214,235,.85)] [text-wrap:pretty]">
          {editing?.isDraft
            ? 'This draft stays in the list, unsaved, and the changes made here are lost.'
            : 'The changes made here are lost. The saved template stays as it was.'}
        </p>
      </Dialog>
    </>
  )

  if (editing) {
    return (
      <div className="flex min-h-0 flex-col">
        <EditorHeader
          name={editing.draft.name}
          status={status}
          dirty={dirty}
          saving={saving}
          onBack={() => back()}
          onSave={() => void save()}
          draftRef={editorDraftRef}
          draftOpen={popover === 'editorDraft'}
          onDraft={() => setPopover(popover === 'editorDraft' ? null : 'editorDraft')}
        />
        <TemplateEditor
          key={editing.revision}
          draft={editing.draft}
          onChange={(draft) => {
            setSavedJustNow(false)
            setEditing((prev) => prev && { ...prev, draft })
          }}
          scope={editing.scope}
          onScopeChange={(scope) => {
            setSavedJustNow(false)
            setEditing((prev) => prev && { ...prev, scope })
          }}
          projects={projects}
          cameFromRoot={cameFromRoot}
          tags={tags}
          error={error}
        />
        <DraftPopover
          open={popover === 'editorDraft'}
          anchorRef={editorDraftRef}
          onClose={() => setPopover(null)}
          projects={projects}
          scope={editing.scope}
          scopeNote={null}
          onScopeChange={(scope) => setEditing((prev) => prev && { ...prev, scope })}
          cameFromRoot={cameFromRoot}
          // Poured into this editor, unsaved: the template keeps its id and scope.
          onFill={(draft) => setEditing((prev) => prev && { ...prev, draft, revision: prev.revision + 1 })}
        />
        {dialogs}
      </div>
    )
  }

  const listDraftScope = draftScope ?? startingScope()
  return (
    <>
      <TemplateList
        templates={templates}
        tags={tags}
        filter={filter}
        onFilter={setFilter}
        headerButtons={{
          draftRef: listDraftRef,
          newRef,
          draftOpen: popover === 'draft',
          newOpen: popover === 'new',
          onDraft: () => (popover === 'draft' ? setPopover(null) : openListDraft()),
          onNew: () => setPopover(popover === 'new' ? null : 'new'),
        }}
        onEdit={open}
        onDuplicate={(t) => void duplicate(t)}
        onMove={(t, anchor) => {
          moveAnchorRef.current = anchor
          setMoving(t)
        }}
        onDelete={setDeleting}
      />
      <ScopePicker
        open={popover === 'new'}
        anchorRef={newRef}
        projects={projects}
        value={startingScope().scope}
        cameFromRoot={cameFromRoot}
        footer={(s) => `create in ${s.kind === 'global' ? 'Global' : s.name} · change later under Scope`}
        onPick={(scope) => {
          setPopover(null)
          openNew(scope)
        }}
        onClose={() => setPopover(null)}
      />
      <ScopePicker
        open={moving !== null}
        anchorRef={moveAnchorRef}
        projects={projects}
        value={moving?.scope ?? { kind: 'global' }}
        cameFromRoot={cameFromRoot}
        footer={(s) => `move to ${s.kind === 'global' ? 'Global' : s.name}`}
        onPick={(scope) => moving && void move(moving, scope)}
        onClose={() => setMoving(null)}
      />
      <DraftPopover
        open={popover === 'draft'}
        anchorRef={listDraftRef}
        onClose={() => setPopover(null)}
        projects={projects}
        scope={listDraftScope.scope}
        scopeNote={listDraftScope.note}
        onScopeChange={(scope) => setDraftScope({ scope, note: null })}
        cameFromRoot={cameFromRoot}
        onFill={(draft) => openNew(listDraftScope.scope, draft)}
      />
      {dialogs}
    </>
  )
}
