import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { EscapeBoundary, useEscapeLayer } from '../ui/escapeLayer'
import { usePresence } from '../ui/usePresence'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import type { CommandContent, CompletionKey } from '../lib/types'
import { sourceLabel } from './CompletionPopup'
import { MarkdownBody, RefusalBody, VIEWER_ENTER_MS, VIEWER_EXIT_MS } from './FileViewer'

/**
 * The whole of a skill or command file, opened by clicking its tinted token in
 * the composer (spec: 2026-09-30-skill-preview-design).
 *
 * The file viewer's surface — same portal, escape layer, presence and shell —
 * with the markdown body only: a skill is always markdown, and there is no
 * line to target, no editor to hand it to and no URL to mirror it into.
 * Nothing on the canvas draws it yet; it borrows the file viewer's look until
 * Claude Design does.
 */
export function SkillViewer({
  commandKey,
  name,
  onClose,
}: {
  commandKey: CompletionKey
  /** The command to show, without its slash; null when closed. */
  name: string | null
  onClose: () => void
}) {
  const open = name !== null
  useEscapeLayer(open, onClose)
  const { mounted, state } = usePresence(open, VIEWER_ENTER_MS, VIEWER_EXIT_MS)

  // The outgoing skill keeps rendering while the surface animates out.
  const lastName = useRef(name)
  if (name) lastName.current = name
  const shown = name ?? lastName.current

  /** Undefined while reading; null when the catalog no longer has a file. */
  const [content, setContent] = useState<CommandContent | null | undefined>(undefined)

  const sessionKey = 'session' in commandKey ? commandKey.session : null
  const cwdKey = 'cwd' in commandKey ? commandKey.cwd : null
  const dirKey = 'cwd' in commandKey ? commandKey.claudeDir : undefined
  useEffect(() => {
    if (name === null) return
    let cancelled = false
    setContent(undefined)
    const key: CompletionKey =
      sessionKey !== null
        ? { session: sessionKey }
        : { cwd: cwdKey ?? '', ...(dirKey !== undefined ? { claudeDir: dirKey } : {}) }
    api
      .commandContent(key, name)
      .then((found) => {
        if (!cancelled) setContent(found)
      })
      .catch((err) => {
        if (cancelled) return
        reportError(err, 'Failed to read the skill')
        onClose()
      })
    return () => {
      cancelled = true
    }
    // `onClose` is the caller's setter; a fresh closure is not a new skill.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, sessionKey, cwdKey, dirKey])

  if (!mounted || shown === null) return null
  const entered = state === 'entered'

  const meta =
    content === undefined
      ? 'reading…'
      : content === null
        ? 'not read'
        : [sourceLabel(content.source, content.name), content.path].join(' · ')

  return createPortal(
    <EscapeBoundary>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Skill /${shown}`}
        data-state={state}
        inert={state === 'exiting' || undefined}
        onClick={onClose}
        style={{ transition: 'opacity 140ms ease', opacity: entered ? 1 : 0 }}
        className="orbital-no-drag fixed inset-0 z-50 grid place-items-center bg-[rgba(2,4,9,.82)] p-6 backdrop-blur-[6px]"
      >
        <div
          onClick={(event) => event.stopPropagation()}
          style={{
            // The file viewer's markdown size (8e).
            width: 980,
            height: 760,
            maxWidth: 'min(86vw, 1100px)',
            maxHeight: '86vh',
            transition: 'transform 180ms cubic-bezier(.2,.9,.25,1)',
            transform: entered ? 'scale(1)' : 'scale(.98)',
          }}
          className="flex flex-col overflow-hidden rounded-[14px] border border-[rgba(150,205,255,.22)] bg-[linear-gradient(180deg,rgba(14,20,34,.96),rgba(8,12,22,.98))] shadow-[0_40px_120px_rgba(0,0,0,.7)]"
        >
          <div className="flex items-start gap-3 border-b border-[rgba(150,205,255,.1)] px-[18px] pb-3.5 pt-4">
            <div className="flex min-w-0 flex-1 flex-col gap-[7px]">
              <div className="min-w-0 truncate font-mono text-[14px] text-[#f2f9ff]">/{shown}</div>
              {content?.description && (
                <div className="text-[12.5px] leading-[1.5] text-[rgba(160,190,225,.8)] [text-wrap:pretty]">
                  {content.description}
                </div>
              )}
              <div className="truncate font-mono text-[10.5px] tracking-[0.06em] text-[rgba(160,190,225,.55)]">
                {meta}
              </div>
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[8px] border border-[rgba(150,205,255,.2)] bg-[rgba(10,14,24,.7)] text-[15px] text-text-bright transition-colors hover:border-[rgba(150,205,255,.45)]"
            >
              ×
            </button>
          </div>

          {content === undefined ? (
            <div className="min-h-0 flex-1" />
          ) : content === null ? (
            <RefusalBody label="NO FILE BEHIND THIS COMMAND" sentence={null} />
          ) : (
            <MarkdownBody content={content.body} />
          )}

          <div className="flex items-center gap-2.5 border-t border-[rgba(150,205,255,.1)] px-[18px] py-2.5 font-mono text-[10px] tracking-[0.08em] text-[rgba(160,190,225,.55)]">
            <span className="rounded-[4px] border border-[rgba(150,205,255,.2)] px-1.5 py-[2px] text-[rgba(200,220,245,.7)]">
              esc
            </span>
            closes · read-only
          </div>
        </div>
      </div>
    </EscapeBoundary>,
    document.body,
  )
}
