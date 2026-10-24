import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { copyToClipboard } from '../lib/clipboard'
import { detachSession, hasDesktopBridge } from '../lib/desktop'
import { machineOffline } from '../lib/devices'
import { reportError } from '../lib/errors'
import { primaryTag } from '../lib/primaryTag'
import { contextMenuGroups, type ContextAction } from '../lib/sessionContextMenu'
import { tagColor, workingDirOf } from '../lib/types'
import type { Tag } from '../lib/types'
import {
  askToClear,
  askToRename,
  askToTakeOver,
  changeTag,
  closeSessionMenu,
  openSessionMenu,
  regenerateName,
  useSessionActions,
  type SessionMenuSurface,
} from '../store/sessionActions'
import { useOrbital } from '../store/store'
import { ContextMenu } from '../ui/ContextMenu'
import { MENU_SEPARATOR } from '../ui/Menu'
import type { MenuEntry, MenuItem } from '../ui/Menu'
import { PinGlyph } from '../ui/PinButton'
import { ClearGlyph, DetachGlyph, EndGlyph, RefreshGlyph } from '../ui/UtilityButton'
import { MORE_MENU_PX } from './UtilityStrip'

/**
 * The session context menu (spec 2026-10-24-session-context-menu-design): a
 * right-click on a planet, a Desk card or a sidebar row opens a menu of what
 * can be done with that session, at the pointer, without opening it.
 *
 * `SessionMenuHost` is what makes a right-click mean anything: the targets
 * ask `useSessionMenu` for a handler, and get one only under a host. The
 * app mounts one; the website's demos render the same map and sidebar
 * without it, so there a right-click is the browser's, as before.
 */

/** Whether a host is mounted above — see `useSessionMenu`. */
const SessionMenuContext = createContext(false)

/** The pointer event a target hands over — DOM or r3f's native one. */
interface ContextPointer {
  clientX: number
  clientY: number
  preventDefault(): void
}

/**
 * The right-click handler for a target that stands for a session, or null
 * where no host is mounted (no handler, no menu, the browser's own menu
 * left alone). `onOpen` is what the menu's Open does — the target's own
 * left-click.
 */
export function useSessionMenu(
  from: SessionMenuSurface,
  onOpen: (id: string) => void,
): ((sessionId: string, e: ContextPointer) => void) | null {
  const hosted = useContext(SessionMenuContext)
  const latestOnOpen = useRef(onOpen)
  latestOnOpen.current = onOpen
  return useMemo(
    () =>
      hosted
        ? (sessionId: string, e: ContextPointer) => {
            e.preventDefault()
            openSessionMenu(sessionId, { x: e.clientX, y: e.clientY, from }, (id) => latestOnOpen.current(id))
          }
        : null,
    [hosted, from],
  )
}

/**
 * The session the open menu is about, when it was opened from `from` — its
 * planet or row holds its hover look meanwhile. Only there: a planet that
 * lit up for a menu opened in the sidebar would be motion nobody asked for.
 */
export function useSessionMenuSubject(from: SessionMenuSurface): string | null {
  return useSessionActions((s) => (s.menu?.from === from ? s.menu.sessionId : null))
}

export function SessionMenuHost({ children }: { children: ReactNode }) {
  const menu = useSessionActions((s) => s.menu)
  return (
    <SessionMenuContext.Provider value={true}>
      {children}
      {menu && (
        // Keyed on the point: a right-click elsewhere is a new opening, with
        // its rows back on the session's actions.
        <SessionMenu
          key={`${menu.sessionId}:${menu.x}:${menu.y}`}
          sessionId={menu.sessionId}
          at={{ x: menu.x, y: menu.y }}
          onOpen={menu.onOpen}
        />
      )}
    </SessionMenuContext.Provider>
  )
}

/**
 * The working directory to the clipboard. The menu has closed by then and
 * nothing in the app draws a copy receipt, so a copy that did not land is
 * said and recorded (adr errors-are-recorded-not-announced) rather than
 * dropped.
 */
async function copyPath(path: string): Promise<void> {
  if (await copyToClipboard(path)) return
  reportError(new Error('Could not copy the path to the clipboard'), 'Could not copy the path to the clipboard')
}

/** A tag's dot, as `Select` draws one beside a tag option. */
function TagDot({ tag }: { tag: Tag | undefined }) {
  if (!tag) return null
  return <span aria-hidden className="block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tagColor(tag.hue) }} />
}

