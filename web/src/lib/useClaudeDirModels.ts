import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { api } from './api'
import type { OrbitalModel } from './types'

/**
 * The model catalog of one Claude directory — each account has its own
 * models (spec 2026-10-04-multiple-claude-directories-design § 2). The
 * store's catalog is the default directory's, so it answers for the default,
 * for a single directory and while another directory's read is out; a failed
 * read leaves it too, and the server still checks the model at launch.
 *
 * `machine` names another device of the group (New session launching
 * there, canvas 50g): its default directory's catalog is read instead, its
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
  const dir = !machine && several && claudeDirId != null && claudeDirId !== defaultDir ? claudeDirId : null
  /** Which catalog is read, or null for the store's own. */
  const key = !enabled ? null : machine ? `m:${machine}` : dir !== null ? `d:${dir}` : null

  useEffect(() => {
    if (key === null || own?.key === key) return
    let live = true
    api
      .listModels(dir ?? undefined, machine)
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
