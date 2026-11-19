package com.plannr.app;

import android.os.StatFs;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import org.json.JSONException;

/**
 * Plannr's own storage helper (step 1.4 C2; docs/step-1.4-storage-plan.md §1.2, decision D4).
 *
 * It does the few things the SQLite and Filesystem plugins cannot:
 *   - info():      the phone's free space, and the app's own folders;
 *   - sizes():     the real size of files on disk (-1 for a file that does not exist);
 *   - readFile():  read a whole file (the temporary VACUUM INTO copy) as base64;
 *   - writeFile(): write bytes to a file and force them to disk (fsync) before answering;
 *   - rename():    rename a file over another in one atomic step, then force the folder to disk;
 *   - remove():    delete one file (the candidate copy of a move, the temporary VACUUM INTO file).
 *
 * Every path must be inside the app's own data folder (/data/user/0/com.plannr.app); anything else,
 * including a path that only gets there through "..", is refused. No new dependency.
 */
@CapacitorPlugin(name = "PlannrStorage")
public class PlannrStoragePlugin extends Plugin {

    // A database larger than this is not read through the bridge in one piece (it travels as base64).
    private static final long MAX_READ_BYTES = 64L * 1024 * 1024;

    private File root() throws IOException {
        return getContext().getDataDir().getCanonicalFile();
    }

    /** The file a path names, only if it is inside the app's data folder (after resolving ".." and links). */
    private File check(String p) throws IOException {
        if (p == null || p.isEmpty()) throw new IOException("a path is missing");
        if (p.startsWith("file://")) p = p.substring("file://".length());
        if (!p.startsWith("/")) throw new IOException("a path must be absolute: " + p);
        File f = new File(p).getCanonicalFile();
        if (!f.getPath().startsWith(root().getPath() + File.separator)) throw new IOException("a path is outside the app's own folder: " + p);
        return f;
    }

    private File inside(PluginCall call, String key) throws IOException {
        return check(call.getString(key));
    }

    private static void syncFolder(File folder) {
        // Make the new directory entry durable too (rename and create change the folder, not the file).
        FileDescriptor fd = null;
        try {
            fd = Os.open(folder.getPath(), OsConstants.O_RDONLY, 0);
            Os.fsync(fd);
        } catch (ErrnoException e) {
            // Some file systems refuse fsync on a directory; the file itself is already on disk.
        } finally {
            if (fd != null) try { Os.close(fd); } catch (ErrnoException ignored) {}
        }
    }

    @PluginMethod
    public void info(PluginCall call) {
        try {
            File data = root();
            StatFs st = new StatFs(data.getPath());
            JSObject r = new JSObject();
            r.put("freeBytes", st.getAvailableBytes());
            r.put("totalBytes", st.getTotalBytes());
            r.put("dataDir", data.getPath());
            r.put("databasesDir", getContext().getDatabasePath("plannr").getParentFile().getCanonicalPath());
            r.put("filesDir", getContext().getFilesDir().getCanonicalPath());
            r.put("cacheDir", getContext().getCacheDir().getCanonicalPath());
            call.resolve(r);
        } catch (IOException e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void sizes(PluginCall call) {
        JSArray paths = call.getArray("paths");
        if (paths == null) { call.reject("paths is missing"); return; }
        try {
            JSObject out = new JSObject();
            for (int i = 0; i < paths.length(); i++) {
                String p = paths.getString(i);
                File f = check(p);
                out.put(p, f.isFile() ? f.length() : -1);
            }
            call.resolve(out);
        } catch (IOException | JSONException e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void writeFile(PluginCall call) {
        String data = call.getString("data");
        if (data == null) { call.reject("data is missing"); return; }
        File f;
        try {
            f = inside(call, "path");
        } catch (IOException e) {
            call.reject(e.getMessage());
            return;
        }
        byte[] bytes;
        try {
            bytes = Base64.decode(data, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("data is not base64");
            return;
        }
        try (FileOutputStream out = new FileOutputStream(f, false)) {
            out.write(bytes);
            out.flush();
            out.getFD().sync();
        } catch (IOException e) {
            // A full disk or a write error: leave no partial file behind.
            //noinspection ResultOfMethodCallIgnored
            f.delete();
            call.reject("write failed: " + e.getMessage(), "WRITE_FAILED");
            return;
        }
        syncFolder(f.getParentFile());
        JSObject r = new JSObject();
        r.put("bytes", f.length());
        call.resolve(r);
    }

    @PluginMethod
    public void readFile(PluginCall call) {
        try {
            File f = inside(call, "path");
            if (!f.isFile()) { call.reject("no such file: " + f.getName(), "NOT_FOUND"); return; }
            long n = f.length();
            if (n > MAX_READ_BYTES) { call.reject("the file is too large to read in one call (" + n + " bytes)"); return; }
            byte[] bytes = new byte[(int) n];
            try (FileInputStream in = new FileInputStream(f)) {
                int off = 0;
                while (off < bytes.length) {
                    int r = in.read(bytes, off, bytes.length - off);
                    if (r < 0) break;
                    off += r;
                }
                if (off != bytes.length) { call.reject("the file changed while it was read"); return; }
            }
            JSObject r = new JSObject();
            r.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
            r.put("bytes", n);
            call.resolve(r);
        } catch (IOException e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void rename(PluginCall call) {
        try {
            File from = inside(call, "from");
            File to = inside(call, "to");
            if (!from.isFile()) { call.reject("nothing to rename: " + from.getName() + " does not exist"); return; }
            if (!from.getParentFile().equals(to.getParentFile())) { call.reject("rename only within one folder (one atomic step)"); return; }
            if (!from.renameTo(to)) { call.reject("rename failed"); return; }
            syncFolder(to.getParentFile());
            call.resolve();
        } catch (IOException e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        try {
            File f = inside(call, "path");
            if (f.isDirectory()) { call.reject("refusing to remove a folder"); return; }
            boolean existed = f.exists();
            if (existed && !f.delete()) { call.reject("could not remove " + f.getName()); return; }
            if (existed) syncFolder(f.getParentFile());
            JSObject r = new JSObject();
            r.put("existed", existed);
            call.resolve(r);
        } catch (IOException e) {
            call.reject(e.getMessage());
        }
    }
}
