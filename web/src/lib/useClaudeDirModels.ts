import { useEffect, useState } from 'react'
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
export function useClaudeDirModels(
  claudeDirId: number | null | undefined,
  enabled = true,
  machine?: string,
): OrbitalModel[] {
  const catalog = useOrbital(useShallow((s) => s.models))
  const several = useOrbital((s) => s.claudeDirs.length >= 2)
  const defaultDir = useOrbital((s) => s.defaultClaudeDir)
  const [own, setOwn] = useState<{ key: string; models: OrbitalModel[] } | null>(null)
  const read = enabled ? catalogRead(claudeDirId, machine, several, defaultDir) : null
  const key = read?.key ?? null
  const dir = read?.dir

  useEffect(() => {
    if (key === null || own?.key === key) return
    let live = true
    api
      .listModels(dir, machine)
      .then((r) => {
        if (live && r) setOwn({ key, models: r.models })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [key, dir, machine, own?.key])

  return key !== null && own?.key === key ? own.models : catalog
}
