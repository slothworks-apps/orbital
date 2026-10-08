import { useCallback, useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { api, type ClaudeDirRefusal } from '../lib/api'
import { claudeDirDisplayPath, claudeDirMonograms, claudeDirRefusalSentence } from '../lib/claudeDirs'
import { canChooseDirectory, chooseDirectory } from '../lib/desktop'
import { reportError } from '../lib/errors'
import type { ClaudeDirInfo } from '../lib/types'
import { useOrbital } from '../store/store'
import { Button } from '../ui/Button'
import { ClaudeDirMark } from '../ui/ClaudeDirMark'
import { useEscapeLayer } from '../ui/escapeLayer'
import { Input } from '../ui/Input'
import { MenuButton, type MenuEntry } from '../ui/Menu'

/** Settings key: the directory a launch without a choice runs under. Mirrors `server/src/claudeDirs/keys.ts`. */
export const DEFAULT_CLAUDE_DIR_KEY = 'default_claude_dir'

/** 44a's add form: its height and its fade, on the canvas's curve. */
const ADD_FORM_TRANSITION =
  'grid-template-rows .36s cubic-bezier(.2,.8,.25,1), opacity .24s ease var(--add-delay), transform .36s cubic-bezier(.2,.8,.25,1)'

type Editing = { id: number; field: 'name' | 'path' } | null

/**
 * Settings → General: the Claude directories Orbital watches and launches
 * under (spec 2026-10-04-multiple-claude-directories-design § 1; canvas 44a).
 * A bordered list — the mark (with two or more), the name and DEFAULT, the
 * path with its quiet notes, the account, and a ⋯ menu to rename, change the
 * path, make default or remove. Renaming and the path are edited in the row;
 * removing asks in the row; adding opens a form at the list's foot. A missing
 * directory is one muted note, never an error. Mac only — the routes are not
 * on the phone's allowlist.
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
  const [editing, setEditing] = useState<Editing>(null)
  const [confirming, setConfirming] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const monograms = useMemo(() => claudeDirMonograms(dirs ?? []), [dirs])

  const reload = useCallback(async () => {
    try {
      const list = await api.listClaudeDirs()
      if (list) setDirs(list)
    } catch {
      // The list stays as it was; the rest of General works without it.
    }
    // The marks and the dialog's choice read the names from the store.
    await useOrbital.getState().loadClaudeDirs()
  }, [])

  useEffect(() => {
    if (!active) return
    setEditing(null)
    setConfirming(null)
    setAdding(false)
    void reload()
  }, [active, reload])

  // Escape peels an open edit, confirm or form before it closes Settings.
  const peeling = editing !== null || confirming !== null || adding
  useEscapeLayer(active && peeling, () => {
    setEditing(null)
    setConfirming(null)
    setAdding(false)
  })

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

  /** Saves one field of a row; resolves with the refusal to show, or null. */
  const update = async (dir: ClaudeDirInfo, patch: { name?: string; path?: string }) => {
    const result = await api.updateClaudeDir(dir.id, patch)
    if ('error' in result) return result.error
    setEditing(null)
    onSaved()
    await reload()
    if (patch.path !== undefined) reloadSessions()
    return null
  }

  const startEdit = (id: number, field: 'name' | 'path') => {
    setConfirming(null)
    setAdding(false)
    setEditing({ id, field })
  }

  /** Nothing changed: the edit closes without a request. */
  const unchanged = (): Promise<null> => {
    setEditing(null)
    return Promise.resolve(null)
  }

  if (dirs === null) return null
  const several = dirs.length >= 2
  const last = dirs.length <= 1

  return (
    <div className="flex flex-col gap-3 border-t border-[rgba(150,205,255,.08)] py-[13px]">
      <div>
        <div className="text-[13.5px] font-semibold text-text-bright">Claude directories</div>
        <div className="mt-1 max-w-[600px] text-[12px] leading-[1.5] text-[rgba(160,190,225,.7)] [text-wrap:pretty]">
          Each one is a Claude Code configuration with its own login. Orbital watches all of them. A new session
          runs under the default unless you choose another in New session.
        </div>
      </div>

      <div className="flex flex-col rounded-[11px] border border-[rgba(150,205,255,.12)] bg-[rgba(4,8,16,.45)]">
        <ul className="flex flex-col">
          {dirs.map((dir, index) => {
            const missing = !dir.exists
            const rest = dirs.filter((d) => d.id !== dir.id)
            const field = editing?.id === dir.id ? editing.field : null
            return (
              <li
                key={dir.id}
                data-claude-dir={dir.id}
                className={[
                  'flex flex-col border-t',
                  index === 0 ? 'border-transparent' : 'border-[rgba(150,205,255,.08)]',
                ].join(' ')}
              >
                <div className="box-border flex min-h-[62px] items-start gap-3 py-3 pl-4 pr-2.5">
                  {several && (
                    <span className="mt-px flex">
                      <ClaudeDirMark mono={monograms.get(dir.id) ?? '?'} size="phone" missing={missing} />
                    </span>
                  )}
                  <div className="flex min-w-0 flex-1 flex-col gap-[5px]">
                    {field === 'name' ? (
                      <InlineEdit
                        label="Directory name"
                        font="sans"
                        initial={dir.name}
                        onSave={(name) => (name === dir.name ? unchanged() : update(dir, { name }))}
                      />
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={[
                            'text-[13.5px] font-semibold [overflow-wrap:anywhere]',
                            missing ? 'text-[rgba(232,238,248,.7)]' : 'text-text-bright',
                          ].join(' ')}
                        >
                          {dir.name}
                        </span>
                        {dir.isDefault && (
                          <span className="flex-none rounded-[4px] border border-[rgba(150,205,255,.22)] px-1.5 py-px font-mono text-[9px] tracking-[0.12em] text-[rgba(200,220,245,.8)]">
                            DEFAULT
                          </span>
                        )}
                      </div>
                    )}
                    {field === 'path' ? (
                      <InlineEdit
                        label="Directory path"
                        font="mono"
                        initial={claudeDirDisplayPath(dir.path)}
                        browse
                        onSave={(path) =>
                          path === claudeDirDisplayPath(dir.path) ? unchanged() : update(dir, { path })
                        }
                      />
                    ) : (
                      <div className="flex flex-wrap items-baseline gap-1.5 font-mono text-[11px] text-[rgba(160,190,225,.65)]">
                        <span
                          className={[
                            '[overflow-wrap:anywhere]',
                            missing ? 'text-[rgba(160,190,225,.5)]' : 'text-[rgba(160,190,225,.7)]',
                          ].join(' ')}
                        >
                          {claudeDirDisplayPath(dir.path)}
                        </span>
                        {dir.overriddenByEnv && (
                          <span className="text-[rgba(160,190,225,.5)]">· set by ORBITAL_CLAUDE_DIR · read-only</span>
                        )}
                        {missing && <span className="text-[rgba(160,190,225,.5)]">· not found on disk</span>}
                      </div>
                    )}
                  </div>
                  {dir.account && !missing && (
                    <span className="max-w-[220px] flex-none truncate pt-0.5 font-mono text-[11px] text-[rgba(160,190,225,.6)]">
                      {dir.account}
                    </span>
                  )}
                  <RowMenu
                    entries={[
                      { key: 'rename', label: 'Rename', onSelect: () => startEdit(dir.id, 'name') },
                      {
                        key: 'path',
                        label: 'Change path…',
                        note: dir.overriddenByEnv ? 'set by env' : undefined,
                        disabled: dir.overriddenByEnv,
                        onSelect: () => startEdit(dir.id, 'path'),
                      },
                      {
                        key: 'default',
                        label: 'Make default',
                        note: dir.isDefault ? 'is default' : undefined,
                        disabled: dir.isDefault,
                        onSelect: () => void setDefault(dir),
                      },
                      {
                        key: 'remove',
                        label: 'Remove',
                        note: last ? 'last one' : undefined,
                        disabled: last,
                        onSelect: () => {
                          setEditing(null)
                          setAdding(false)
                          setConfirming(dir.id)
                        },
                      },
                    ]}
                  />
                </div>
                {confirming === dir.id && (
                  <div className="mb-3 ml-4 mr-2.5 flex items-center gap-3 rounded-[9px] border border-[rgba(150,205,255,.16)] bg-[rgba(4,8,16,.6)] px-3 py-[11px]">
                    <span className="min-w-0 flex-1 text-[12.5px] leading-[1.5] text-[rgba(214,230,248,.88)] [text-wrap:pretty]">
                      Stop watching {claudeDirDisplayPath(dir.path)}? Nothing on disk is deleted. Its sessions leave the
                      map and the lists.
                      {dir.isDefault && rest[0] ? ` ${rest[0].name} becomes the default.` : ''}
                    </span>
                    <Button variant="ghost" size="row" onClick={() => setConfirming(null)}>
                      Cancel
                    </Button>
                    <Button variant="lit" size="row" onClick={() => void remove(dir)}>
                      Remove
                    </Button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>

        <AddForm
          open={adding}
          onCancel={() => setAdding(false)}
          onAdd={async (draft) => {
            const result = await api.addClaudeDir(draft)
            if ('error' in result) return result.error
            setAdding(false)
            onSaved()
            await reload()
            reloadSessions()
            return null
          }}
        />
      </div>

      {!adding && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => {
            setEditing(null)
            setConfirming(null)
            setAdding(true)
          }}
        >
          <span aria-hidden className="text-[15px] leading-none text-accent">
            +
          </span>
          Add directory
        </Button>
      )}
    </div>
  )

}

/** 44a's ⋯ on a row: the four actions, each with its quiet reason when it does not apply. */
function RowMenu({
  entries,
}: {
  entries: Array<{ key: string; label: string; note?: string; disabled?: boolean; onSelect: () => void }>
}) {
  const items: MenuEntry[] = entries.map((entry) => ({
    key: entry.key,
    label: entry.label,
    disabled: entry.disabled,
    onSelect: entry.onSelect,
    body: (
      <span className="flex items-center gap-2">
        <span className="flex-1 font-sans text-[12.5px] font-medium">{entry.label}</span>
        {entry.note && (
          <span className="font-mono text-[9.5px] tracking-[0.06em] text-[rgba(160,190,225,.6)]">{entry.note}</span>
        )}
      </span>
    ),
  }))
  return (
    <MenuButton
      aria-label="Directory actions"
      entries={items}
      widthPx={220}
      align="right"
      renderTrigger={(props, open) => (
        <button
          {...props}
          type="button"
          aria-label="Directory actions"
          className={[
            'grid h-6 w-7 flex-none place-items-center rounded-[6px] border text-[14px] leading-none text-[rgba(200,220,245,.8)] transition-colors hover:bg-[rgba(150,205,255,.1)]',
            open ? 'border-[rgba(150,205,255,.26)] bg-[rgba(150,205,255,.1)]' : 'border-transparent bg-transparent',
          ].join(' ')}
        >
          ⋯
        </button>
      )}
    />
  )
}

/** A refused change, said as a sentence where it was made. Not an error banner. */
function Refusal({ refusal }: { refusal: ClaudeDirRefusal | null }) {
  if (!refusal) return null
  return (
    <span role="status" className="text-[12px] leading-[1.5] text-[rgba(220,235,255,.85)]">
      {claudeDirRefusalSentence(refusal)}
    </span>
  )
}

/** Opens the folder picker at `from`; null outside the desktop app, which has none. */
function folderPicker(from: string, onPick: (dir: string) => void): (() => void) | null {
  if (!canChooseDirectory()) return null
  return () => {
    chooseDirectory(from)
      .then((dir) => {
        if (dir) onPick(dir)
      })
      .catch((err: unknown) => reportError(err, 'Could not open the folder picker'))
  }
}

/** 44a's in-row edit: the field, Browse… for a path, and Done. Enter saves; Escape cancels (the list's escape layer). */
function InlineEdit({
  label,
  font,
  initial,
  browse = false,
  onSave,
}: {
  label: string
  font: 'sans' | 'mono'
  initial: string
  browse?: boolean
  /** Resolves with the refusal to show, or null when it went through. */
  onSave: (value: string) => Promise<ClaudeDirRefusal | null>
}) {
  const [value, setValue] = useState(initial)
  const [refusal, setRefusal] = useState<ClaudeDirRefusal | null>(null)
  const [pending, setPending] = useState(false)
  const pickFolder = folderPicker(value, (dir) => {
    setValue(dir)
    setRefusal(null)
  })

  const save = async () => {
    if (pending) return
    setPending(true)
    try {
      setRefusal(await onSave(value.trim()))
    } catch (err) {
      reportError(err, 'Could not save the directory')
    } finally {
      setPending(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void save()
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Input
          aria-label={label}
          font={font}
          size="sm"
          autoFocus
          spellCheck={false}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setRefusal(null)
          }}
          onKeyDown={onKeyDown}
          className="min-w-0 max-w-[360px] flex-1"
        />
        {browse && pickFolder && (
          <Button variant="ghost" size="row" onClick={pickFolder}>
            Browse…
          </Button>
        )}
        <Button variant="ghost" size="row" disabled={pending} onClick={() => void save()}>
          Done
        </Button>
      </div>
      <Refusal refusal={refusal} />
    </div>
  )
}

/**
 * 44a's add form at the list's foot: NAME and PATH with Browse…, the note
 * that nothing is copied or changed, Cancel and Add directory. It opens by
 * growing out of the list's last rule.
 */
function AddForm({
  open,
  onAdd,
  onCancel,
}: {
  open: boolean
  /** Resolves with the refusal to show, or null when it went through. */
  onAdd: (draft: { name: string; path: string }) => Promise<ClaudeDirRefusal | null>
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [refusal, setRefusal] = useState<ClaudeDirRefusal | null>(null)
  const [pending, setPending] = useState(false)
  const pickFolder = folderPicker(path, (dir) => {
    setPath(dir)
    setRefusal(null)
  })
  const ready = name.trim() !== '' && path.trim() !== ''

  // A closed form starts empty next time.
  useEffect(() => {
    if (open) return
    setName('')
    setPath('')
    setRefusal(null)
  }, [open])

  const add = async () => {
    if (!ready || pending) return
    setPending(true)
    try {
      setRefusal(await onAdd({ name: name.trim(), path: path.trim() }))
    } catch (err) {
      reportError(err, 'Could not add the directory')
    } finally {
      setPending(false)
    }
  }

  return (
    <div
      aria-hidden={!open}
      inert={!open || undefined}
      className="grid motion-reduce:transition-none"
      style={
        {
          gridTemplateRows: open ? '1fr' : '0fr',
          opacity: open ? 1 : 0,
          transition: ADD_FORM_TRANSITION,
          '--add-delay': open ? '.08s' : '0s',
        } as CSSProperties
      }
    >
      <div className="min-h-0 overflow-hidden rounded-b-[11px]">
        <form
          className="flex flex-col gap-2.5 border-t border-[rgba(150,205,255,.08)] bg-[rgba(150,205,255,.03)] px-4 py-3.5 transition-transform duration-[360ms] ease-[cubic-bezier(.2,.8,.25,1)] motion-reduce:transition-none"
          style={{ transform: open ? 'translateY(0)' : 'translateY(-8px)' }}
          onSubmit={(e) => {
            e.preventDefault()
            void add()
          }}
        >
          <div className="grid grid-cols-[200px_minmax(0,1fr)_auto] items-end gap-2.5">
            <FieldLabel text="NAME">
              <Input
                aria-label="Directory name"
                size="sm"
                value={name}
                placeholder="e.g. Work"
                onChange={(e) => {
                  setName(e.target.value)
                  setRefusal(null)
                }}
              />
            </FieldLabel>
            <FieldLabel text="PATH">
              <Input
                aria-label="Directory path"
                font="mono"
                size="sm"
                spellCheck={false}
                value={path}
                placeholder="~/.claude-work"
                onChange={(e) => {
                  setPath(e.target.value)
                  setRefusal(null)
                }}
              />
            </FieldLabel>
            {pickFolder ? (
              <Button variant="ghost" size="sm" onClick={pickFolder}>
                Browse…
              </Button>
            ) : (
              <span />
            )}
          </div>
          <Refusal refusal={refusal} />
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 font-mono text-[10px] leading-[1.5] text-[rgba(160,190,225,.5)] [text-wrap:pretty]">
              the account is read from the directory once it’s added · nothing is copied or changed
            </span>
            <Button variant="ghost" size="row" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="lit" size="row" type="submit" disabled={!ready || pending}>
              Add directory
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

/** 44a's mono kicker over a field of the add form. */
function FieldLabel({ text, children }: { text: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 font-mono text-[9.5px] tracking-[0.16em] text-[rgba(160,190,225,.6)]">
      {text}
      {children}
    </label>
  )
}
