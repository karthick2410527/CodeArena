package dev.voidrun.api.users;

import dev.voidrun.api.auth.AuthDtos.UserDto;
import dev.voidrun.api.auth.UserRepository;
import dev.voidrun.api.problems.ProblemAccess;
import dev.voidrun.api.security.CurrentUser;
import dev.voidrun.api.web.ApiException;
import java.time.Instant;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import dev.voidrun.api.auth.AccountRules;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/users/me")
public class UserController {

    public record UserStats(
            long totalSubmissions, long acceptedSubmissions, long problemsSolved, long problemsAvailable,
            long solvedEasy, long solvedMedium, long solvedHard, long availableEasy, long availableMedium,
            long availableHard, double acceptanceRate, Instant lastSubmissionAt, Map<String, Long> verdictCounts) {}

    private final JdbcClient jdbc;
    private final UserRepository users;

    public UserController(JdbcClient jdbc, UserRepository users) {
        this.jdbc = jdbc;
        this.users = users;
    }

    @GetMapping
    UserDto me(@AuthenticationPrincipal Jwt jwt) {
        return users.findById(CurrentUser.id(jwt))
                .map(UserDto::of)
                .orElseThrow(() -> ApiException.unauthorized("account no longer exists"));
    }

    /** A blank name clears it, so the username is shown instead. */
    public record ProfileInput(String displayName) {}

    @PatchMapping
    UserDto update(@AuthenticationPrincipal Jwt jwt, @RequestBody ProfileInput in) {
        if (in == null) {
            throw ApiException.badRequest("display_name is required");
        }
        jdbc.sql("UPDATE users SET display_name = ? WHERE id = ?")
                .params(AccountRules.displayName(in.displayName()), CurrentUser.id(jwt))
                .update();
        return me(jwt);
    }

    @GetMapping("/stats")
    UserStats stats(@AuthenticationPrincipal Jwt jwt) {
        UUID id = CurrentUser.id(jwt);
        record Mine(long total, long accepted, Instant last, long solved, long easy, long medium, long hard) {}
        // Solved counts use the practice set, like the totals they are shown against: a problem still
        // hidden in a running contest counts once the contest is over.
        Mine mine = jdbc.sql("""
                        SELECT
                          (SELECT count(*) FROM submissions WHERE user_id = :id) AS total,
                          (SELECT count(*) FROM submissions WHERE user_id = :id AND verdict = 'ACCEPTED') AS accepted,
                          (SELECT max(created_at) FROM submissions WHERE user_id = :id) AS last,
                          count(*) AS solved,
                          count(*) FILTER (WHERE p.difficulty = 'EASY') AS easy,
                          count(*) FILTER (WHERE p.difficulty = 'MEDIUM') AS medium,
                          count(*) FILTER (WHERE p.difficulty = 'HARD') AS hard
                        FROM problems p
                        WHERE""" + " " + ProblemAccess.PRACTICE + """
                          AND EXISTS (SELECT 1 FROM submissions s
                              WHERE s.user_id = :id AND s.problem_id = p.id AND s.verdict = 'ACCEPTED')""")
                .param("id", id)
                .query((rs, i) -> new Mine(rs.getLong("total"), rs.getLong("accepted"),
                        rs.getTimestamp("last") == null ? null : rs.getTimestamp("last").toInstant(),
                        rs.getLong("solved"), rs.getLong("easy"), rs.getLong("medium"), rs.getLong("hard")))
                .single();
        long[] available = jdbc.sql("""
                        SELECT count(*), count(*) FILTER (WHERE difficulty = 'EASY'),
                               count(*) FILTER (WHERE difficulty = 'MEDIUM'), count(*) FILTER (WHERE difficulty = 'HARD')
                        FROM problems p WHERE\s""" + ProblemAccess.PRACTICE)
                .query((rs, i) -> new long[] {rs.getLong(1), rs.getLong(2), rs.getLong(3), rs.getLong(4)})
                .single();
        Map<String, Long> verdicts = new TreeMap<>();
        jdbc.sql("SELECT verdict, count(*) FROM submissions WHERE user_id = ? AND verdict IS NOT NULL GROUP BY verdict")
                .param(id)
                .query(rs -> {
                    verdicts.put(rs.getString(1), rs.getLong(2));
                });
        return new UserStats(mine.total(), mine.accepted(), mine.solved(), available[0], mine.easy(), mine.medium(),
                mine.hard(), available[1], available[2], available[3], acceptanceRate(mine.accepted(), mine.total()),
                mine.last(), verdicts);
    }

    /** Accepted ÷ total as a percentage rounded to one decimal; 0 with no submissions. */
    static double acceptanceRate(long accepted, long total) {
        return total <= 0 ? 0.0 : Math.round(accepted * 1000.0 / total) / 10.0;
    }
}
