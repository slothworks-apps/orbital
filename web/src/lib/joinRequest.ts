/**
 * The words of a join request only the screens say (canvas 50c on the
 * desktop, 50i's sheet on the phone): the kind tile and where the code is
 * found. The words the `orbital` CLI says too live in
 * `@orbital/shared/remote/groupWords`. Platform-free, so both draw the same
 * request.
 */

/**
 * The kind tile's word and meaning line (canvas 50c `cK.word`/`cK.note` in
 * logic.js; the headless tile's as `Feature - Remote update` 50t redraws
 * it). An unrecognised kind reads as `desktop`, the fallback `KindGlyph`
 * itself draws.
 */
const KIND_TILE = {
  desktop: { word: 'DESKTOP', note: 'A computer with Orbital open on it.' },
  headless: { word: 'HEADLESS', note: 'A server with no map. Managed from a terminal.' },
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
