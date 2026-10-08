package io.slothworks.orbital.mobile;

import android.app.admin.DevicePolicyManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.provider.Settings;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 9s's "Open security settings": the system's screen-lock picker, or the
 * security settings where a device has no such page. Ours rather than
 * capacitor-native-settings: that plugin's iOS half carries private
 * `App-prefs:` URLs, which App Review refuses.
 */
@CapacitorPlugin(name = "SecuritySettings")
public class SecuritySettingsPlugin extends Plugin {

    @PluginMethod
    public void open(PluginCall call) {
        try {
            getActivity().startActivity(new Intent(DevicePolicyManager.ACTION_SET_NEW_PASSWORD));
        } catch (ActivityNotFoundException noPicker) {
            try {
                getActivity().startActivity(new Intent(Settings.ACTION_SECURITY_SETTINGS));
            } catch (ActivityNotFoundException noSettings) {
                call.reject("No security settings on this device");
                return;
            }
        }
        call.resolve();
    }
}
