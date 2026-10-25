package dev.voidrun.api.problems;

import dev.voidrun.api.problems.ProblemDtos.ProblemDetail;
import dev.voidrun.api.problems.ProblemDtos.ProblemEditorial;
import dev.voidrun.api.problems.ProblemDtos.ProblemSummary;
import dev.voidrun.api.problems.ProblemDtos.Sample;
import dev.voidrun.api.problems.ProblemDtos.TagCount;
import dev.voidrun.api.security.CurrentUser;
import dev.voidrun.api.web.ApiException;
import dev.voidrun.api.web.Page;
import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * The practice problem set ({@link ProblemAccess#PRACTICE}) and its public
 * samples only. A signed-in caller also gets their own status per problem.
 */
@RestController
@RequestMapping("/api/v1")
public class ProblemController {

    static final Set<String> DIFFICULTIES = Set.of("EASY", "MEDIUM", "HARD");

    /** Tag names of problem {@code p}, as a sorted array. */
    static final String TAGS_OF_P = """
            COALESCE((SELECT array_agg(t.name ORDER BY t.name) FROM problem_tags pt
                      JOIN tags t ON t.id = pt.tag_id WHERE pt.problem_id = p.id), '{}') AS tags""";

    private final JdbcClient jdbc;

    public ProblemController(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /** Acceptance figures and, for a signed-in caller, their status on {@code p}. Two parameters: user id twice. */
    private static final String STATS_OF_P = """
            (SELECT count(DISTINCT s.user_id) FROM submissions s
              WHERE s.problem_id = p.id AND s.verdict = 'ACCEPTED') AS solved_by,
            (SELECT count(*) FROM submissions s WHERE s.problem_id = p.id AND s.status = 'FINISHED'
               AND s.verdict NOT IN ('COMPILATION_ERROR', 'INTERNAL_ERROR')) AS judged,
            (SELECT count(*) FROM submissions s WHERE s.problem_id = p.id AND s.verdict = 'ACCEPTED') AS accepted,
            (SELECT u.username FROM users u WHERE u.id = p.owner_id) AS author,
            CASE WHEN EXISTS (SELECT 1 FROM submissions s WHERE s.problem_id = p.id AND s.user_id = ?
                              AND s.verdict = 'ACCEPTED') THEN 'SOLVED'
                 WHEN EXISTS (SELECT 1 FROM submissions s WHERE s.problem_id = p.id AND s.user_id = ?)
                 THEN 'ATTEMPTED' END AS my_status""";

    private static final Map<String, String> SORTS = Map.of(
            "number", "p.number",
            "difficulty", "CASE p.difficulty WHEN 'EASY' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, p.number",
            "solved", "solved_by DESC, p.number",
            "newest", "p.number DESC");

    @GetMapping("/problems")
    Page<ProblemSummary> list(
            @AuthenticationPrincipal Jwt jwt,
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer limit,
            @RequestParam(required = false) String difficulty,
            @RequestParam(required = false) String tag,
            @RequestParam(required = false) String q,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String sort) {
        Page.Request p = Page.Request.of(page, limit);
        UUID me = jwt == null ? null : CurrentUser.id(jwt);
        StringBuilder where = new StringBuilder(" WHERE " + ProblemAccess.PRACTICE);
        List<Object> args = new ArrayList<>();
        if (difficulty != null && !difficulty.isBlank()) {
            String d = difficulty.trim().toUpperCase(Locale.ROOT);
            if (!DIFFICULTIES.contains(d)) {
                throw ApiException.badRequest("difficulty must be EASY, MEDIUM or HARD");
            }
            where.append(" AND p.difficulty = ?");
            args.add(d);
        }
        if (tag != null && !tag.isBlank()) {
            where.append(" AND EXISTS (SELECT 1 FROM problem_tags pt JOIN tags t ON t.id = pt.tag_id"
                    + " WHERE pt.problem_id = p.id AND lower(t.name) = lower(?))");
            args.add(tag.trim());
        }
        if (q != null && !q.isBlank()) {
            where.append(" AND p.title ILIKE ?");
            args.add("%" + likeEscape(q.trim()) + "%");
        }
        if (status != null && !status.isBlank()) {
            if (me == null) {
                throw ApiException.unauthorized("sign in to filter by your own progress");
            }
            String accepted = "EXISTS (SELECT 1 FROM submissions s WHERE s.problem_id = p.id AND s.user_id = ?"
                    + " AND s.verdict = 'ACCEPTED')";
            String tried = "EXISTS (SELECT 1 FROM submissions s WHERE s.problem_id = p.id AND s.user_id = ?)";
            switch (status.trim().toLowerCase(Locale.ROOT)) {
                case "solved" -> {
                    where.append(" AND ").append(accepted);
                    args.add(me);
                }
                case "attempted" -> {
                    where.append(" AND ").append(tried).append(" AND NOT ").append(accepted);
                    args.add(me);
                    args.add(me);
                }
                case "unsolved" -> {
                    where.append(" AND NOT ").append(accepted);
                    args.add(me);
                }
                default -> throw ApiException.badRequest("status must be solved, attempted or unsolved");
            }
        }
        String order = SORTS.get(sort == null || sort.isBlank() ? "number" : sort.trim().toLowerCase(Locale.ROOT));
        if (order == null) {
            throw ApiException.badRequest("sort must be one of " + String.join(", ", SORTS.keySet()));
        }
        long total = jdbc.sql("SELECT count(*) FROM problems p" + where).params(args).query(Long.class).single();
        List<Object> pageArgs = new ArrayList<>();
        pageArgs.add(me);
        pageArgs.add(me);
        pageArgs.addAll(args);
        pageArgs.add(p.limit());
        pageArgs.add(p.offset());
        List<ProblemSummary> items = jdbc.sql("SELECT * FROM (SELECT p.number, p.slug, p.title, p.difficulty,"
                        + " p.time_limit_ms, p.memory_limit_mb, " + TAGS_OF_P + ", " + STATS_OF_P
                        + " FROM problems p" + where + ") p ORDER BY " + order + " LIMIT ? OFFSET ?")
                .params(pageArgs)
                .query((rs, i) -> summary(rs))
                .list();
        return p.wrap(items, total);
    }

    @GetMapping("/problems/{slug}")
    ProblemDetail get(@AuthenticationPrincipal Jwt jwt, @PathVariable String slug) {
        UUID me = jwt == null ? null : CurrentUser.id(jwt);
        UUID id = jdbc.sql("SELECT p.id FROM problems p WHERE p.slug = ? AND " + ProblemAccess.PRACTICE)
                .param(slug)
                .query(UUID.class)
                .optional()
                .orElseThrow(() -> ApiException.notFound("problem not found"));
        return detail(id, me);
    }

    /** A problem's statement, samples and figures, whatever made it visible (practice or a contest). */
    public ProblemDetail detail(UUID id, UUID me) {
        ProblemDetail d = jdbc.sql("SELECT p.*, " + TAGS_OF_P + ", " + STATS_OF_P + " FROM problems p WHERE p.id = ?")
                .params(me, me, id)
                .query((rs, i) -> {
                    ProblemSummary s = summary(rs);
                    return new ProblemDetail(s.number(), s.slug(), s.title(), s.difficulty(), s.timeLimitMs(),
                            s.memoryLimitMb(), s.tags(), rs.getString("description"), rs.getString("constraints"),
                            List.of(), s.solvedBy(), s.acceptanceRate(), s.status(), s.author(), null,
                            rs.getString("source_url"));
                })
                .single();
        return new ProblemDetail(d.number(), d.slug(), d.title(), d.difficulty(), d.timeLimitMs(), d.memoryLimitMb(),
                d.tags(), d.description(), d.constraints(), samples(id), d.solvedBy(), d.acceptanceRate(), d.status(),
                d.author(), editorial(id), d.sourceUrl());
    }

    /**
     * The write-up from the latest finished contest that used this problem, if
     * its authors wrote one. Only ended contests count, so a running contest's
     * arena (which shows this same detail) can never reveal it.
     */
    private ProblemEditorial editorial(UUID problemId) {
        return jdbc.sql("""
                        SELECT c.slug, c.title, cp.label, cp.editorial FROM contest_problems cp
                        JOIN contests c ON c.id = cp.contest_id
                        WHERE cp.problem_id = ? AND c.published AND c.ends_at <= now() AND cp.editorial <> ''
                        ORDER BY c.ends_at DESC LIMIT 1""")
                .param(problemId)
                .query((rs, i) -> new ProblemEditorial(rs.getString("slug"), rs.getString("title"),
                        rs.getString("label"), rs.getString("editorial")))
                .optional()
                .orElse(null);
    }

    @GetMapping("/problems/{slug}/samples")
    List<Sample> samples(@PathVariable String slug) {
        UUID id = jdbc.sql("SELECT p.id FROM problems p WHERE p.slug = ? AND " + ProblemAccess.PRACTICE)
                .param(slug)
                .query(UUID.class)
                .optional()
                .orElseThrow(() -> ApiException.notFound("problem not found"));
        return samples(id);
    }

    private static ProblemSummary summary(ResultSet rs) throws SQLException {
        long judged = rs.getLong("judged");
        return new ProblemSummary(rs.getLong("number"), rs.getString("slug"), rs.getString("title"),
                rs.getString("difficulty"), rs.getInt("time_limit_ms"), rs.getInt("memory_limit_mb"),
                strings(rs, "tags"), rs.getLong("solved_by"),
                judged == 0 ? null : Math.round(rs.getLong("accepted") * 1000.0 / judged) / 10.0,
                rs.getString("my_status"), rs.getString("author"));
    }

    @GetMapping("/tags")
    List<TagCount> tags() {
        return jdbc.sql("""
                        SELECT t.name, count(p.id) AS count FROM tags t
                        JOIN problem_tags pt ON pt.tag_id = t.id
                        JOIN problems p ON p.id = pt.problem_id AND\s""" + ProblemAccess.PRACTICE + """
                        GROUP BY t.name ORDER BY t.name""")
                .query((rs, i) -> new TagCount(rs.getString("name"), rs.getLong("count")))
                .list();
    }

    private List<Sample> samples(UUID problemId) {
        return jdbc.sql("""
                        SELECT input, expected_output, explanation FROM test_cases
                        WHERE problem_id = ? AND is_sample ORDER BY position""")
                .param(problemId)
                .query((rs, i) -> new Sample(rs.getString("input"), rs.getString("expected_output"),
                        rs.getString("explanation")))
                .list();
    }

    static List<String> strings(ResultSet rs, String column) throws SQLException {
        Array a = rs.getArray(column);
        return a == null ? List.of() : List.of((String[]) a.getArray());
    }

    public static String likeEscape(String s) {
        return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
    }
}