function SessionMenu({
  sessionId,
  at,
  onOpen,
}: {
  sessionId: string
  at: { x: number; y: number }
  onOpen: (id: string) => void
}) {
  const session = useOrbital((s) => s.sessions[sessionId])
  const tags = useOrbital(useShallow((s) => s.tags))
  const asksBeforeClear = useOrbital((s) => s.settings.confirm_before_clear !== 'false')
  const offline = useOrbital((s) => {
    const it = s.sessions[sessionId]
    return it ? machineOffline(it, s.remote?.group?.members) : false
  })
  const retitling = useSessionActions((s) => s.retitling.includes(sessionId))
  const setSessionPinned = useOrbital((s) => s.setSessionPinned)
  /** Change tag swaps the tag list in for the actions, as the phone's sheet does. */
  const [view, setView] = useState<'actions' | 'tag'>('actions')

  // A session that leaves the store (deleted elsewhere) takes its menu with it.
  const gone = session === undefined
  useEffect(() => {
    if (gone) closeSessionMenu()
  }, [gone])
  if (!session) return null

  const tag = primaryTag(session.tagIds, tags)
  const pinned = session.pinnedAt != null
  const path = workingDirOf(session)

  function item(action: ContextAction, disabled: boolean): MenuItem {
    const id = sessionId
    switch (action) {
      case 'open':
        return { key: action, label: 'Open', disabled, onSelect: () => onOpen(id) }
      case 'detach':
        return { key: action, label: 'Open in new window', icon: <DetachGlyph />, disabled, onSelect: () => detachSession(id) }
      case 'rename':
        // The header's own mark beside the title it edits.
        return { key: action, label: 'Rename…', icon: '✎', disabled, onSelect: () => askToRename(id, onOpen) }
      case 'regenerate':
        return {
          key: action,
          label: 'Regenerate name',
          icon: <RefreshGlyph spinning={retitling} />,
          // As the header's button: one at a time.
          disabled: disabled || retitling,
          onSelect: () => regenerateName(id),
        }
      case 'tag':
        return { key: action, label: 'Change tag', icon: <TagDot tag={tag} />, disabled, keepsOpen: true, onSelect: () => setView('tag') }
      case 'pin':
        return {
          key: action,
          label: pinned ? 'Unpin' : 'Pin',
          icon: <PinGlyph size={24} pinned={pinned} />,
          disabled,
          onSelect: () => void setSessionPinned(id, !pinned),
        }
      case 'copy-path':
        return { key: action, label: 'Copy path', disabled, onSelect: () => void copyPath(path) }
      case 'takeover':
        return { key: action, label: 'Take over', disabled, onSelect: () => askToTakeOver(id) }
      case 'clear':
        return {
          key: action,
          // The ellipsis promises a dialog; with "don't ask again" set there is none.
          label: asksBeforeClear ? 'Clear and start over…' : 'Clear and start over',
          icon: <ClearGlyph />,
          disabled,
          onSelect: () => askToClear(id),
        }
      case 'end':
        return { key: action, label: 'End session…', icon: <EndGlyph />, disabled, onSelect: () => useOrbital.getState().setDialog('end', id) }
    }
  }

  let entries: MenuEntry[]
  if (view === 'tag') {
    entries = [
      { key: 'back', label: 'Back', icon: '‹', keepsOpen: true, onSelect: () => setView('actions') },
      MENU_SEPARATOR,
      { heading: 'Change tag' },
      ...tags.map(
        (t): MenuItem => ({
          key: `tag-${t.id}`,
          label: t.name,
          icon: <TagDot tag={t} />,
          selected: t.id === tag?.id,
          onSelect: () => changeTag(sessionId, t.id),
        }),
      ),
    ]
  } else {
    const groups = contextMenuGroups(session, { offline, detachable: hasDesktopBridge() })
    entries = []
    for (const [i, group] of groups.entries()) {
      if (i > 0) entries.push(MENU_SEPARATOR)
      for (const row of group) entries.push(item(row.action, row.disabled))
    }
  }

  return (
    <ContextMenu
      at={at}
      entries={entries}
      aria-label={`Actions for ${session.title || 'Untitled session'}`}
      onClose={closeSessionMenu}
      widthPx={MORE_MENU_PX}
      view={view}
    />
  )
}
