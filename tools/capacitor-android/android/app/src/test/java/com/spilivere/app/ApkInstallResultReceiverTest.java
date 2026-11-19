package com.spilivere.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.pm.PackageInstaller;
import org.junit.Test;

public class ApkInstallResultReceiverTest {
    @Test
    public void asksAndroidForConfirmationBeforeInstall() {
        assertTrue(ApkInstallResultReceiver.requiresUserConfirmation(
            PackageInstaller.STATUS_PENDING_USER_ACTION));
        assertFalse(ApkInstallResultReceiver.requiresUserConfirmation(
            PackageInstaller.STATUS_SUCCESS));
    }

    @Test
    public void relaunchesOnlyAfterAndroidReportsSuccessfulInstall() {
        assertTrue(ApkInstallResultReceiver.shouldRelaunchApp(
            PackageInstaller.STATUS_SUCCESS));
        assertFalse(ApkInstallResultReceiver.shouldRelaunchApp(
            PackageInstaller.STATUS_FAILURE_ABORTED));
    }
}
