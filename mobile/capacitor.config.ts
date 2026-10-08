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

const config: CapacitorConfig = {
  appId: 'io.slothworks.orbital.mobile',
  appName: 'Orbital',
  webDir: '../web/dist-mobile',
  android: { allowMixedContent: dev },
  // The app is dark whatever the system theme. `DARK` names the bars' background, so their icons are light;
  // the default follows the system and draws dark icons on our dark background in light mode.
  plugins: {
    SystemBars: { style: 'DARK' },
    // iOS: a push that arrives while the app is open is not shown, as on Android. The relay pushes
    // only to a phone it sees offline; an open app posts its own local notification instead.
    FirebaseMessaging: { presentationOptions: [] },
    // Android: the status-bar silhouette and its tint, the same as a push's (AndroidManifest.xml
    // meta-data). The tint is --color-accent of web/src/theme.css.
    LocalNotifications: { smallIcon: 'ic_stat_orbital', iconColor: '#59e4f3' },
  },
};

export default config;
