package dev.voidrun.recorder;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;

/**
 * The stored form of a {@link Recording}: a gzipped binary encoding of every
 * field, keyframes and deltas included, so that what the worker recorded is
 * exactly what the API replays.
 *
 * <p>Keys repeat on almost every step ({@code f0.v.i}, {@code line}), which
 * gzip removes, so a recording costs a few bytes per changed variable per
 * step. The format is versioned; {@link #decode} rejects anything it does not
 * recognise instead of guessing.
 */
public final class RecordingCodec {

    private static final int MAGIC = 0x56524543; // "VREC"
    private static final int VERSION = 1;
    /** Far above anything the recorder produces; a larger count means corrupt input. */
    private static final int MAX_COUNT = 10_000_000;

    private RecordingCodec() {}

    public static byte[] encode(Recording r) {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (DataOutputStream out = new DataOutputStream(new GZIPOutputStream(bytes))) {
            out.writeInt(MAGIC);
            out.writeInt(VERSION);
            out.writeInt(r.keyframeInterval());
            writeString(out, r.termination().kind().name());
            out.writeInt(r.termination().code());
            writeString(out, r.termination().detail());
            writeString(out, r.compileOutput());
            byte[] stdout = r.stdout();
            out.writeInt(stdout.length);
            out.write(stdout);
            out.writeInt(r.keyframes().size());
            for (Map<String, String> k : r.keyframes()) {
                writeEntries(out, k);
            }
            out.writeInt(r.deltas().size());
            for (Delta d : r.deltas()) {
                writeEntries(out, d.set());
                out.writeInt(d.removed().size());
                for (String key : d.removed()) {
                    writeString(out, key);
                }
            }
        } catch (IOException e) {
            throw new UncheckedIOException("encoding a recording in memory cannot fail", e);
        }
        return bytes.toByteArray();
    }

    public static Recording decode(byte[] data) {
        try (DataInputStream in = new DataInputStream(new GZIPInputStream(new ByteArrayInputStream(data)))) {
            if (in.readInt() != MAGIC) {
                throw new IllegalArgumentException("not a VoidRun recording");
            }
            int version = in.readInt();
            if (version != VERSION) {
                throw new IllegalArgumentException("unsupported recording version " + version);
            }
            int interval = in.readInt();
            Termination.Kind kind = Termination.Kind.valueOf(readString(in));
            Termination termination = new Termination(kind, in.readInt(), readString(in));
            String compileOutput = readString(in);
            byte[] stdout = in.readNBytes(count(in));
            List<Map<String, String>> keyframes = new ArrayList<>();
            for (int i = count(in); i > 0; i--) {
                keyframes.add(readEntries(in, new HashMap<>()));
            }
            List<Delta> deltas = new ArrayList<>();
            for (int i = count(in); i > 0; i--) {
                TreeMap<String, String> set = readEntries(in, new TreeMap<>());
                TreeSet<String> removed = new TreeSet<>();
                for (int j = count(in); j > 0; j--) {
                    removed.add(readString(in));
                }
                deltas.add(new Delta(set, removed));
            }
            return new Recording(interval, keyframes, deltas, stdout, compileOutput, termination);
        } catch (EOFException e) {
            throw new IllegalArgumentException("truncated recording", e);
        } catch (IOException e) {
            throw new IllegalArgumentException("unreadable recording: " + e.getMessage(), e);
        }
    }

    private static void writeEntries(DataOutputStream out, Map<String, String> entries) throws IOException {
        out.writeInt(entries.size());
        for (Map.Entry<String, String> e : entries.entrySet()) {
            writeString(out, e.getKey());
            writeString(out, e.getValue());
        }
    }

    private static <M extends Map<String, String>> M readEntries(DataInputStream in, M into) throws IOException {
        for (int i = count(in); i > 0; i--) {
            into.put(readString(in), readString(in));
        }
        return into;
    }

    // DataOutputStream.writeUTF caps strings at 64 KB; compiler output can be longer.
    private static void writeString(DataOutputStream out, String s) throws IOException {
        byte[] b = s.getBytes(StandardCharsets.UTF_8);
        out.writeInt(b.length);
        out.write(b);
    }

    private static String readString(DataInputStream in) throws IOException {
        return new String(in.readNBytes(count(in)), StandardCharsets.UTF_8);
    }

    private static int count(DataInputStream in) throws IOException {
        int n = in.readInt();
        if (n < 0 || n > MAX_COUNT) {
            throw new IOException("bad length " + n);
        }
        return n;
    }
}
