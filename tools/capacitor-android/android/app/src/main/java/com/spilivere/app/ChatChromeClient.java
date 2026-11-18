package com.spilivere.app;

import android.webkit.PermissionRequest;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;

/** Only the bundled Chat can ask for the microphone; no camera permission. */
public class ChatChromeClient extends BridgeWebChromeClient {
    public ChatChromeClient(Bridge bridge) { super(bridge); }

    @Override
    public void onPermissionRequest(PermissionRequest request) {
        if (!"https://spiloveure.org".equals(request.getOrigin().toString().replaceAll("/$", ""))) {
            request.deny();
            return;
        }
        for (String resource : request.getResources()) {
            if (!PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                request.deny();
                return;
            }
        }
        super.onPermissionRequest(request);
    }
}
