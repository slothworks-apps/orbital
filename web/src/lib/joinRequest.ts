/**
 * The words of a join request (canvas 50c on the desktop, 50i's sheet on the
 * phone): the kind tile, the sentence that names the kind again, where the
 * code is found, and the wrong-code line. Platform-free, so both draw the
 * same request.
 */
import { osName } from '@orbital/shared/remote/device'
import { osLabel } from './devices'

/**
 * The kind tile's word and meaning line (canvas 50c `cK.word`/`cK.note` in
 * logic.js). An unrecognised kind reads as `desktop`, the fallback
 * `KindGlyph` itself draws.
 */
const KIND_TILE = {
  desktop: { word: 'DESKTOP', note: 'A computer with Orbital open on it.' },
  headless: { word: 'HEADLESS SERVER', note: 'No screen of its own. It runs sessions for the group.' },
  phone: { word: 'PHONE', note: 'Reads and drives sessions; runs none of its own.' },
} satisfies Record<string, { word: string; note: string }>

/** A lookup rather than a cast: only a key `KIND_TILE` actually has narrows `kind`. */
function isTiledKind(kind: string): kind is keyof typeof KIND_TILE {
  return kind in KIND_TILE
}

export function kindTile(kind: string): { word: string; note: string } {
  return isTiledKind(kind) ? KIND_TILE[kind] : KIND_TILE.desktop
}

/**
 * Where to find the code a request asks for, by kind (canvas 50c
 * `cK.where`): a desktop or a phone shows it on its own screen; a headless
 * member has no screen, so its code is printed where `orbital devices add`
 * ran (spec 2026-10-16-device-group-design § 3).
 */
export function whereLine(kind: string, name: string): string {
  return kind === 'headless' ? `Type the code ${name} printed in its terminal.` : `Type the code shown on ${name}.`
}

/**
 * `imac-home (desktop, macOS 15.1) wants to join`: the kind a second time,
 * in its own short form — not the tile's fallback-to-desktop word; an
 * unrecognised kind passes through verbatim (canvas 50c `cK.short`).
 * `platform` as the request carried it: a Node platform (`darwin`) or an
 * OS name (`macos`, `android`) both read as the OS.
 */
export function joinSentence(request: { name: string; kind: string; platform: string }): string {
  const os = osLabel(osName(request.platform))
  const kindOs = os === '' ? request.kind : `${request.kind}, ${os}`
  return `${request.name} (${kindOs}) wants to join`
}

/** After a wrong code (canvas 9o C, 50d A): the boxes clear and this line counts what is left. */
export function attemptsLine(attemptsLeft: number): string {
  return `That code didn’t match · ${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} left`
}
