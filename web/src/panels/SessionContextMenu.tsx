import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { ContextMenu, MENU_SEPARATOR, type MenuEntry } from '../ui/Menu'
import { moveFor, sectionOf } from '../lib/sessionMoves'
import { reportError } from '../lib/errors'
import { tagColor, type ApiSession, type Tag } from '../lib/types'

/**
 * The right-click menu over a session — a sidebar row or a planet (spec
 * 2026-10-19-docked-sessions-design § Right-click menu). The same actions the
 * phone's session sheet offers, plus Dock / Undock; only what fits the
 * session is listed. Mounted once by `App` and opened through
 * `ui.sessionMenu`.
 */
export function SessionContextMenu() {
  const menu = useOrbital((s) => s.ui.sessionMenu ?? null)
  const session = useOrbital((s) => (menu ? s.sessions[menu.id] : undefined))
  const tags = useOrbital(useShallow((s) => s.tags))
  const close = useOrbital((s) => s.closeSessionMenu)
  if (!menu || !session) return null
  return (
    <ContextMenu
      // A new session's menu is a new menu: focus and position start over.
      key={`${menu.id}:${menu.x}:${menu.y}`}
      aria-label={`${session.title || 'Session'} actions`}
      x={menu.x}
      y={menu.y}
      onClose={close}
      widthPx={220}
      maxRows={14}
      entries={sessionMenuEntries(session, tags)}
    />
  )
}

export function sessionMenuEntries(session: ApiSession, tags: Tag[]): MenuEntry[] {
  const store = useOrbital.getState()
  const id = session.id
  const section = sectionOf(session)
  const web = session.source === 'web'
  const ended = session.status === 'ended'
  const entries: MenuEntry[] = []

  if (section === 'pinned') {
    entries.push({ key: 'unpin', label: 'Unpin', onSelect: () => void store.setSessionPinned(id, false) })
  } else {
    entries.push({ key: 'pin', label: 'Pin to top', onSelect: () => void store.setSessionPinned(id, true) })
  }
  if (section === 'docked') {
    entries.push({ key: 'undock', label: 'Undock', onSelect: () => void store.setSessionDocked(id, false) })
  } else if (moveFor(session, 'docked')) {
    entries.push({ key: 'dock', label: 'Dock', onSelect: () => void store.setSessionDocked(id, true) })
  }
  entries.push({ key: 'rename', label: 'Rename', onSelect: () => void store.requestPanelAction(id, 'rename') })

  if (tags.length > 0) {
    entries.push({ heading: 'Tag' })
    for (const tag of tags) {
      entries.push({
        key: `tag-${tag.id}`,
        label: tag.name,
        icon: <span className="block h-2 w-2 rounded-full" style={{ background: tagColor(tag.hue) }} />,
        selected: session.tagIds.length === 1 && session.tagIds[0] === tag.id,
        onSelect: () =>
          void store.setSessionTag(id, tag.id).catch((err) => reportError(err, 'Failed to change the session tag')),
      })
    }
  }

  if (web) {
    entries.push(MENU_SEPARATOR)
    entries.push({
      key: 'clear', label: 'Clear and start over', onSelect: () => void store.requestPanelAction(id, 'clear'),
    })
    entries.push(
      ended
        ? { key: 'reopen', label: 'Reopen', onSelect: () => void store.moveSession(id, 'active') }
        : { key: 'end', label: 'End session', onSelect: () => void store.requestPanelAction(id, 'end') },
    )
  }
  return entries
}
