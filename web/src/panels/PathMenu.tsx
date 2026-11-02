import { useState } from 'react'
import { canShowInFolder, showInFolder } from '../lib/desktop'
import { deviceLock } from '../lib/devices'
import { copyPathOrReport, reportFailure } from '../lib/errors'
import { CHOOSER_ROWS, matchCount, shownMatches, splitDir, type FoundFile, type NameChoice } from '../lib/findByName'
import { editorsFor, mentionOf, pathMenuGroups, type PathAction } from '../lib/pathMenu'
import { isReadOnly, workingDirOf } from '../lib/types'
import { mentionInReply } from '../store/composerInsert'
import { useOrbital } from '../store/store'
import { ContextMenu } from '../ui/ContextMenu'
import { MENU_SEPARATOR, type MenuEntry, type MenuItem } from '../ui/Menu'
import { CopyGlyph, EditorGlyph, FolderGlyph, MentionGlyph, PageGlyph } from '../ui/UtilityButton'

/**
 * A path's context menu and the bare-name chooser (spec
 * 2026-11-02-bare-file-names-and-path-menu-design; canvas `Feature - Path menu
 * glyphs` 1b–1e). One popup, the session menu's (`ContextMenu`), in two
 * views: the matches of a bare name, and the actions for one file. A press
 * opens the chooser alone, and picking a match opens it; a right-click opens
 * the actions, or the chooser first on a name with several matches, where
 * picking swaps the actions in with Back (1d), as the session menu's Change
 * tag does. Past `CHOOSER_ROWS` matches the chooser's last row counts the
 * rest, and picking it swaps in every match, scrolling `CHOOSER_ROWS` at a
 * time (spec § The chooser).
 */

/** The popup's floor (canvas 1a/1b: `min-width: 232px`). */
const PATH_MENU_MIN_PX = 232

/** The file the actions are about. */
export interface LocatedFile {
  /** Absolute when the server located it; else the path as written. */
  path: string
  located: boolean
  /** For Copy relative path; null when the file was not located. */
  relative: string | null
}

export type PathMenuStart = { kind: 'file'; file: LocatedFile } | { kind: 'choose'; choice: NameChoice }

export interface PathMenuProps {
  /** The pointer of a right-click, or the link a press hangs the chooser under. */
  at: { x: number; y: number } | Element
  sessionId: string | null
  /** The link's `:line`, carried to whatever opens the file. */
  line: number | null
  start: PathMenuStart
  /** What picking a match does: open it (a press), or show the actions for it (a right-click). */
  picks: 'open' | 'actions'
  onOpen: (file: FoundFile) => void
  /** Try again, after no answer came. */
  onRetry: () => void
  /** An editor took the file: the link draws ⌥-click's receipt. */
  onEditorOpened: (name: string) => void
  onClose: () => void
}

/** 1c's file row: the page, the folder dimmed and the name in full ink, `touched` in the key column. */
function FileRow({ file }: { file: FoundFile }) {
  const { dir, name } = splitDir(file.relative)
  return (
    <span className="flex items-center gap-2.5">
      <span aria-hidden className="grid w-5 shrink-0 place-items-center text-ink-500/70 group-focus:text-ink-500/85">
        <PageGlyph />
      </span>
      <span className="min-w-0 flex-1 truncate font-mono fs-11.5 font-normal text-ink-100">
        <span className="text-ink-900/65">{dir}</span>
        {name}
      </span>
      {file.touched && <span className="ml-1 shrink-0 font-mono fs-10 text-ink-900/50">touched</span>}
    </span>
  )
}

/** Whether the session has a composer here to mention a file in: the panel draws one for it. */
function useCanMention(sessionId: string | null): boolean {
  return useOrbital((s) => {
    const session = sessionId ? s.sessions[sessionId] : undefined
    if (!session || isReadOnly(session)) return false
    return deviceLock(session, s.remote?.group?.members, Date.now()) === null
  })
}

