import { useCallback, useEffect, useState } from 'react'
import { api, type ClaudeDirRefusal } from '../lib/api'
import { claudeDirRefusalSentence } from '../lib/claudeDirs'
import { canChooseDirectory, chooseDirectory } from '../lib/desktop'
import { reportError } from '../lib/errors'
import type { ClaudeDirInfo } from '../lib/types'
import { useOrbital } from '../store/store'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'

/** Settings key: the directory a launch without a choice runs under. Mirrors `server/src/claudeDirs/keys.ts`. */
export const DEFAULT_CLAUDE_DIR_KEY = 'default_claude_dir'

/**
 * The neutral mono chip of the detail header's TERMINAL mark — the one ink a
 * directory mark may wear: not a state, a mode, a tag or a diff hue (spec
 * 2026-10-04-multiple-claude-directories-design, Appendix constraints).
 */
const MONO_CHIP =
  'shrink-0 rounded-[4px] border border-[rgba(150,205,255,.18)] bg-[rgba(150,205,255,.04)] px-[7px] py-[3px] font-mono text-[9.5px] tracking-[0.16em] text-[rgba(160,190,225,.75)]'

/** A quiet note under a path: missing on disk, overridden by the environment. Not an error. */
const QUIET_NOTE = 'font-mono text-[10.5px] text-[rgba(160,190,225,.6)]'

/**
 * Settings → General: the Claude directories Orbital watches and launches
 * under (spec 2026-10-04-multiple-claude-directories-design § 1, § 8). It
 * replaces the single "Claude directory" row. No canvas yet: the cards
 * borrow Tags & rules' card and dashed add row, the actions McpDialog's
 * pills and its confirm-before-remove. Mac only — the routes are not on the
 * phone's allowlist.
 */
