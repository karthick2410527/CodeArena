package dev.voidrun.api.problems;

import dev.voidrun.api.problems.ProblemDtos.AdminProblem;
import dev.voidrun.api.problems.ProblemDtos.AdminTestCase;
import dev.voidrun.api.problems.ProblemDtos.ProblemInput;
import dev.voidrun.api.problems.ProblemDtos.TestCaseInput;
import dev.voidrun.api.security.CurrentUser;
import dev.voidrun.api.web.ApiException;
import dev.voidrun.api.web.Page;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * Problem and test management, at two addresses with one set of rules:
 * {@code /api/v1/admin} (ADMIN only, enforced in {@code SecurityConfig}) and
 * {@code /api/v1/studio}, where any signed-in user writes problems of their
 * own. An admin can see and edit every problem; anyone else only the problems
 * they own or co-author through a contest ({@link ProblemAccess#AUTHOR}). A
 * problem outside the caller's reach is "not found", like a missing one.
 */
@RestController
@RequestMapping({"/api/v1/admin", "/api/v1/studio"})
public class AdminProblemController {

    private static final Pattern SLUG = Pattern.compile("[a-z0-9]+(-[a-z0-9]+)*");
    static final int MAX_TIME_LIMIT_MS = 10_000;
    static final int MAX_MEMORY_LIMIT_MB = 512;

    private static final String ADMIN_COLUMNS = """
            p.id, p.number, p.slug, p.title, p.description, p.constraints, p.difficulty, p.time_limit_ms,
            p.memory_limit_mb, p.published, p.created_at, p.updated_at, p.source_url,
            (SELECT count(*) FROM test_cases tc WHERE tc.problem_id = p.id AND tc.is_sample) AS sample_count,
            (SELECT count(*) FROM test_cases tc WHERE tc.problem_id = p.id AND NOT tc.is_sample) AS hidden_count,
            (SELECT count(*) FROM submissions s WHERE s.problem_id = p.id) AS submission_count,
            (SELECT u.username FROM users u WHERE u.id = p.owner_id) AS owner,
            COALESCE((SELECT array_agg(c.slug ORDER BY c.starts_at) FROM contest_problems cp
                      JOIN contests c ON c.id = cp.contest_id WHERE cp.problem_id = p.id), '{}') AS contests,
            """ + ProblemController.TAGS_OF_P;

    private final JdbcClient jdbc;

    public AdminProblemController(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @GetMapping("/problems")
    Page<AdminProblem> list(
            @AuthenticationPrincipal Jwt jwt,
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer limit,
            @RequestParam(required = false) Boolean published,
            @RequestParam(required = false) String q) {
        Page.Request p = Page.Request.of(page, limit);
        StringBuilder where = new StringBuilder(" WHERE TRUE");
        List<Object> args = new ArrayList<>();
        if (!CurrentUser.isAdmin(jwt)) {
            where.append(" AND ").append(ProblemAccess.AUTHOR);
            args.add(CurrentUser.id(jwt));
            args.add(CurrentUser.id(jwt));
        }
        if (published != null) {
            where.append(" AND p.published = ?");
            args.add(published);
        }
        if (q != null && !q.isBlank()) {
            where.append(" AND (p.title ILIKE ? OR p.slug ILIKE ?)");
            String like = "%" + ProblemController.likeEscape(q.trim()) + "%";
            args.add(like);
            args.add(like);
        }
        long total = jdbc.sql("SELECT count(*) FROM problems p" + where).params(args).query(Long.class).single();
        List<Object> pageArgs = new ArrayList<>(args);
        pageArgs.add(p.limit());
        pageArgs.add(p.offset());
        List<AdminProblem> items = jdbc.sql("SELECT " + ADMIN_COLUMNS + " FROM problems p" + where
                        + " ORDER BY p.number DESC LIMIT ? OFFSET ?")
                .params(pageArgs)
                .query((rs, i) -> mapAdmin(rs))
                .list();
        return p.wrap(items, total);
    }

    @GetMapping("/problems/{id}")
    AdminProblem get(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        return find(id, jwt);
    }

    @PostMapping("/problems")
    @ResponseStatus(HttpStatus.CREATED)
    @Transactional
    AdminProblem create(@AuthenticationPrincipal Jwt jwt, @RequestBody ProblemInput in) {
        if (in.slug() == null || in.title() == null || in.description() == null || in.difficulty() == null
                || in.timeLimitMs() == null || in.memoryLimitMb() == null) {
            throw ApiException.badRequest(
                    "slug, title, description, difficulty, time_limit_ms and memory_limit_mb are required");
        }
        ProblemInput v = validated(in);
        practiceOnlyThroughContests(jwt, v);
        UUID id;
        try {
            id = jdbc.sql("""
                            INSERT INTO problems (slug, title, description, constraints, difficulty, time_limit_ms,
                                                  memory_limit_mb, published, updated_by, owner_id, source_url)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id""")
                    .params(v.slug(), v.title(), v.description(), v.constraints() == null ? "" : v.constraints(),
                            v.difficulty(), v.timeLimitMs(), v.memoryLimitMb(), Boolean.TRUE.equals(v.published()),
                            CurrentUser.id(jwt), CurrentUser.id(jwt), blankToNull(v.sourceUrl()))
                    .query(UUID.class)
                    .single();
        } catch (DuplicateKeyException e) {
            throw ApiException.conflict("a problem with this slug already exists");
        }
        if (v.tags() != null) {
            setTags(id, v.tags());
        }
        return find(id, jwt);
    }

    @PatchMapping("/problems/{id}")
    @Transactional
    AdminProblem update(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id, @RequestBody ProblemInput in) {
        find(id, jwt);
        ProblemInput v = validated(in);
        practiceOnlyThroughContests(jwt, v);
        try {
            jdbc.sql("""
                            UPDATE problems SET
                              slug = COALESCE(?, slug), title = COALESCE(?, title),
                              description = COALESCE(?, description), constraints = COALESCE(?, constraints),
                              difficulty = COALESCE(?, difficulty), time_limit_ms = COALESCE(?, time_limit_ms),
                              memory_limit_mb = COALESCE(?, memory_limit_mb), published = COALESCE(?, published),
                              source_url = CASE WHEN ? THEN ? ELSE source_url END,
                              updated_by = ?
                            WHERE id = ?""")
                    .params(v.slug(), v.title(), v.description(), v.constraints(), v.difficulty(), v.timeLimitMs(),
                            v.memoryLimitMb(), v.published(), v.sourceUrl() != null, blankToNull(v.sourceUrl()),
                            CurrentUser.id(jwt), id)
                    .update();
        } catch (DuplicateKeyException e) {
            throw ApiException.conflict("a problem with this slug already exists");
        }
        if (v.tags() != null) {
            setTags(id, v.tags());
        }
        return find(id, jwt);
    }

    /**
     * Community problems join the problemset by appearing in a contest: once that contest ends they are
     * practice problems ({@link ProblemAccess}). Only admins publish a problem straight to practice.
     */
    private static void practiceOnlyThroughContests(Jwt jwt, ProblemInput v) {
        if (Boolean.TRUE.equals(v.published()) && !CurrentUser.isAdmin(jwt)) {
            throw ApiException.forbidden(
                    "problems reach the problemset through a contest: add it to one, and it opens for practice when the contest ends");
        }
    }

    /** Only while nobody has submitted to it and no contest uses it; otherwise unpublish it instead. */
    @DeleteMapping("/problems/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @Transactional
    void delete(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        AdminProblem p = find(id, jwt);
        if (p.submissionCount() > 0 || !p.contests().isEmpty()) {
            throw ApiException.conflict("a problem with submissions or in a contest cannot be deleted; unpublish it");
        }
        jdbc.sql("DELETE FROM problems WHERE id = ?").param(id).update();
    }

    @GetMapping("/problems/{id}/test-cases")
    List<AdminTestCase> testCases(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        find(id, jwt);
        return jdbc.sql("SELECT * FROM test_cases WHERE problem_id = ? ORDER BY position")
                .param(id)
                .query((rs, i) -> mapTestCase(rs))
                .list();
    }

    @PostMapping("/problems/{id}/test-cases")
    @ResponseStatus(HttpStatus.CREATED)
    AdminTestCase createTestCase(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id,
            @RequestBody TestCaseInput in) {
        find(id, jwt);
        if (in.input() == null || in.expectedOutput() == null) {
            throw ApiException.badRequest("input and expected_output are required");
        }
        validatePoints(in.points());
        try {
            return jdbc.sql("""
                            INSERT INTO test_cases (problem_id, position, input, expected_output, explanation,
                                                    is_sample, points)
                            VALUES (?, COALESCE(?, (SELECT COALESCE(max(position), 0) + 1 FROM test_cases
                                                    WHERE problem_id = ?)), ?, ?, ?, ?, ?)
                            RETURNING *""")
                    .params(id, in.position(), id, in.input(), in.expectedOutput(), in.explanation(),
                            Boolean.TRUE.equals(in.isSample()), in.points() == null ? 1 : in.points())
                    .query((rs, i) -> mapTestCase(rs))
                    .single();
        } catch (DuplicateKeyException e) {
            throw ApiException.conflict("another test case already has this position");
        }
    }

    @PatchMapping("/test-cases/{id}")
    AdminTestCase updateTestCase(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id,
            @RequestBody TestCaseInput in) {
        checkTestCase(jwt, id);
        validatePoints(in.points());
        try {
            return jdbc.sql("""
                            UPDATE test_cases SET
                              input = COALESCE(?, input), expected_output = COALESCE(?, expected_output),
                              explanation = COALESCE(?, explanation), is_sample = COALESCE(?, is_sample),
                              points = COALESCE(?, points), position = COALESCE(?, position)
                            WHERE id = ? RETURNING *""")
                    .params(in.input(), in.expectedOutput(), in.explanation(), in.isSample(), in.points(),
                            in.position(), id)
                    .query((rs, i) -> mapTestCase(rs))
                    .optional()
                    .orElseThrow(() -> ApiException.notFound("test case not found"));
        } catch (DuplicateKeyException e) {
            throw ApiException.conflict("another test case already has this position");
        }
    }

    @DeleteMapping("/test-cases/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void deleteTestCase(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        checkTestCase(jwt, id);
        if (jdbc.sql("DELETE FROM test_cases WHERE id = ?").param(id).update() == 0) {
            throw ApiException.notFound("test case not found");
        }
    }

    private AdminProblem find(UUID id, Jwt jwt) {
        boolean admin = CurrentUser.isAdmin(jwt);
        UUID me = CurrentUser.id(jwt);
        return jdbc.sql("SELECT " + ADMIN_COLUMNS + " FROM problems p WHERE p.id = ?"
                        + (admin ? "" : " AND " + ProblemAccess.AUTHOR))
                .params(admin ? List.of(id) : List.of(id, me, me))
                .query((rs, i) -> mapAdmin(rs))
                .optional()
                .orElseThrow(() -> ApiException.notFound("problem not found"));
    }

    private void checkTestCase(Jwt jwt, UUID testCaseId) {
        UUID problemId = jdbc.sql("SELECT problem_id FROM test_cases WHERE id = ?")
                .param(testCaseId)
                .query(UUID.class)
                .optional()
                .orElseThrow(() -> ApiException.notFound("test case not found"));
        find(problemId, jwt);
    }

    private void setTags(UUID problemId, List<String> tags) {
        jdbc.sql("DELETE FROM problem_tags WHERE problem_id = ?").param(problemId).update();
        for (String tag : tags) {
            UUID tagId = jdbc.sql("""
                            INSERT INTO tags (name) VALUES (?)
                            ON CONFLICT ((lower(name))) DO UPDATE SET name = tags.name
                            RETURNING id""")
                    .param(tag)
                    .query(UUID.class)
                    .single();
            jdbc.sql("INSERT INTO problem_tags (problem_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING")
                    .params(problemId, tagId)
                    .update();
        }
    }

    private static ProblemInput validated(ProblemInput in) {
        String slug = in.slug() == null ? null : in.slug().trim().toLowerCase(Locale.ROOT);
        if (slug != null && (slug.length() > 64 || !SLUG.matcher(slug).matches())) {
            throw ApiException.badRequest("slug must be lowercase letters, digits and single dashes, at most 64 long");
        }
        String title = in.title() == null ? null : in.title().trim();
        if (title != null && (title.isEmpty() || title.length() > 200)) {
            throw ApiException.badRequest("title must be 1-200 characters");
        }
        if (in.description() != null && in.description().isBlank()) {
            throw ApiException.badRequest("description must not be empty");
        }
        String difficulty = in.difficulty() == null ? null : in.difficulty().trim().toUpperCase(Locale.ROOT);
        if (difficulty != null && !ProblemController.DIFFICULTIES.contains(difficulty)) {
            throw ApiException.badRequest("difficulty must be EASY, MEDIUM or HARD");
        }
        if (in.timeLimitMs() != null && (in.timeLimitMs() < 1 || in.timeLimitMs() > MAX_TIME_LIMIT_MS)) {
            throw ApiException.badRequest("time_limit_ms must be between 1 and " + MAX_TIME_LIMIT_MS);
        }
        if (in.memoryLimitMb() != null && (in.memoryLimitMb() < 16 || in.memoryLimitMb() > MAX_MEMORY_LIMIT_MB)) {
            throw ApiException.badRequest("memory_limit_mb must be between 16 and " + MAX_MEMORY_LIMIT_MB);
        }
        List<String> tags = null;
        if (in.tags() != null) {
            LinkedHashSet<String> clean = new LinkedHashSet<>();
            for (String t : in.tags()) {
                String n = t == null ? "" : t.trim().toLowerCase(Locale.ROOT);
                if (n.isEmpty() || n.length() > 40) {
                    throw ApiException.badRequest("each tag must be 1-40 characters");
                }
                clean.add(n);
            }
            tags = List.copyOf(clean);
        }
        String source = in.sourceUrl() == null ? null : in.sourceUrl().trim();
        if (source != null && !source.isEmpty() && (!source.startsWith("https://") || source.length() > 300)) {
            throw ApiException.badRequest("source_url must be an https:// link of at most 300 characters");
        }
        return new ProblemInput(slug, title, in.description(), in.constraints(), difficulty, in.timeLimitMs(),
                in.memoryLimitMb(), in.published(), tags, source);
    }

    /** An empty source_url clears it. */
    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s;
    }

    private static void validatePoints(Integer points) {
        if (points != null && points < 0) {
            throw ApiException.badRequest("points must not be negative");
        }
    }

    private static AdminProblem mapAdmin(java.sql.ResultSet rs) throws java.sql.SQLException {
        return new AdminProblem(rs.getObject("id", UUID.class), rs.getLong("number"), rs.getString("slug"),
                rs.getString("title"), rs.getString("description"), rs.getString("constraints"),
                rs.getString("difficulty"), rs.getInt("time_limit_ms"), rs.getInt("memory_limit_mb"),
                rs.getBoolean("published"), ProblemController.strings(rs, "tags"), rs.getLong("sample_count"),
                rs.getLong("hidden_count"), rs.getLong("submission_count"), rs.getTimestamp("created_at").toInstant(),
                rs.getTimestamp("updated_at").toInstant(), rs.getString("owner"),
                ProblemController.strings(rs, "contests"), rs.getString("source_url"));
    }

    private static AdminTestCase mapTestCase(java.sql.ResultSet rs) throws java.sql.SQLException {
        return new AdminTestCase(rs.getObject("id", UUID.class), rs.getInt("position"), rs.getString("input"),
                rs.getString("expected_output"), rs.getString("explanation"), rs.getBoolean("is_sample"),
                rs.getInt("points"));
    }
}
