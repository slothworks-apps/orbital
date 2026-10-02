/**
 * three.js must stay out of the phone's bundle (spec 2026-10-02-mobile-app-design
 * § 1): the map is the desktop's, and a three import reachable from the
 * store or `lib/` would ship it anyway. A Vite manifest names chunks, not
 * their modules, so the mobile build also writes `chunk-modules.json`
 * (`vite.mobile.config.ts`) and this reads both.
 */
export type ViteManifest = Record<
  string,
  { file: string; imports?: string[]; dynamicImports?: string[]; isEntry?: boolean }
>
export type ChunkModules = Record<string, string[]>

export const FORBIDDEN_MODULE = /[\\/]node_modules[\\/](three|@react-three)[\\/]/

/** Every offending `<chunk>: <module>`; a JS chunk missing from `chunkModules` counts, since it went unchecked. */
export function forbiddenModules(manifest: ViteManifest, chunkModules: ChunkModules): string[] {
  const hits: string[] = []
  const files = [...new Set(Object.values(manifest).map((entry) => entry.file))]
    .filter((file) => file.endsWith('.js'))
    .sort()
  for (const file of files) {
    const modules = chunkModules[file]
    if (!modules) {
      hits.push(`${file}: not in chunk-modules.json`)
      continue
    }
    for (const id of modules) if (FORBIDDEN_MODULE.test(id)) hits.push(`${file}: ${id}`)
  }
  return hits
}