export function ClaudeDirsRows({
  active,
  makeDefault,
  onSaved,
}: {
  /** The section is on screen: the list is read on each visit. */
  active: boolean
  /** Settings' own PATCH, so the default lands in the store the same way every setting does. */
  makeDefault: (patch: Record<string, string>) => Promise<void>
  onSaved: () => void
}) {
  /** Null until the read lands, and after a failed one: nothing is drawn rather than a guess. */
  const [dirs, setDirs] = useState<ClaudeDirInfo[] | null>(null)
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [confirming, setConfirming] = useState<number | null>(null)

  const reload = useCallback(async () => {
    try {
      const list = await api.listClaudeDirs()
      if (list) setDirs(list)
    } catch {
      // The list stays as it was; the rest of General works without it.
    }
    // The labels and the dialog's choice read the names from the store.
    await useOrbital.getState().loadClaudeDirs()
  }, [])

  useEffect(() => {
    if (!active) return
    setEditing(null)
    setConfirming(null)
    void reload()
  }, [active, reload])

  /** A directory added or moved brings sessions the server does not push: the list is read again. */
  const reloadSessions = () => {
    void useOrbital
      .getState()
      .loadSessions()
      .catch(() => {})
  }

  const remove = async (dir: ClaudeDirInfo) => {
    setConfirming(null)
    try {
      const result = await api.removeClaudeDir(dir.id)
      if (result && 'error' in result) {
        reportError(new Error(claudeDirRefusalSentence(result.error)), 'Could not remove the directory')
        return
      }
      onSaved()
      await reload()
      reloadSessions()
    } catch (err) {
      reportError(err, 'Could not remove the directory')
    }
  }

  const setDefault = async (dir: ClaudeDirInfo) => {
    await makeDefault({ [DEFAULT_CLAUDE_DIR_KEY]: String(dir.id) })
    await reload()
  }

  if (dirs === null) return null
  const last = dirs.length <= 1

  return (
    <div className="flex flex-col gap-2 border-t border-[rgba(150,205,255,.08)] py-[13px]">
      <div>
        <div className="text-[13.5px] font-semibold text-text-bright">Claude directories</div>
        <div className="mt-1 text-[12px] leading-[1.5] text-[rgba(160,190,225,.7)] [text-wrap:pretty]">
          Where Orbital watches for sessions, and whose login a session runs under. Add one for each
          CLAUDE_CONFIG_DIR you use — a work directory brings its own account and its own limits. New
          sessions start under the default unless you pick another.
        </div>
      </div>
      <ul className="flex flex-col gap-1.5">
        {dirs.map((dir) =>
          editing === dir.id ? (
            <li key={dir.id} className="rounded-xl border border-[rgba(150,205,255,.1)] px-3.5 py-3">
              <DirForm
                initial={{ name: dir.name, path: dir.path }}
                pathLocked={dir.overriddenByEnv}
                submitLabel="Save"
                onCancel={() => setEditing(null)}
                onSubmit={async (draft) => {
                  const patch: { name?: string; path?: string } = {}
                  if (draft.name !== dir.name) patch.name = draft.name
                  if (!dir.overriddenByEnv && draft.path !== dir.path) patch.path = draft.path
                  if (patch.name === undefined && patch.path === undefined) {
                    setEditing(null)
                    return null
                  }
                  const result = await api.updateClaudeDir(dir.id, patch)
                  if ('error' in result) return result.error
                  setEditing(null)
                  onSaved()
                  await reload()
                  if (patch.path !== undefined) reloadSessions()
                  return null
                }}
              />
            </li>
          ) : (
            <li
              key={dir.id}
              data-claude-dir={dir.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 rounded-xl border border-[rgba(150,205,255,.1)] px-3.5 py-3"
            >
              <div className="flex min-w-0 flex-col gap-[5px]">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[13.5px] font-semibold text-text-bright">{dir.name}</span>
                  {dir.isDefault && <span className={MONO_CHIP}>DEFAULT</span>}
                </div>
                <span className="break-all font-mono text-[11px] leading-[1.5] text-[rgba(200,220,245,.8)]">
                  {dir.path}
                </span>
                {dir.account && <span className={QUIET_NOTE}>{dir.account}</span>}
                {dir.overriddenByEnv && <span className={QUIET_NOTE}>path set by ORBITAL_CLAUDE_DIR</span>}
                {!dir.exists && <span className={QUIET_NOTE}>missing on disk</span>}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                {confirming === dir.id ? (
                  <>
                    <span className="text-xs text-[rgba(220,235,255,.85)]">
                      Remove? Its sessions leave the map until it is added back.
                    </span>
                    <Button variant="pill" size="pill" onClick={() => setConfirming(null)}>
                      Keep
                    </Button>
                    <Button variant="pill-danger" size="pill" onClick={() => void remove(dir)}>
                      Remove
                    </Button>
                  </>
                ) : (
                  <>
                    {!dir.isDefault && (
                      <Button variant="pill" size="pill" onClick={() => void setDefault(dir)}>
                        Make default
                      </Button>
                    )}
                    <Button
                      variant="pill"
                      size="pill"
                      onClick={() => {
                        setConfirming(null)
                        setEditing(dir.id)
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="pill"
                      size="pill"
                      disabled={last}
                      title={last ? 'The last directory cannot be removed' : undefined}
                      onClick={() => {
                        setEditing(null)
                        setConfirming(dir.id)
                      }}
                    >
                      Remove
                    </Button>
                  </>
                )}
              </div>
            </li>
          ),
        )}

        {/* Tags & rules' dashed add row, opening into the same form as Edit. */}
        <li className="rounded-xl border border-dashed border-[rgba(150,205,255,.2)] px-3.5 py-2.5">
          {editing === 'new' ? (
            <DirForm
              initial={{ name: '', path: '' }}
              pathLocked={false}
              submitLabel="Add"
              onCancel={() => setEditing(null)}
              onSubmit={async (draft) => {
                const result = await api.addClaudeDir(draft)
                if ('error' in result) return result.error
                setEditing(null)
                onSaved()
                await reload()
                reloadSessions()
                return null
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setConfirming(null)
                setEditing('new')
              }}
              className="w-full text-left font-mono text-[11px] text-[rgba(160,190,225,.7)] transition-colors hover:text-text-bright"
            >
              + Add a Claude directory
            </button>
          )}
        </li>
      </ul>
    </div>
  )
}

/** Name and path, with the desktop's folder picker beside the path; a refusal reads as a sentence under them. */
function DirForm({
  initial,
  pathLocked,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: { name: string; path: string }
  /** `ORBITAL_CLAUDE_DIR` decides the path; only the name can change. */
  pathLocked: boolean
  submitLabel: string
  /** Resolves with the refusal to show, or null when it went through. */
  onSubmit: (draft: { name: string; path: string }) => Promise<ClaudeDirRefusal | null>
  onCancel: () => void
}) {
  const [name, setName] = useState(initial.name)
  const [path, setPath] = useState(initial.path)
  const [refusal, setRefusal] = useState<ClaudeDirRefusal | null>(null)
  const [pending, setPending] = useState(false)
  const canBrowse = canChooseDirectory() && !pathLocked

  const submit = async () => {
    if (pending) return
    setPending(true)
    try {
      setRefusal(await onSubmit({ name: name.trim(), path: path.trim() }))
    } catch (err) {
      reportError(err, 'Could not save the directory')
    } finally {
      setPending(false)
    }
  }

  const browse = () => {
    chooseDirectory(path)
      .then((dir) => {
        if (dir) setPath(dir)
      })
      .catch((err: unknown) => reportError(err, 'Could not open the folder picker'))
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <Input
        aria-label="Directory name"
        size="sm"
        value={name}
        onChange={(e) => {
          setName(e.target.value)
          setRefusal(null)
        }}
        placeholder="Work"
        className="w-full"
      />
      <div className="flex gap-2">
        <Input
          aria-label="Directory path"
          font="mono"
          size="sm"
          value={path}
          disabled={pathLocked}
          onChange={(e) => {
            setPath(e.target.value)
            setRefusal(null)
          }}
          placeholder="~/.claude-work"
          className="min-w-0 flex-1"
        />
        {canBrowse && (
          <Button variant="ghost" size="sm" onClick={browse}>
            Browse…
          </Button>
        )}
      </div>
      {refusal && (
        <span role="status" className="text-[12px] leading-[1.5] text-[rgba(220,235,255,.85)]">
          {claudeDirRefusalSentence(refusal)}
        </span>
      )}
      <div className="flex justify-end gap-1.5">
        <Button variant="pill" size="pill" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="pill-active" size="pill" type="submit" disabled={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}
