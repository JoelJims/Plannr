package com.plannr.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;

/**
 * "Send to WhatsApp" (docs/share-and-reminder-pdf-plan.md, section 7). Opens WhatsApp (then
 * WhatsApp Business) with the PDF attached, through the FileProvider the manifest registers
 * (${applicationId}.fileprovider, cache folder in res/xml/file_paths.xml). It never sends: WhatsApp
 * opens on its own contact picker and the user taps Send. When neither app is installed it answers
 * { opened: false, reason: "not-installed" } so the page falls back to the share sheet.
 */
@CapacitorPlugin(name = "ShareTo")
public class ShareToPlugin extends Plugin {

    static final String[] WHATSAPP_PACKAGES = { "com.whatsapp", "com.whatsapp.w4b" };

    @PluginMethod
    public void whatsapp(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("No PDF file was given.");
            return;
        }
        Uri uri;
        try {
            Uri given = Uri.parse(path);
            File file = new File("file".equals(given.getScheme()) ? given.getPath() : path);
            uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
        } catch (IllegalArgumentException e) {
            call.reject("The PDF is not in a folder Plannr can share: " + e.getMessage());
            return;
        }
        PackageManager pm = getContext().getPackageManager();
        for (String pkg : WHATSAPP_PACKAGES) {
            Intent intent = new Intent(Intent.ACTION_SEND);
            intent.setType("application/pdf");
            intent.putExtra(Intent.EXTRA_STREAM, uri);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.setPackage(pkg);
            if (intent.resolveActivity(pm) == null) continue;
            try {
                getActivity().startActivity(intent);
                JSObject ret = new JSObject();
                ret.put("opened", true);
                ret.put("app", pkg);
                call.resolve(ret);
                return;
            } catch (ActivityNotFoundException e) {
                // try the next package
            }
        }
        JSObject ret = new JSObject();
        ret.put("opened", false);
        ret.put("reason", "not-installed");
        call.resolve(ret);
    }
}
