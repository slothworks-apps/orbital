import pkg from '../package.json' with { type: 'json' };

/**
 * The version this relay ships under, announced in `challenge` and in
 * `RELAY_VERSION_HEADER` (spec 2026-10-07-version-compatibility-design § 2).
 * The build inlines the import, so the image needs no package.json at runtime.
 */
export const RELAY_VERSION: string = pkg.version;
