// Bundles the extension into dist/, the folder a browser loads unpacked and
// the desktop app packages. The manifest takes the desktop's version, which
// is the version the extension ships under.
import { build } from 'esbuild'
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')

await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })

await build({
  entryPoints: ['worker', 'content', 'popup'].map((name) => join(root, 'src', `${name}.ts`)),
  outdir: dist,
  bundle: true,
  // Content scripts cannot be modules; one format for all three keeps it simple.
  format: 'iife',
  target: 'chrome116',
  logLevel: 'warning',
})

const desktop = JSON.parse(await readFile(join(root, '..', 'desktop', 'package.json'), 'utf8'))
const manifest = JSON.parse(await readFile(join(root, 'static', 'manifest.json'), 'utf8'))
manifest.version = desktop.version
await writeFile(join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

for (const file of ['popup.html', 'popup.css']) {
  await copyFile(join(root, 'static', file), join(dist, file))
}

// The icons are rendered from src/icon.ts by scripts/render-icons.mjs and
// committed; the fonts are bundled, as an extension loads nothing remote.
await cp(join(root, 'static', 'icons'), join(dist, 'icons'), { recursive: true })
await cp(join(root, 'static', 'fonts'), join(dist, 'fonts'), { recursive: true })
