package com.spiloveure.capacitor.test;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Run with connectedDebugAndroidTest on a connected Android phone. */
@RunWith(AndroidJUnit4.class)
public class PrototypePackageTest {
    private final Context context =
        InstrumentationRegistry.getInstrumentation().getTargetContext();

    @Test
    public void separateTestIdentityIsInstalled() {
        assertEquals("com.spiloveure.capacitor.test", context.getPackageName());
        assertEquals("SPILOVEURE Test Capacitor",
            context.getApplicationInfo().loadLabel(context.getPackageManager()).toString());
    }

    @Test
    public void frontendIsBundledAndNotARemoteSite() throws Exception {
        try (InputStream stream = context.getAssets().open("capacitor.config.json")) {
            JSONObject config = new JSONObject(new String(stream.readAllBytes(), StandardCharsets.UTF_8));
            assertFalse(config.getJSONObject("server").has("url"));
            assertEquals("spiloveure.org", config.getJSONObject("server").getString("hostname"));
        }
        try (InputStream stream = context.getAssets().open("public/index.html")) {
            String html = new String(stream.readAllBytes(), StandardCharsets.UTF_8);
            assertTrue(html.contains("capacitor-test.js"));
            assertTrue(html.contains("_expo/static"));
        }
    }
}
