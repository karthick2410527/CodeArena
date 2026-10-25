package dev.voidrun.api.replay;

import dev.voidrun.recorder.Delta;
import dev.voidrun.recorder.Recording;
import dev.voidrun.recorder.RecordingCodec;
import dev.voidrun.recorder.ReplayCursor;
import dev.voidrun.recorder.StepView;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Reads replays back: the row, the decoded recording, and pages of steps
 * rebuilt from keyframes and deltas by {@link ReplayCursor}.
 *
 * <p>A finished recording never changes, so decoded recordings are kept in a
 * small LRU cache; stepping through one costs a database read only on the
 * first page.
 */
@Component
public class ReplayStore {

    private static final Logger log = LoggerFactory.getLogger(ReplayStore.class);
    private static final int CACHED_RECORDINGS = 32;

    /** The replay's row, without the recording blob. */
    public record Row(UUID id, String status, String problemSlug, String language, String sourceCode, String stdin,
            String termination, Integer exitCode, String detail, int stepCount, Instant createdAt,
            Instant finishedAt) {
        public boolean finished() {
            return status.equals("FINISHED");
        }
    }

    public record Termination(String kind, Integer exitCode, String detail) {}

    /**
     * @param timeline {@code [line, depth]} for every step, so the client can step over, step out and run to a
     *                 breakpoint without fetching the steps in between
     */
    public record Replay(UUID replayId, String status, String problemSlug, String language, String sourceCode,
            String stdin, int stepCount, Termination termination, String compileOutput, String stdout,
            List<int[]> timeline, Instant createdAt, Instant finishedAt, String message) {}

    /**
     * @param name    path from the frame's variable, e.g. {@code v}, {@code v[2]}, {@code p.x}
     * @param type    declared type, for top-level variables only
     * @param changed whether this step changed it (or brought it into scope)
     */
    public record Variable(String name, String value, String type, boolean changed) {}

    /** {@code index} 0 is main; the last frame is the one executing. */
    public record Frame(int index, String function, int line, List<Variable> variables) {}

    /** @param stdoutLength how much of the replay's stdout (in UTF-16 units) had been written by this step */
    public record Step(int step, int line, int depth, int stdoutLength, List<Frame> frames) {}

    public record StepPage(int from, int total, List<Step> steps) {}

