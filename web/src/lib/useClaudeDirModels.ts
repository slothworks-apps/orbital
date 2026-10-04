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
 */
export function useClaudeDirModels(claudeDirId: number | null | undefined, enabled = true): OrbitalModel[] {
  const catalog = useOrbital(useShallow((s) => s.models))
  const several = useOrbital((s) => s.claudeDirs.length >= 2)
  const defaultDir = useOrbital((s) => s.defaultClaudeDir)
  const [own, setOwn] = useState<{ dir: number; models: OrbitalModel[] } | null>(null)
  const dir = enabled && several && claudeDirId != null && claudeDirId !== defaultDir ? claudeDirId : null

  useEffect(() => {
    if (dir === null || own?.dir === dir) return
    let live = true
    api
      .listModels(dir)
      .then((r) => {
        if (live && r) setOwn({ dir, models: r.models })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [dir, own?.dir])

  return dir !== null && own?.dir === dir ? own.models : catalog
}
