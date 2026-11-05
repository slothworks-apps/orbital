/**
 * A best-effort name for the browser, shown in Orbital's list of pairings.
 * Arc, Dia and Vivaldi report themselves as Chrome; that is fine.
 */

const NAMES: Record<string, string> = {
  'Google Chrome': 'Chrome',
  'Microsoft Edge': 'Edge',
  Brave: 'Brave',
  Opera: 'Opera',
  'Opera GX': 'Opera GX',
  Vivaldi: 'Vivaldi',
  Yandex: 'Yandex',
}

export function browserNameFromBrands(brands: readonly { brand: string }[] | undefined): string {
  const real = (brands ?? [])
    .map((b) => b.brand)
    // GREASE entries such as "Not)A;Brand" exist to be ignored.
    .filter((b) => !/not.?a.?brand/i.test(b))
  const named = real.find((b) => b !== 'Chromium')
  if (named) return NAMES[named] ?? named
  return real.length ? 'Chromium' : 'Chromium browser'
}
