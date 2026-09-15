import { useCallback, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { shortenPath } from '../lib/format'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Input, TextArea } from '../ui/Input'
import { Chip } from '../ui/Chip'
import { ModeCards } from '../ui/ModeCards'
import type { PermissionMode } from '../lib/types'

export interface NewSessionDialogProps {
  open: boolean
  onClose: () => void
}

/** Delay before firing `previewRule` after cwd/mode settle — avoids a
 * request per keystroke while typing a path. */
const PREVIEW_DEBOUNCE_MS = 300

/**
 * Spawns a new session (artboard 1d). cwd is a plain text `Input` — Browse
 * is deferred to a later version (no filesystem picker in v1; the input
 * alone suffices for pasting/typing a path), noted inline below the field.
 * The tag row auto-matches the cwd/mode against the tag-rule engine via
 * `previewRule`, debounced, and stays in sync with cwd/mode changes until
 * the user manually picks a different tag — after that, the manual choice
 * wins over any further auto-match.
 */
export function NewSessionDialog({ open, onClose }: NewSessionDialogProps) {
  const settings = useOrbital(useShallow((s) => s.settings))
  const tags = useOrbital(useShallow((s) => s.tags))
  const rules = useOrbital(useShallow((s) => s.rules))
  const select = useOrbital((s) => s.select)

  const [cwd, setCwd] = useState('')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('acceptEdits')
  const [prompt, setPrompt] = useState('')
  const [tagId, setTagId] = useState<number | null>(null)
  const [manualOverride, setManualOverride] = useState(false)
  const [matchedTagId, setMatchedTagId] = useState<number | null>(null)
  const [matchedRuleId, setMatchedRuleId] = useState<number | null>(null)
  const [recentDirs, setRecentDirs] = useState<string[]>([])
  const [pending, setPending] = useState(false)

  // Reset + prefill from settings on the false -> true transition only (not
  // on every re-render while already open, which would clobber typing).
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setCwd(settings.default_project_dir ?? '')
      setPermissionMode(((settings.default_permission_mode as PermissionMode) || 'acceptEdits'))
      setPrompt('')
      setTagId(null)
      setManualOverride(false)
      setMatchedTagId(null)
      setMatchedRuleId(null)
      setPending(false)
      api
        .listProjects()
        .then(setRecentDirs)
        .catch(() => {
          // Recent-dirs chips are a convenience; the cwd input still works without them.
        })
    }
    wasOpenRef.current = open
  }, [open, settings.default_project_dir, settings.default_permission_mode])

  // Debounced auto-match: re-preview whenever cwd or permission mode
  // changes, and (unless the user has manually overridden) adopt the match.
  useEffect(() => {
    if (!open || !cwd.trim()) {
      setMatchedTagId(null)
      setMatchedRuleId(null)
      return
    }
    const timer = setTimeout(() => {
      api
        .previewRule({ cwd, title: '', permissionMode })
        .then(({ tagId: matched, ruleId }) => {
          setMatchedTagId(matched)
          setMatchedRuleId(ruleId)
          if (!manualOverride) setTagId(matched)
        })
        .catch(() => {
          // Preview is best-effort; leave whatever tag selection stands.
        })
    }, PREVIEW_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [open, cwd, permissionMode, manualOverride])

  function handleSelectTag(id: number) {
    setManualOverride(true)
    setTagId((current) => (current === id ? current : id))
  }

  const handleLaunch = useCallback(async () => {
    if (!cwd.trim() || pending) return
    setPending(true)
    try {
      const sessionId = await api.createSession({
        cwd: cwd.trim(),
        prompt,
        permissionMode,
        tagId: tagId ?? undefined,
      })
      onClose()
      await select(sessionId)
    } catch (err) {
      reportError(err, 'Failed to launch session')
    } finally {
      setPending(false)
    }
  }, [cwd, prompt, permissionMode, tagId, pending, onClose, select])

  // ⌘↵ / Ctrl+↵ launches from anywhere in the dialog.
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        void handleLaunch()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, handleLaunch])

  const matchedRule = matchedRuleId != null ? rules.find((r) => r.id === matchedRuleId) : undefined
  const showAutoCaption = !manualOverride && matchedTagId != null && tagId === matchedTagId
  const selectedTag = tagId != null ? tags.find((t) => t.id === tagId) : undefined
  const fallbackTag = tags.find((t) => t.is_default === 1)
  const footerTagName = (selectedTag ?? fallbackTag)?.name

  return (
    <Dialog
      open={open}
      title="New session"
      eyebrow="LAUNCH"
      size="lg"
      onClose={onClose}
      footerCaption={
        footerTagName ? (
          <>
            spawns a new planet in <span className="text-text-soft">{footerTagName.toUpperCase()}</span>
          </>
        ) : undefined
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void handleLaunch()} disabled={pending || !cwd.trim()}>
            Launch session <span className="ml-1 font-mono text-[10px] opacity-70">⌘↵</span>
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="new-session-cwd" className="font-mono text-[11px] text-text-muted">
            Working directory
          </label>
          <Input
            id="new-session-cwd"
            font="mono"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/path/to/project"
          />
          {recentDirs.length > 0 && (
            <div className="mt-1 flex items-center gap-1.5" role="group" aria-label="Recent directories">
              <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted">
                recent
              </span>
              <div className="flex min-w-0 flex-wrap gap-1.5">
                {recentDirs.slice(0, 4).map((dir) => (
                  <Chip
                    key={dir}
                    label={shortenPath(dir)}
                    title={dir}
                    active={dir === cwd}
                    onClick={() => setCwd(dir)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <span className="font-mono text-[11px] text-text-muted">Permission mode</span>
          <ModeCards value={permissionMode} onChange={setPermissionMode} />
        </div>

        <div className="flex flex-col gap-1">
          <span className="font-mono text-[11px] text-text-muted">Tag</span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Tag">
            {tags.map((tag) => (
              <Chip
                key={tag.id}
                label={tag.name}
                hue={tag.hue}
                active={tagId === tag.id}
                onClick={() => handleSelectTag(tag.id)}
              />
            ))}
          </div>
          {showAutoCaption && (
            <span className="text-[11px] text-text-muted">
              auto-matched by rule{matchedRule ? ` ${matchedRule.pattern}` : ''}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="new-session-prompt" className="font-mono text-[11px] text-text-muted">
            First prompt
          </label>
          <TextArea
            id="new-session-prompt"
            aria-label="First prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should this session do?"
            rows={3}
          />
        </div>

      </div>
    </Dialog>
  )
}
