import { shortenPath } from '../lib/format'

/**
 * The project filter's options.
 *
 * The overview endpoint filters on `sessions.project_dir` — the name of the
 * transcript directory under `~/.claude/projects`, not a path — while
 * `/api/projects` lists the readable `cwd`s the app already knows. The two are
 * bridged here, by the same encoding the CLI uses to name that directory:
 * every character that is not a letter or a digit becomes a dash. It is an
 * undocumented format that can change under a CLI update (see the README's
 * `~/.claude` caveats); when it does, the filter stops matching and the
 * dashboard reads as empty for that project — it never shows the wrong one.
 *
 * The encoding is lossy (a dash and a slash arrive identical), so nothing here
 * ever decodes: a directory is turned back into a path by finding the cwd that
 * encodes to it.
 */
export function projectDirFor(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export interface ProjectOption {
  /** The endpoint's `project` parameter; empty for no filter. */
  value: string
  label: string
}

/** Option lists are keyed by the filter value, so the empty string is "all". */
export function projectOptions(projects: ReadonlyArray<{ cwd: string }>): ProjectOption[] {
  return [
    { value: '', label: projects.length > 0 ? `all (${projects.length})` : 'all' },
    ...projects.map((project) => ({
      value: projectDirFor(project.cwd),
      label: shortenPath(project.cwd),
    })),
  ]
}

/**
 * A finding names its session's project by transcript directory. Matching it
 * back to a cwd is what lets a card read `~/…/work/orbital` instead of the
 * encoded name; a directory no project claims (a session whose cwd the index
 * has since forgotten) keeps the raw name rather than a guess.
 */
export function projectLabeller(
  projects: ReadonlyArray<{ cwd: string }>
): (projectDir: string | null) => string | null {
  const byDir = new Map(projects.map((project) => [projectDirFor(project.cwd), project.cwd]))
  return (projectDir) => {
    if (projectDir === null) return null
    const cwd = byDir.get(projectDir)
    return cwd === undefined ? projectDir : shortenPath(cwd)
  }
}
