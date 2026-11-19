package com.spilivere.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

public final class ApkInstallResultReceiver extends BroadcastReceiver {
    public static final String ACTION_INSTALL_STATUS =
        "com.spilivere.app.action.APK_INSTALL_STATUS";
    private static final String TAG = "SpiloveureApkInstall";

    static boolean requiresUserConfirmation(int status) {
        return status == PackageInstaller.STATUS_PENDING_USER_ACTION;
    }

    static boolean shouldRelaunchApp(int status) {
        return status == PackageInstaller.STATUS_SUCCESS;
    }

    @Override
    public void onReceive(Context context, Intent result) {
        int status = result.getIntExtra(
            PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (requiresUserConfirmation(status)) {
            Intent confirmation;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                confirmation = result.getParcelableExtra(
                    Intent.EXTRA_INTENT, Intent.class);
            } else {
                confirmation = result.getParcelableExtra(Intent.EXTRA_INTENT);
            }
            if (confirmation != null) {
                confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(confirmation);
            } else {
                Log.e(TAG, "Android n’a pas fourni l’écran de confirmation de l’installation.");
            }
            return;
        }

        if (shouldRelaunchApp(status)) {
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                Intent launch = context.getPackageManager()
                    .getLaunchIntentForPackage(context.getPackageName());
                if (launch == null) {
                    Log.e(TAG, "Impossible de rouvrir SPILOVEURE après la mise à jour.");
                    return;
                }
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                try {
                    context.startActivity(launch);
                } catch (Exception exception) {
                    Log.e(TAG, "La mise à jour est installée, mais SPILOVEURE n’a pas pu être relancée.", exception);
                }
            }, 600);
        } else {
            Log.w(TAG, "L’installation Android s’est terminée avec le statut " + status);
        }
    }
}
