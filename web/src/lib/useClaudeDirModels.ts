import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { api } from './api'
import type { OrbitalModel } from './types'

/**
 * Which catalog `useClaudeDirModels` reads, or null for the store's own.
 * On this device: a directory other than the default, while there are two
 * or more. On another device (`machine`): that device's, always, for
 * `claudeDirId` read as one of its own directories — its default when null.
 * `key` names the read, so a finished one is not repeated.
 */
export function catalogRead(
  claudeDirId: number | null | undefined,
  machine: string | undefined,
  several: boolean,
  defaultDir: number | null,
): { key: string; dir: number | undefined } | null {
  if (machine) {
    const dir = claudeDirId ?? undefined
    return { key: `m:${machine}:${dir ?? ''}`, dir }
  }
  if (!several || claudeDirId == null || claudeDirId === defaultDir) return null
  return { key: `d:${claudeDirId}`, dir: claudeDirId }
}

/** A directory's catalog and the model ids its sessions used last, newest first. */
export interface ClaudeDirCatalog {
  models: OrbitalModel[]
  recent: string[]
  /**
   * Another directory's read is still out, so the default directory's
   * catalog stands in (with no history: that belongs to another account).
   * False once it has landed or failed, and always for the store's own.
   */
  standIn: boolean
}

export interface CatalogReadOptions {
  /**
   * Read again every time `enabled` turns on, the store's own catalog
   * included — for where a model is chosen for a new session. The store
   * reads it once when the window loads, so models a CLI update added
   * meanwhile would stay hidden until a reload; the server answers from its
   * stored list and re-probes the CLI behind it, so an update shows by the
   * next open. Without it, only another directory's catalog is read, once.
   */
  refresh?: boolean
}

/** One empty history for every render, so what is memoised on it holds. */
const NO_HISTORY: string[] = []

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)

/**
 * The model catalog of one Claude directory — each account has its own
 * models (spec 2026-10-04-multiple-claude-directories-design § 2). The
 * store's catalog is the default directory's, so it answers for the default,
 * for a single directory and while another directory's read is out; a failed
 * read leaves it too, and the server still checks the model at launch.
 *
 * `machine` names another device of the group (New session launching
 * there, canvas 50g; a session that runs there): its catalog is read
 * instead, `claudeDirId` then being one of that device's directories, its
 * own account deciding what it offers; this device's stands in until it lands.
 */
export function useClaudeDirCatalog(
  claudeDirId: number | null | undefined,
  enabled = true,
  machine?: string,
  { refresh = false }: CatalogReadOptions = {},
): ClaudeDirCatalog {
  const catalog = useOrbital(useShallow((s) => s.models))
  const recentHere = useOrbital(useShallow((s) => s.recentModels))
  const several = useOrbital((s) => s.claudeDirs.length >= 2)
  const defaultDir = useOrbital((s) => s.defaultClaudeDir)
  const [own, setOwn] = useState<{ key: string; models: OrbitalModel[]; recent: string[] } | null>(null)
  /** The read that failed last: the default's catalog stays, no longer a stand-in. */
  const [failedKey, setFailedKey] = useState<string | null>(null)
  const read = enabled ? catalogRead(claudeDirId, machine, several, defaultDir) : null
  const key = read?.key ?? null
  const dir = read?.dir
  const settled = key !== null && (own?.key === key || failedKey === key)
  const wanted = enabled && (refresh || (key !== null && !settled))

  useEffect(() => {
    if (!wanted) return
    let live = true
    api
      .listModels(dir, machine)
      .then((r) => {
        if (!live || !r) return
        if (key === null) {
          // Only what changed: an identical answer must not rebuild everything that reads the catalog (the map).
          const s = useOrbital.getState()
          const patch: Partial<Pick<typeof s, 'models' | 'contextWindows' | 'recentModels'>> = {}
          if (!same(s.models, r.models)) patch.models = r.models
          if (!same(s.contextWindows, r.contextWindows)) patch.contextWindows = r.contextWindows
          if (!same(s.recentModels, r.recentModels)) patch.recentModels = r.recentModels
          if (Object.keys(patch).length > 0) useOrbital.setState(patch)
        } else {
          setOwn((prev) =>
            prev?.key === key && same(prev.models, r.models) && same(prev.recent, r.recentModels)
              ? prev
              : { key, models: r.models, recent: r.recentModels },
          )
        }
      })
      .catch(() => {
        if (live && key !== null) setFailedKey(key)
      })
    return () => {
      live = false
    }
  }, [wanted, key, dir, machine])

  if (key !== null && own?.key === key) return { models: own.models, recent: own.recent, standIn: false }
  // Another directory's read still out: the default's catalog stands in, but
  // not its history, which belongs to another account.
  if (key !== null) return { models: catalog, recent: NO_HISTORY, standIn: failedKey !== key }
  return { models: catalog, recent: recentHere, standIn: false }
}

/** `useClaudeDirCatalog`'s models alone, for the surfaces with no recent cards. */
export function useClaudeDirModels(
  claudeDirId: number | null | undefined,
  enabled = true,
  machine?: string,
): OrbitalModel[] {
  return useClaudeDirCatalog(claudeDirId, enabled, machine).models
}

/** What New session's recent-model cards are drawn from. */
export interface CardSource {
  models: OrbitalModel[]
  recent: string[]
  /** The model that keeps a card of its own. */
  preselected: string | null
}

/**
 * `live`, held still once the user has picked a model in this open (spec
 * 2026-11-27-recent-model-cards-design): until then the row follows what
 * comes in — the cached catalog, then this open's fresh read, the
 * preselection as the directory is typed — and after it nothing moves a
 * card under the pointer. Another account (`scope`, the device and Claude
 * directory) starts over, and so does a catalog that was only standing in.
 */
export function useHeldCardSource(
  live: CardSource & { standIn: boolean },
  scope: string,
  picked: boolean,
): CardSource {
  const held = useRef<(CardSource & { scope: string; standIn: boolean }) | null>(null)
  const h = held.current
  if (!(picked && h && h.scope === scope && !h.standIn)) {
    if (
      !h ||
      h.scope !== scope ||
      h.standIn !== live.standIn ||
      h.models !== live.models ||
      h.recent !== live.recent ||
      h.preselected !== live.preselected
    ) {
      held.current = { scope, standIn: live.standIn, models: live.models, recent: live.recent, preselected: live.preselected }
    }
  }
  return held.current!
}