    private final JdbcClient jdbc;
    private final Map<UUID, Recording> cache = Collections.synchronizedMap(
            new LinkedHashMap<>(CACHED_RECORDINGS, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<UUID, Recording> eldest) {
                    return size() > CACHED_RECORDINGS;
                }
            });

    public ReplayStore(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /** The caller's replay; someone else's, or an expired one, is indistinguishable from a missing one. */
    public Optional<Row> row(UUID id, UUID userId) {
        return jdbc.sql("""
                        SELECT r.id, r.status, p.slug AS problem_slug, r.language, r.source_code, r.stdin,
                               r.termination, r.exit_code, r.detail, r.step_count, r.created_at, r.finished_at
                        FROM replays r LEFT JOIN problems p ON p.id = r.problem_id
                        WHERE r.id = ? AND r.user_id = ? AND r.expires_at > now()""")
                .params(id, userId)
                .query((rs, i) -> {
                    Timestamp finished = rs.getTimestamp("finished_at");
                    return new Row(rs.getObject("id", UUID.class), rs.getString("status"),
                            rs.getString("problem_slug"), rs.getString("language"), rs.getString("source_code"),
                            rs.getString("stdin"), rs.getString("termination"), (Integer) rs.getObject("exit_code"),
                            rs.getString("detail"), rs.getInt("step_count"), rs.getTimestamp("created_at").toInstant(),
                            finished == null ? null : finished.toInstant());
                })
                .optional();
    }

    public Replay describe(Row row) {
        if (!row.finished()) {
            return new Replay(row.id(), row.status(), row.problemSlug(), row.language(), row.sourceCode(), row.stdin(),
                    0, null, "", "", List.of(), row.createdAt(), null, null);
        }
        Recording rec = recording(row);
        boolean recorderFailed = "RECORDER_ERROR".equals(row.termination());
        // The recorder's own failure detail can carry tracer logs and host
        // paths; it is for operators (dead_letter_events), not users.
        Termination termination = new Termination(row.termination(), row.exitCode(),
                recorderFailed ? "" : row.detail());
        String message = recorderFailed ? "The recorder could not record this run. Please try again." : null;
        return new Replay(row.id(), row.status(), row.problemSlug(), row.language(), row.sourceCode(), row.stdin(),
                rec == null ? 0 : rec.stepCount(), termination, rec == null ? "" : rec.compileOutput(),
                rec == null ? "" : new String(rec.stdout(), StandardCharsets.UTF_8),
                rec == null ? List.of() : timeline(rec), row.createdAt(), row.finishedAt(), message);
    }

    public StepPage steps(Row row, int from, int count) {
        Recording rec = recording(row);
        int total = rec == null ? 0 : rec.stepCount();
        if (rec == null || from >= total) {
            return new StepPage(from, total, List.of());
        }
        ReplayCursor cursor = new ReplayCursor(rec);
        cursor.seek(from);
        List<Step> steps = new ArrayList<>(Math.min(count, total - from));
        do {
            steps.add(step(rec, cursor.view()));
        } while (steps.size() < count && cursor.forward());
        return new StepPage(from, total, steps);
    }

    @Scheduled(fixedDelayString = "${voidrun.replay.purge-interval-ms:600000}", initialDelay = 60_000)
    public void purgeExpired() {
        int n = jdbc.sql("DELETE FROM replays WHERE expires_at <= now()").update();
        if (n > 0) {
            log.info("deleted {} expired replays", n);
        }
    }

    private Recording recording(Row row) {
        Recording cached = cache.get(row.id());
        if (cached != null) {
            return cached;
        }
        // JdbcClient's single() rejects a NULL value, so filter it out instead.
        byte[] blob = jdbc.sql("SELECT recording FROM replays WHERE id = ? AND recording IS NOT NULL")
                .param(row.id())
                .query((rs, i) -> rs.getBytes("recording"))
                .optional()
                .orElse(null);
        if (blob == null) {
            return null;
        }
        Recording rec = RecordingCodec.decode(blob);
        cache.put(row.id(), rec);
        return rec;
    }

    private static Step step(Recording rec, StepView view) {
        // A key in this step's delta was set by it: a new value, or a
        // variable that has just come into scope. Step 0 sets everything,
        // which would highlight the whole first frame, so it marks nothing.
        Delta delta = rec.deltas().get(view.step());
        Set<String> changed = view.step() == 0 ? Set.of() : delta.set().keySet();
        List<Frame> frames = new ArrayList<>(view.frames().size());
        for (StepView.Frame f : view.frames()) {
            String prefix = "f" + f.index() + ".v.";
            List<Variable> vars = new ArrayList<>(f.variables().size());
            for (Map.Entry<String, String> v : StepView.sortedVariables(f)) {
                String path = v.getKey();
                String type = isTopLevel(path) ? f.types().get(path) : null;
                vars.add(new Variable(path, v.getValue(), type, changed.contains(prefix + path)));
            }
            frames.add(new Frame(f.index(), f.function(), f.line(), vars));
        }
        return new Step(view.step(), view.line(), view.depth(), view.stdout().length(), frames);
    }

    private static boolean isTopLevel(String path) {
        return path.indexOf('.') < 0 && path.indexOf('[') < 0;
    }

    /** Line and depth per step, read straight off the deltas: both are set by any step that changes them. */
    private static List<int[]> timeline(Recording rec) {
        List<int[]> out = new ArrayList<>(rec.stepCount());
        int line = 0;
        int depth = 0;
        for (Delta d : rec.deltas()) {
            line = parse(d.set().get("line"), line);
            depth = parse(d.set().get("depth"), depth);
            out.add(new int[] {line, depth});
        }
        return out;
    }

    private static int parse(String s, int fallback) {
        if (s == null) {
            return fallback;
        }
        try {
            return Integer.parseInt(s.trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }
}
