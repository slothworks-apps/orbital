package io.slothworks.orbital.mobile;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The refused notifications tip's "Open phone settings" (spec
 * 2026-10-08-notifications-off-by-default-design § 5, canvas 2d): this app's
 * own notification settings, or its app info page where a device has none.
 */
@CapacitorPlugin(name = "NotificationSettings")
public class NotificationSettingsPlugin extends Plugin {

    @PluginMethod
    public void open(PluginCall call) {
        String pkg = getContext().getPackageName();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getActivity().startActivity(
                    new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, pkg)
                );
            } else {
                openAppDetails(pkg);
            }
        } catch (ActivityNotFoundException noNotificationPage) {
            try {
                openAppDetails(pkg);
            } catch (ActivityNotFoundException noAppPage) {
                call.reject("No notification settings on this device");
                return;
            }
        }
        call.resolve();
    }

    private void openAppDetails(String pkg) {
        getActivity().startActivity(
            new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", pkg, null))
        );
    }
}
