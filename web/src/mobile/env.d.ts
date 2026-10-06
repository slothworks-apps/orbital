/** True in a build made with `ORBITAL_MOBILE_DEV=1` (vite.mobile.config.ts): the paste field shows beside the scanner. */
declare const __MOBILE_DEV__: boolean

/** `version` from mobile/package.json, set by vite.mobile.config.ts. */
declare const __MOBILE_VERSION__: string

/** Per platform, whether the build found its Firebase config (vite.mobile.config.ts): push can register. */
declare const __MOBILE_PUSH__: { android: boolean; ios: boolean }