export function PathMenu({ at, sessionId, line, start, picks, onOpen, onRetry, onEditorOpened, onClose }: PathMenuProps) {
  const session = useOrbital((s) => (sessionId ? s.sessions[sessionId] : undefined))
  const canMention = useCanMention(sessionId)
  /** The match picked in the chooser, whose actions are on show; null before a pick. */
  const [picked, setPicked] = useState<FoundFile | null>(null)
  /** The chooser lists every match: its `+N more` row was picked. Back from a pick returns to it. */
  const [all, setAll] = useState(false)

  const file: LocatedFile | null =
    start.kind === 'file'
      ? start.file
      : picked
        ? { path: picked.path, located: true, relative: picked.relative }
        : null

  const name = start.kind === 'choose' ? start.choice.name : (start.file.relative ?? start.file.path)
  const entries: MenuEntry[] = file
    ? actionEntries(file)
    : start.kind === 'choose'
      ? chooserEntries(start.choice)
      : []

  function chooserEntries(choice: NameChoice): MenuEntry[] {
    if (choice.kind === 'none') {
      return [{ heading: choice.name, caption: true }, { note: `no file by that name under ${choice.under}`, inset: true }]
    }
    if (choice.kind === 'silent') {
      return [
        { heading: choice.name, caption: true },
        { note: `${choice.device} didn't answer` },
        { key: 'retry', label: 'Try again', onSelect: onRetry },
      ]
    }
    const { rows, more, expands } = shownMatches(choice, all)
    const count = matchCount(choice)
    return [
      { heading: `${choice.name} · ${count} ${count === 1 ? 'match' : 'matches'}`, caption: true },
      ...rows.map(
        (match): MenuItem => ({
          key: match.path,
          label: match.relative,
          body: <FileRow file={match} />,
          keepsOpen: picks === 'actions',
          onSelect: () => (picks === 'actions' ? setPicked(match) : onOpen(match)),
        }),
      ),
      ...(more === 0 ? [] : expands ? [moreItem(more)] : [{ note: `+${more} more not listed · ask for the full path`, inset: true }]),
    ]
  }

  /** 1c's `+N more`: an ordinary row, its glyph column empty, that swaps the full list in. */
  function moreItem(more: number): MenuItem {
    const label = `+${more} more`
    return {
      key: 'more',
      label,
      // 1c: drawn as a match row (`FileRow`) with no glyph and the label as the name.
      body: (
        <span className="flex items-center gap-2.5">
          <span aria-hidden className="w-5 shrink-0" />
          <span className="min-w-0 flex-1 truncate font-mono fs-11.5 font-normal text-ink-100">{label}</span>
        </span>
      ),
      keepsOpen: true,
      onSelect: () => setAll(true),
    }
  }

  function actionEntries(target: LocatedFile): MenuEntry[] {
    const groups = pathMenuGroups({
      relative: target.relative !== null,
      editors: editorsFor(session, target.path),
      // The file has to be on this Mac for Finder to reveal it.
      finder: canShowInFolder() && session !== undefined && !session.machine,
      mention: canMention,
    })
    const out: MenuEntry[] = picked
      ? [
          { key: 'back', label: 'Back', icon: '‹', keepsOpen: true, onSelect: () => setPicked(null) },
          { heading: picked.relative, caption: true },
        ]
      : []
    for (const [i, group] of groups.entries()) {
      if (i > 0) out.push(MENU_SEPARATOR)
      for (const action of group) out.push(actionItem(action, target))
    }
    return out
  }

  function actionItem(action: PathAction, target: LocatedFile): MenuItem {
    switch (action.kind) {
      case 'copy':
        return {
          key: 'copy-path',
          label: 'Copy path',
          icon: <CopyGlyph />,
          onSelect: () => void copyPathOrReport(target.path),
        }
      case 'copy-relative':
        return {
          key: 'copy-relative',
          label: 'Copy relative path',
          icon: <CopyGlyph />,
          onSelect: () => void copyPathOrReport(target.relative ?? target.path),
        }
      case 'editor':
        return {
          key: `editor-${action.id}`,
          label: `Open in ${action.name}`,
          icon: <EditorGlyph />,
          onSelect: () =>
            void useOrbital
              .getState()
              .openInIde(target.path, line, action.id)
              .then((ok) => (ok ? onEditorOpened(action.name) : reportFailure(`Could not open the file in ${action.name}`))),
        }
      case 'finder':
        return {
          key: 'show-in-finder',
          label: 'Show in Finder',
          icon: <FolderGlyph />,
          onSelect: () => (target.located ? showInFolder(target.path) : reportFailure('Could not find the file on disk')),
        }
      case 'mention':
        return {
          key: 'mention',
          label: 'Mention in reply',
          icon: <MentionGlyph />,
          onSelect: () => {
            if (!sessionId || !session) return
            mentionInReply(sessionId, mentionOf(target.path, line, workingDirOf(session)))
          },
        }
    }
  }

  return (
    <ContextMenu
      at={at}
      entries={entries}
      aria-label={file ? `Actions for ${file.relative ?? file.path}` : `Files named ${name}`}
      onClose={onClose}
      minWidthPx={PATH_MENU_MIN_PX}
      view={file ? `actions:${file.path}` : all ? 'choose-all' : 'choose'}
      // The full list scrolls; the capped one shows its rows and the `+N more` row whole.
      maxRows={!file && all ? CHOOSER_ROWS : undefined}
      onBack={picked ? () => setPicked(null) : undefined}
    />
  )
}
