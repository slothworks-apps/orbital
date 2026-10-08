package io.slothworks.orbital.mobile;

import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** Capacitor Preferences' file, where the web app keeps its settings. */
    private static final String PREFERENCES = "CapacitorStorage";
    /** `APP_LOCK_KEY` in web/src/mobile/platform/appLock.ts: on unless it reads "false". */
    private static final String APP_LOCK_KEY = "orbital.appLock";
    /** `PAIRING_KEY` in web/src/mobile/platform/pairing.ts: the lock applies only while a Mac is paired. */
    private static final String PAIRING_KEY = "orbital.pairing";

    private SharedPreferences preferences;

    // Held here: SharedPreferences keeps its listeners only weakly.
    private final SharedPreferences.OnSharedPreferenceChangeListener onPreference = (prefs, key) -> {
        if (APP_LOCK_KEY.equals(key) || PAIRING_KEY.equals(key)) runOnUiThread(this::applySecureFlag);
    };

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SecuritySettingsPlugin.class);
        registerPlugin(NotificationSettingsPlugin.class);
        super.onCreate(savedInstanceState);
        preferences = getSharedPreferences(PREFERENCES, MODE_PRIVATE);
        preferences.registerOnSharedPreferenceChangeListener(onPreference);
        applySecureFlag();
    }

    @Override
    public void onDestroy() {
        preferences.unregisterOnSharedPreferenceChangeListener(onPreference);
        super.onDestroy();
    }

    /**
     * While the app lock is on, the window is secure: the app-switcher
     * snapshot comes out blank rather than showing the last screen, which
     * Android may capture before the WebView has drawn the lock screen
     * (spec 2026-10-06-pairing-code-and-app-lock-design § 3). It also keeps
     * screenshots of the app from being taken.
     */
    private void applySecureFlag() {
        boolean on = !"false".equals(preferences.getString(APP_LOCK_KEY, null))
            && preferences.getString(PAIRING_KEY, null) != null;
        if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
    }
}
