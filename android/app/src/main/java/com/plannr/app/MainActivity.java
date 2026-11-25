package com.plannr.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plannr's own storage helper (step 1.4 C2). A plugin inside the app must be registered
        // before the bridge starts.
        registerPlugin(PlannrStoragePlugin.class);
        // "Send to WhatsApp": hands the PDF to WhatsApp; the user taps Send there.
        registerPlugin(ShareToPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
