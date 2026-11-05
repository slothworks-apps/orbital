// Bundles the extension into dist/, the folder a browser loads unpacked and
// the desktop app packages. The manifest takes the desktop's version, which
// is the version the extension ships under.
import { build } from 'esbuild'
import { Buffer } from 'node:buffer'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')

await rm(dist, { recursive: true, force: true })
await mkdir(join(dist, 'icons'), { recursive: true })

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

for (const size of [16, 32, 48, 128]) {
  await writeFile(join(dist, 'icons', `${size}.png`), planetIcon(size))
}

// ── a placeholder icon: a planet with a ring, drawn into a PNG by hand ────

function planetIcon(size) {
  const px = Buffer.alloc(size * size * 4)
  const c = (size - 1) / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / size
      const dy = (y - c) / size
      const r = Math.hypot(dx, dy)
      // The ring: an ellipse tilted along the diagonal.
      const u = (dx + dy) / Math.SQRT2
      const v = (dx - dy) / Math.SQRT2
      const ring = Math.abs(Math.hypot(u / 0.48, v / 0.16) - 1) < 0.12
      const i = (y * size + x) * 4
      if (r < 0.3) px.set([108, 92, 231, 255], i)
      else if (ring) px.set([236, 201, 75, 255], i)
    }
  }
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++)
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 6, 0, 0, 0], 8) // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function crc32(buf) {
  let crc = ~0
  for (const byte of buf) {
    crc ^= byte
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}
