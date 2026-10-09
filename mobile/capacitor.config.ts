import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The phone's shell (spec 2026-10-02-mobile-app-design § 1). The web code is
 * `web/`'s mobile build; nothing here decides anything at runtime.
 *
 * `ORBITAL_MOBILE_DEV=1` at `cap sync` time lets the WebView (served from
 * https://localhost) reach a plain-http relay on the Mac through
 * `adb reverse` — a laptop relay, never a deployed one. Cleartext itself is
 * allowed only for loopback addresses, by
 * `android/app/src/main/res/xml/network_security_config.xml`.
 */
const dev = process.env.ORBITAL_MOBILE_DEV === '1';

/**
 * `ORBITAL_MOBILE_RELEASE=1` is set by the root `android:release`,
 * `android:bundle` and `ios:release` scripts, which build what goes to the
 * stores. Only that build turns the over-the-air updater on (spec
 * 2026-10-09-phone-ota-updates-design → Signing): it points the plugin at Beam
 * and builds in the public key every bundle must be signed with (ADR
 * an-ota-bundle-runs-only-if-signed-by-ci). Every other build — dev, a local
 * `npm run build`, a fork's — gets the updater switched off.
 */
const release = process.env.ORBITAL_MOBILE_RELEASE === '1';
if (release && dev) throw new Error('ORBITAL_MOBILE_RELEASE and ORBITAL_MOBILE_DEV exclude each other.');

// Resolved against cwd, not import.meta.url: the Capacitor CLI transpiles this file to CommonJS, and
// it always runs from mobile/.
const read = (file: string): string => readFileSync(join(process.cwd(), file), 'utf8');

/** Beam's address and this app's id there; scripts/ota-bundle.mjs and the web build read the same file. */
const beam = JSON.parse(read('beam.json')) as { url: string; appId: string };

const PUBLIC_KEY_FILE = 'ota-public-key.pem';
/** The plugin skips decryption for a key without this PKCS#1 header (CryptoCipher.decryptFile on both platforms). */
const PKCS1_HEADER = '-----BEGIN RSA PUBLIC KEY-----';

/**
 * The public half of the key CI signs bundles with. A release build without
 * it, or with a key in another format, fails here: the updater without a key
 * would run whatever Beam serves. Runbook ship-the-phone-over-the-air → The
 * key pair.
 */
function otaPublicKey(): string {
  if (!existsSync(join(process.cwd(), PUBLIC_KEY_FILE))) {
    throw new Error(
      `mobile/${PUBLIC_KEY_FILE} is missing: a release build needs the over-the-air public key ` +
        '(runbook docs/ops/ship-the-phone-over-the-air.md → The key pair).',
    );
  }
  const key = read(PUBLIC_KEY_FILE).trim();
  if (!key.startsWith(PKCS1_HEADER)) {
    throw new Error(`mobile/${PUBLIC_KEY_FILE} must be a PKCS#1 RSA public key (${PKCS1_HEADER}).`);
  }
  return key;
}

/**
 * `@capgo/capacitor-updater`. With no config at all it would ask Capgo's
 * cloud for updates and send it stats, so every other build switches it off
 * outright. The release build downloads in the background and stops there
 * (`onlyDownload`): the phone offers the bundle and the user picks the moment
 * (web/src/mobile/update). This config ships in the native binary; a bundle
 * cannot change it.
 */
const updater = release
  ? {
      appId: beam.appId,
      autoUpdate: 'onlyDownload',
      updateUrl: `${beam.url}/api/updates`,
      statsUrl: `${beam.url}/api/stats`,
      publicKey: otaPublicKey(),
      // A store update drops the bundles downloaded for the build it replaced.
      resetWhenUpdate: true,
      autoDeleteFailed: true,
      autoDeletePrevious: true,
      // No channels: Beam has one per app, and nothing may pick another.
      channelUrl: '',
      allowSetDefaultChannel: false,
      // "Send diagnostics" off sets the stats URL to '' (web/src/mobile/update/platform.ts); persisted, the
      // plugin loads it on the next start before it reports anything. The plugin has no switch for the stats
      // URL alone, so any script in the WebView could also move the update and channel URLs, persistently;
      // every start puts them back (`pinUrls`), and a bundle from anywhere must still be signed with our key
      // and newer than what the phone has run (ADR an-ota-bundle-runs-only-if-signed-by-ci).
      allowModifyUrl: true,
      persistModifyUrl: true,
    }
  : { autoUpdate: false, updateUrl: '', statsUrl: '', channelUrl: '' };

const config: CapacitorConfig = {
  appId: 'io.slothworks.orbital.mobile',
  appName: 'Orbital',
  webDir: '../web/dist-mobile',
  // The space colour of web/src/theme.css behind the WebView, so nothing white shows before its first paint.
  backgroundColor: '#05070d',
  android: { allowMixedContent: dev },
  // The app is dark whatever the system theme. `DARK` names the bars' background, so their icons are light;
  // the default follows the system and draws dark icons on our dark background in light mode.
  plugins: {
    SystemBars: { style: 'DARK' },
    // The launch screen (Claude Design, "Feature - Splash screen", 1a) stays until web/src/mobile/main.tsx
    // hides it after the first screen has painted. CENTER: the mark keeps its size on every screen.
    SplashScreen: {
      launchAutoHide: false,
      launchFadeOutDuration: 150,
      showSpinner: false,
      backgroundColor: '#05070d',
      androidScaleType: 'CENTER',
    },
    // iOS: a push that arrives while the app is open is not shown, as on Android. The relay pushes
    // only to a phone it sees offline; an open app posts its own local notification instead.
    FirebaseMessaging: { presentationOptions: [] },
    // Android: the status-bar silhouette and its tint, the same as a push's (AndroidManifest.xml
    // meta-data). The tint is --color-accent of web/src/theme.css.
    LocalNotifications: { smallIcon: 'ic_stat_orbital', iconColor: '#59e4f3' },
    CapacitorUpdater: updater,
  },
};

export default config;
