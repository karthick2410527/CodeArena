package dev.voidrun.api.users;

import dev.voidrun.api.contests.ContestHistory;
import dev.voidrun.api.problems.ProblemAccess;
import dev.voidrun.api.problems.ProblemController;
import dev.voidrun.api.web.ApiException;
import java.sql.Date;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Public profiles: what anyone can see about a user, as on Codeforces. Never
 * an email address, and never a problem that is still hidden in a contest
 * (solved problems are filtered by {@link ProblemAccess#PRACTICE}).
 */
@RestController
public class ProfileController {

    static final int ACTIVITY_DAYS = 365;

    public record Solved(long total, long easy, long medium, long hard) {}

    /** @param date a UTC calendar day */
    public record Day(LocalDate date, int submissions, int accepted) {}

    public record RecentSolve(String slug, String title, String difficulty, Instant solvedAt) {}

    public record Profile(String username, String displayName, String avatarUrl, String role, Instant joinedAt,
            Solved solved, long submissions, long accepted, double acceptanceRate, int currentStreak,
            int longestStreak, List<Day> activity, List<RecentSolve> recent, List<ContestHistory.Entry> contests,
            long problemsAuthored, long contestsHosted) {}

    private final JdbcClient jdbc;
    private final ContestHistory history;

    public ProfileController(JdbcClient jdbc, ContestHistory history) {
        this.jdbc = jdbc;
        this.history = history;
    }

    public record Person(String username, String displayName, String avatarUrl, long solved, long contests,
            Instant joinedAt) {}

    /**
     * People search: usernames and display names containing {@code q},
     * exact and prefix matches first. Public, like profiles.
     */
    @GetMapping("/api/v1/profiles")
    List<Person> search(@RequestParam(defaultValue = "") String q,
            @RequestParam(defaultValue = "10") int limit) {
        String term = q.trim().toLowerCase(java.util.Locale.ROOT);
        if (term.isEmpty()) {
            return List.of();
        }
        if (term.length() > 40) {
            throw ApiException.badRequest("search for at most 40 characters");
        }
        String like = "%" + ProblemController.likeEscape(term) + "%";
        return jdbc.sql("""
                        SELECT u.username, u.display_name, u.avatar_url, u.created_at,
                          (SELECT count(*) FROM problems p WHERE\s""" + ProblemAccess.PRACTICE + """
                             AND EXISTS (SELECT 1 FROM submissions s WHERE s.problem_id = p.id
                                         AND s.user_id = u.id AND s.verdict = 'ACCEPTED')) AS solved,
                          (SELECT count(*) FROM contest_registrations r WHERE r.user_id = u.id) AS contests
                        FROM users u
                        WHERE lower(u.username) LIKE ? OR lower(coalesce(u.display_name, '')) LIKE ?
                        ORDER BY (lower(u.username) = ?) DESC, (lower(u.username) LIKE ?) DESC, u.username
                        LIMIT ?""")
                .params(like, like, term, ProblemController.likeEscape(term) + "%", Math.max(1, Math.min(limit, 25)))
                .query((rs, i) -> new Person(rs.getString("username"), rs.getString("display_name"),
                        rs.getString("avatar_url"), rs.getLong("solved"), rs.getLong("contests"),
                        rs.getTimestamp("created_at").toInstant()))
                .list();
    }

    @GetMapping("/api/v1/profiles/{username}")
    Profile profile(@PathVariable String username) {
        record U(UUID id, String username, String displayName, String avatarUrl, String role, Instant joined) {}
        U u = jdbc.sql("SELECT id, username, display_name, avatar_url, role, created_at FROM users"
                        + " WHERE lower(username) = lower(?)")
                .param(username)
                .query((rs, i) -> new U(rs.getObject("id", UUID.class), rs.getString("username"),
                        rs.getString("display_name"), rs.getString("avatar_url"), rs.getString("role"),
                        rs.getTimestamp("created_at").toInstant()))
                .optional()
                .orElseThrow(() -> ApiException.notFound("no user called " + username));

        Solved solved = jdbc.sql("SELECT count(*), count(*) FILTER (WHERE p.difficulty = 'EASY'),"
                        + " count(*) FILTER (WHERE p.difficulty = 'MEDIUM'), count(*) FILTER (WHERE p.difficulty = 'HARD')"
                        + " FROM problems p WHERE " + ProblemAccess.PRACTICE
                        + " AND EXISTS (SELECT 1 FROM submissions s WHERE s.problem_id = p.id AND s.user_id = ?"
                        + " AND s.verdict = 'ACCEPTED')")
                .param(u.id())
                .query((rs, i) -> new Solved(rs.getLong(1), rs.getLong(2), rs.getLong(3), rs.getLong(4)))
                .single();
        long[] counts = jdbc.sql("SELECT count(*), count(*) FILTER (WHERE verdict = 'ACCEPTED') FROM submissions"
                        + " WHERE user_id = ?")
                .param(u.id())
                .query((rs, i) -> new long[] {rs.getLong(1), rs.getLong(2)})
                .single();

        LocalDate today = LocalDate.now(ZoneOffset.UTC);
        LocalDate first = today.minusDays(ACTIVITY_DAYS - 1);
        List<Day> activity = jdbc.sql("""
                        SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS n,
                               count(*) FILTER (WHERE verdict = 'ACCEPTED') AS ok
                        FROM submissions WHERE user_id = ? AND created_at >= ?::date
                        GROUP BY 1 ORDER BY 1""")
                .params(u.id(), Date.valueOf(first))
                .query((rs, i) -> new Day(rs.getDate("day").toLocalDate(), rs.getInt("n"), rs.getInt("ok")))
                .list();
        int[] streaks = streaks(activity, today);

        List<RecentSolve> recent = jdbc.sql("SELECT p.slug, p.title, p.difficulty, min(s.created_at) AS solved_at"
                        + " FROM submissions s JOIN problems p ON p.id = s.problem_id"
                        + " WHERE s.user_id = ? AND s.verdict = 'ACCEPTED' AND " + ProblemAccess.PRACTICE
                        + " GROUP BY p.slug, p.title, p.difficulty ORDER BY solved_at DESC LIMIT 10")
                .param(u.id())
                .query((rs, i) -> new RecentSolve(rs.getString("slug"), rs.getString("title"),
                        rs.getString("difficulty"), rs.getTimestamp("solved_at").toInstant()))
                .list();
        long authored = jdbc.sql("SELECT count(*) FROM problems p WHERE p.owner_id = ? AND " + ProblemAccess.PRACTICE)
                .param(u.id()).query(Long.class).single();
        long hosted = jdbc.sql("""
                        SELECT count(*) FROM contests c JOIN contest_authors ca ON ca.contest_id = c.id
                        WHERE ca.user_id = ? AND c.published""")
                .param(u.id()).query(Long.class).single();

        return new Profile(u.username(), u.displayName(), u.avatarUrl(), u.role(), u.joined(), solved, counts[0],
                counts[1], UserController.acceptanceRate(counts[1], counts[0]), streaks[0], streaks[1], activity,
                recent, history.of(u.id()), authored, hosted);
    }

    /** {current, longest} runs of consecutive days with a submission; the current one may end yesterday. */
    static int[] streaks(List<Day> activity, LocalDate today) {
        int longest = 0;
        int run = 0;
        LocalDate prev = null;
        List<LocalDate> days = new ArrayList<>();
        for (Day d : activity) {
            if (d.submissions() > 0) {
                days.add(d.date());
            }
        }
        for (LocalDate d : days) {
            run = prev != null && prev.plusDays(1).equals(d) ? run + 1 : 1;
            longest = Math.max(longest, run);
            prev = d;
        }
        int current = prev != null && (prev.equals(today) || prev.equals(today.minusDays(1))) ? run : 0;
        return new int[] {current, longest};
    }
}
