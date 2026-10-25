package dev.voidrun.api.contests;

import dev.voidrun.api.billing.BillingService;
import dev.voidrun.api.config.VoidRunProperties;
import dev.voidrun.api.judge.SourceRules;
import dev.voidrun.api.outbox.OutboxWriter;
import dev.voidrun.api.problems.ProblemAccess;
import dev.voidrun.api.problems.ProblemController;
import dev.voidrun.api.problems.ProblemDtos.ProblemDetail;
import dev.voidrun.api.ratelimit.RateLimiter;
import dev.voidrun.api.security.CurrentUser;
import dev.voidrun.api.web.ApiException;
import dev.voidrun.api.web.CorrelationIdFilter;
import dev.voidrun.api.web.Page;
import dev.voidrun.common.Language;
import dev.voidrun.common.Topics;
import dev.voidrun.common.events.JudgeJob;
import dev.voidrun.common.events.VerdictEvent;
import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.text.Normalizer;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;
import java.util.regex.Pattern;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * Community contests. Anyone signed in can host one; its owner invites
 * co-authors, the authors write or attach problems, and once published other
 * users register and compete while it runs.
 *
 * <p>The phase is derived from the clock, so nothing has to run at the start
 * or the end: before {@code starts_at} a contest is UPCOMING (problems hidden
 * from everyone but its authors), until {@code ends_at} RUNNING (registered
 * users submit and appear in the standings), and then ENDED (its problems join
 * the practice set and further submissions are practice).
 */
@RestController
@RequestMapping("/api/v1/contests")
public class ContestController {

    static final Pattern SLUG = Pattern.compile("[a-z0-9]+(-[a-z0-9]+)*");
    static final int MIN_MINUTES = 10;
    static final int MAX_MINUTES = 14 * 24 * 60;
    static final int MAX_PROBLEMS = 26;
    static final int MAX_AUTHORS = 10;

    // ---- shapes (snake_case on the wire) -------------------------------------------

    public record ContestSummary(String slug, String title, String format, Instant startsAt, Instant endsAt,
            int durationMinutes, String phase, boolean published, List<String> authors, int problemCount,
            long participants, boolean registered, String myRole) {}

    public record ContestProblem(String label, String slug, String title, int points, long solvedBy,
            String myStatus) {}

    /** @param editorialAvailable the caller can read an editorial now (it ended, or they author it) */
    public record ContestDetail(ContestSummary contest, String description, List<ContestProblem> problems,
            boolean problemsVisible, boolean editorialAvailable, Instant serverTime) {}

    public record EditorialProblem(String label, String slug, String title, String editorial) {}

    /** @param isPublic everyone can read it (the contest has ended); otherwise only its authors */
    public record Editorial(String intro, List<EditorialProblem> problems, boolean isPublic) {}

    /** {@code problems} maps a label to its write-up; labels left out keep theirs. */
    public record EditorialInput(String intro, Map<String, String> problems) {}

    /** Create body, or a PATCH body where a null field means "leave unchanged". */
    public record ContestInput(String slug, String title, String description, String format, Instant startsAt,
            Integer durationMinutes) {}

    public record PublishInput(Boolean published) {}

    public record AuthorInput(String username) {}

    public record ProblemRef(UUID problemId, Integer points) {}

    public record ContestProblemView(String label, int points, ProblemDetail problem) {}

    public record SubmitInput(String label, String language, String sourceCode) {}

    public record SubmitResponse(UUID submissionId, String status, boolean inContest) {}

    public record ContestSubmission(UUID submissionId, String label, String problemTitle, String language,
            String status, String verdict, int passedTests, int totalTests, Integer executionTimeMs,
            Integer elapsedSeconds, boolean inContest, Instant createdAt) {}

    public record StandingsView(String format, String phase, List<Standings.Problem> problems,
            List<Standings.Row> rows, Instant generatedAt) {}

    /** The contests row plus what every response needs about it and the caller. */
    record Row(UUID id, String slug, String title, String description, String format, Instant startsAt,
            Instant endsAt, boolean published, List<String> authors, int problemCount, long participants,
            boolean registered, String myRole) {

        String phase(Instant now) {
            return now.isBefore(startsAt) ? "UPCOMING" : now.isBefore(endsAt) ? "RUNNING" : "ENDED";
        }

        boolean isAuthor() {
            return myRole != null;
        }

        ContestSummary summary(Instant now) {
            return new ContestSummary(slug, title, format, startsAt, endsAt,
                    (int) Duration.between(startsAt, endsAt).toMinutes(), phase(now), published, authors,
                    problemCount, participants, registered, myRole);
        }
    }

    private static final String COLUMNS = """
            c.id, c.slug, c.title, c.description, c.format, c.starts_at, c.ends_at, c.published,
            COALESCE((SELECT array_agg(u.username ORDER BY (ca.role = 'OWNER') DESC, ca.added_at)
                      FROM contest_authors ca JOIN users u ON u.id = ca.user_id WHERE ca.contest_id = c.id), '{}')
                AS authors,
            (SELECT count(*) FROM contest_problems cp WHERE cp.contest_id = c.id) AS problem_count,
            (SELECT count(*) FROM contest_registrations r WHERE r.contest_id = c.id) AS participants,
            EXISTS (SELECT 1 FROM contest_registrations r WHERE r.contest_id = c.id AND r.user_id = ?) AS registered,
            (SELECT ca.role FROM contest_authors ca WHERE ca.contest_id = c.id AND ca.user_id = ?) AS my_role""";

    private final JdbcClient jdbc;
    private final BillingService billing;
    private final TransactionTemplate tx;
    private final OutboxWriter outbox;
    private final RateLimiter limiter;
    private final VoidRunProperties props;
    private final ProblemController problems;

    public ContestController(JdbcClient jdbc, TransactionTemplate tx, OutboxWriter outbox, RateLimiter limiter,
            VoidRunProperties props, ProblemController problems, BillingService billing) {
        this.billing = billing;
        this.jdbc = jdbc;
        this.tx = tx;
        this.outbox = outbox;
        this.limiter = limiter;
        this.props = props;
        this.problems = problems;
    }

    // ---- browsing ---------------------------------------------------------------------

    /** Published contests: {@code phase} = upcoming (soonest first), running, or past (latest first). */
    @GetMapping
    Page<ContestSummary> list(@AuthenticationPrincipal Jwt jwt, @RequestParam(required = false) String phase,
            @RequestParam(required = false) Integer page, @RequestParam(required = false) Integer limit,
            @RequestParam(required = false) String q, @RequestParam(required = false) String exclude) {
        Page.Request p = Page.Request.of(page, limit);
        UUID me = me(jwt);
        String key = phase == null || phase.isBlank() ? "all" : phase.trim().toLowerCase(Locale.ROOT);
        String where;
        String order;
        switch (key) {
            case "upcoming" -> {
                where = " AND c.starts_at > now()";
                order = "c.starts_at";
            }
            case "running" -> {
                where = " AND c.starts_at <= now() AND c.ends_at > now()";
                order = "c.ends_at";
            }
            case "past" -> {
                where = " AND c.ends_at <= now()";
                order = "c.starts_at DESC";
            }
            case "all" -> {
                where = "";
                order = "c.starts_at DESC";
            }
            default -> throw ApiException.badRequest("phase must be upcoming, running or past");
        }
        List<Object> filter = new ArrayList<>();
        if (q != null && !q.isBlank()) {
            where += " AND c.title ILIKE ?";
            filter.add("%" + ProblemController.likeEscape(q.trim()) + "%");
        }
        // "exclude=hosted,registered": the caller's own rounds have their own sections, so the
        // general lists can leave them out. Signed out there is nothing to leave out.
        if (exclude != null && !exclude.isBlank() && me != null) {
            for (String part : exclude.toLowerCase(Locale.ROOT).split(",")) {
                switch (part.trim()) {
                    case "hosted" -> {
                        where += " AND NOT EXISTS (SELECT 1 FROM contest_authors ca WHERE ca.contest_id = c.id AND ca.user_id = ?)";
                        filter.add(me);
                    }
                    case "registered" -> {
                        where += " AND NOT EXISTS (SELECT 1 FROM contest_registrations r WHERE r.contest_id = c.id AND r.user_id = ?)";
                        filter.add(me);
                    }
                    case "" -> { }
                    default -> throw ApiException.badRequest("exclude takes hosted and registered");
                }
            }
        }
        long total = jdbc.sql("SELECT count(*) FROM contests c WHERE c.published" + where).params(filter)
                .query(Long.class).single();
        Instant now = Instant.now();
        List<Object> args = new ArrayList<>();
        args.add(me);
        args.add(me);
        args.addAll(filter);
        args.add(p.limit());
        args.add(p.offset());
        List<ContestSummary> items = jdbc.sql("SELECT " + COLUMNS + " FROM contests c WHERE c.published" + where
                        + " ORDER BY " + order + " LIMIT ? OFFSET ?")
                .params(args)
                .query((rs, i) -> map(rs).summary(now))
                .list();
        return p.wrap(items, total);
    }

    /** Contests the caller hosts or co-authors, drafts included. */
    @GetMapping("/mine")
    List<ContestSummary> mine(@AuthenticationPrincipal Jwt jwt) {
        if (jwt == null) {
            throw ApiException.unauthorized("sign in first");
        }
        UUID me = CurrentUser.id(jwt);
        Instant now = Instant.now();
        return jdbc.sql("SELECT " + COLUMNS + """
                         FROM contests c
                        WHERE EXISTS (SELECT 1 FROM contest_authors ca WHERE ca.contest_id = c.id AND ca.user_id = ?)
                        ORDER BY c.starts_at DESC""")
                .params(me, me, me)
                .query((rs, i) -> map(rs).summary(now))
                .list();
    }

    /**
     * @param rank null before the contest starts, or while the caller has not submitted yet
     * @param solved problems accepted (for IOI, those at full marks)
     */
    public record JoinedContest(ContestSummary contest, Integer rank, int ranked, int solved, int score) {}

    /** Contests the caller registered for, newest first, with their place in each. */
    @GetMapping("/joined")
    List<JoinedContest> joined(@AuthenticationPrincipal Jwt jwt) {
        if (jwt == null) {
            throw ApiException.unauthorized("sign in first");
        }
        UUID me = CurrentUser.id(jwt);
        Instant now = Instant.now();
        List<Row> rows = jdbc.sql("SELECT " + COLUMNS + """
                         FROM contests c
                         JOIN contest_registrations r ON r.contest_id = c.id AND r.user_id = ?
                        WHERE c.published
                        ORDER BY c.starts_at DESC LIMIT 100""")
                .params(me, me, me)
                .query((rs, i) -> map(rs))
                .list();
        List<JoinedContest> out = new ArrayList<>(rows.size());
        for (Row c : rows) {
            if (c.phase(now).equals("UPCOMING")) {
                out.add(new JoinedContest(c.summary(now), null, 0, 0, 0));
                continue;
            }
            StandingsView s = standingsOf(c, now);
            Standings.Row mine = s.rows().stream().filter(r -> r.participant().userId().equals(me)).findFirst()
                    .orElse(null);
            out.add(new JoinedContest(c.summary(now), mine == null ? null : mine.rank(), s.rows().size(),
                    mine == null ? 0 : mine.solved(), mine == null ? 0 : mine.score()));
        }
        return out;
    }

    @GetMapping("/{slug}")
    ContestDetail get(@AuthenticationPrincipal Jwt jwt, @PathVariable String slug) {
        UUID me = me(jwt);
        Row c = visible(slug, jwt);
        Instant now = Instant.now();
        boolean show = problemsVisible(c, jwt, now);
        List<ContestProblem> list = !show ? List.of() : jdbc.sql("""
                        SELECT cp.label, cp.points, p.slug, p.title,
                          (SELECT count(DISTINCT s.user_id) FROM submissions s WHERE s.contest_id = cp.contest_id
                             AND s.problem_id = p.id AND s.verdict = 'ACCEPTED') AS solved_by,
                          CASE WHEN EXISTS (SELECT 1 FROM submissions s WHERE s.problem_id = p.id AND s.user_id = ?
                                            AND s.verdict = 'ACCEPTED' AND s.created_at >= ?) THEN 'SOLVED'
                               WHEN EXISTS (SELECT 1 FROM submissions s WHERE s.problem_id = p.id AND s.user_id = ?
                                            AND s.created_at >= ?) THEN 'ATTEMPTED' END AS my_status
                        FROM contest_problems cp JOIN problems p ON p.id = cp.problem_id
                        WHERE cp.contest_id = ? ORDER BY cp.position""")
                .params(me, Timestamp.from(c.startsAt()), me, Timestamp.from(c.startsAt()), c.id())
                .query((rs, i) -> new ContestProblem(rs.getString("label"), rs.getString("slug"),
                        rs.getString("title"), rs.getInt("points"), rs.getLong("solved_by"),
                        rs.getString("my_status")))
                .list();
        boolean editorial = editorialReadable(c, jwt, now) && jdbc.sql("""
                        SELECT (SELECT editorial FROM contests WHERE id = ?) <> ''
                            OR EXISTS (SELECT 1 FROM contest_problems WHERE contest_id = ? AND editorial <> '')""")
                .params(c.id(), c.id()).query(Boolean.class).single();
        return new ContestDetail(c.summary(now), c.description(), list, show, editorial, now);
    }

    // ---- hosting ----------------------------------------------------------------------

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    ContestDetail create(@AuthenticationPrincipal Jwt jwt, @RequestBody ContestInput in) {
        UUID me = CurrentUser.id(jwt);
        // Hosting is what the Host plan pays for: a live round reserves judge capacity for it.
        requireHostPlan(jwt, "hosting a contest needs an active Host plan");
        limiter.check("contest", me.toString(), "too many new contests; please wait before creating another");
        if (in.title() == null || in.startsAt() == null || in.durationMinutes() == null) {
            throw ApiException.badRequest("title, starts_at and duration_minutes are required");
        }
        ContestInput v = validated(in);
        String slug = v.slug() != null ? v.slug() : slugFrom(v.title());
        tx.executeWithoutResult(status -> {
            UUID id;
            try {
                id = jdbc.sql("""
                                INSERT INTO contests (slug, title, description, format, starts_at, ends_at, created_by)
                                VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id""")
                        .params(slug, v.title(), v.description() == null ? "" : v.description(),
                                v.format() == null ? "CODEFORCES" : v.format(), Timestamp.from(v.startsAt()),
                                Timestamp.from(v.startsAt().plus(Duration.ofMinutes(v.durationMinutes()))), me)
                        .query(UUID.class)
                        .single();
            } catch (DuplicateKeyException e) {
                throw ApiException.conflict("a contest with this slug already exists");
            }
            jdbc.sql("INSERT INTO contest_authors (contest_id, user_id, role) VALUES (?, ?, 'OWNER')")
                    .params(id, me)
                    .update();
        });
        return get(jwt, slug);
    }

    /** Before the start everything can change; afterwards only the title and description. */
    @PatchMapping("/{slug}")
    ContestDetail update(@AuthenticationPrincipal Jwt jwt, @PathVariable String slug, @RequestBody ContestInput in) {
        Row c = authored(slug, jwt);
        ContestInput v = validated(in);
        boolean started = !Instant.now().isBefore(c.startsAt());
        if (started && c.published() && (v.slug() != null || v.format() != null || v.startsAt() != null
                || v.durationMinutes() != null)) {
            throw ApiException.conflict("the contest has started; only its title and description can change");
        }
        Instant start = v.startsAt() != null ? v.startsAt() : c.startsAt();
        int minutes = v.durationMinutes() != null
                ? v.durationMinutes()
                : (int) Duration.between(c.startsAt(), c.endsAt()).toMinutes();
        if (c.published() && v.startsAt() != null && !start.isAfter(Instant.now())) {
            throw ApiException.badRequest("a published contest must start in the future");
        }
        try {
            jdbc.sql("""
                            UPDATE contests SET slug = COALESCE(?, slug), title = COALESCE(?, title),
                              description = COALESCE(?, description), format = COALESCE(?, format),
                              starts_at = ?, ends_at = ?, updated_at = now()
                            WHERE id = ?""")
                    .params(v.slug(), v.title(), v.description(), v.format(), Timestamp.from(start),
                            Timestamp.from(start.plus(Duration.ofMinutes(minutes))), c.id())
                    .update();
        } catch (DuplicateKeyException e) {
            throw ApiException.conflict("a contest with this slug already exists");
        }
        return get(jwt, v.slug() != null ? v.slug() : slug);
    }

    /** Announces the contest (or takes it back before it starts). It must have problems, all of them judgeable. */
    @PostMapping("/{slug}/publish")
    ContestDetail publish(@AuthenticationPrincipal Jwt jwt, @PathVariable String slug, @RequestBody PublishInput in) {
        Row c = authored(slug, jwt);
        boolean on = in == null || in.published() == null || in.published();
        Instant now = Instant.now();
        if (!now.isBefore(c.startsAt()) && c.published()) {
            throw ApiException.conflict("the contest has already started");
        }
        if (on) {
            // A plan that ran out after the draft was made still stops it going live.
            requireHostPlan(jwt, "publishing a contest needs an active Host plan");
            if (!c.startsAt().isAfter(now)) {
                throw ApiException.badRequest("move the start time into the future before publishing");
            }
            if (c.problemCount() == 0) {
                throw ApiException.badRequest("add at least one problem before publishing");
            }
            List<String> untested = jdbc.sql("""
                            SELECT cp.label FROM contest_problems cp WHERE cp.contest_id = ?
                              AND NOT EXISTS (SELECT 1 FROM test_cases tc WHERE tc.problem_id = cp.problem_id)
                            ORDER BY cp.position""")
                    .param(c.id())
                    .query(String.class)
                    .list();
            if (!untested.isEmpty()) {
                throw ApiException.badRequest("problem " + String.join(", ", untested)
                        + " has no test cases yet, so it could not be judged");
            }
        }
        jdbc.sql("UPDATE contests SET published = ?, updated_at = now() WHERE id = ?").params(on, c.id()).update();
        return get(jwt, slug);
    }

    @DeleteMapping("/{slug}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void delete(@AuthenticationPrincipal Jwt jwt, @PathVariable String slug) {
        Row c = authored(slug, jwt);
        requireOwner(c);
        if (c.published() && !Instant.now().isBefore(c.startsAt())) {
            throw ApiException.conflict("a contest that has started cannot be deleted");
        }
        jdbc.sql("DELETE FROM contests WHERE id = ?").param(c.id()).update();
    }

    @PostMapping("/{slug}/authors")
    @ResponseStatus(HttpStatus.CREATED)
    ContestDetail addAuthor(@AuthenticationPrincipal Jwt jwt, @PathVariable String slug,
            @RequestBody AuthorInput in) {
        Row c = authored(slug, jwt);
        requireOwner(c);
        UUID user = userByName(in == null ? null : in.username());
        if (c.authors().size() >= MAX_AUTHORS) {
            throw ApiException.badRequest("a contest can have at most " + MAX_AUTHORS + " authors");
        }
        boolean registered = jdbc.sql("SELECT count(*) FROM contest_registrations WHERE contest_id = ? AND user_id = ?")
                .params(c.id(), user).query(Long.class).single() > 0;
        if (registered) {
            throw ApiException.conflict("that user is registered to compete; an author cannot compete");
        }
        int added = jdbc.sql("""
                        INSERT INTO contest_authors (contest_id, user_id, role) VALUES (?, ?, 'AUTHOR')
                        ON CONFLICT DO NOTHING""")
                .params(c.id(), user)
                .update();
        if (added == 0) {
            throw ApiException.conflict("that user is already an author");
        }
        return get(jwt, slug);
    }

    /** The owner removes an author, or an author leaves. The owner cannot be removed. */
    @DeleteMapping("/{slug}/authors/{username}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void removeAuthor(@AuthenticationPrincipal Jwt jwt, @PathVariable String slug, @PathVariable String username) {
        Row c = authored(slug, jwt);
        UUID user = userByName(username);
        boolean self = user.equals(CurrentUser.id(jwt));
        if (!self) {
            requireOwner(c);
        }
        int n = jdbc.sql("DELETE FROM contest_authors WHERE contest_id = ? AND user_id = ? AND role = 'AUTHOR'")
                .params(c.id(), user)
                .update();
        if (n == 0) {
            throw ApiException.badRequest("not a removable author of this contest (the owner stays)");
        }
    }

    /**
     * Replaces the problem list, in order: they become A, B, C… A problem can
     * be added only by someone who may edit it (its owner or a co-author), so a
     * contest can never expose someone else's hidden problem.
     */
    @PutMapping("/{slug}/problems")
    @Transactional
    ContestDetail setProblems(@AuthenticationPrincipal Jwt jwt, @PathVariable String slug,
            @RequestBody List<ProblemRef> refs) {
        Row c = authored(slug, jwt);
        if (c.published() && !Instant.now().isBefore(c.startsAt())) {
            throw ApiException.conflict("the problems are fixed once the contest has started");
        }
        if (refs == null || refs.size() > MAX_PROBLEMS) {
            throw ApiException.badRequest("a contest has between 0 and " + MAX_PROBLEMS + " problems");
        }
        Set<UUID> seen = new HashSet<>();
        UUID me = CurrentUser.id(jwt);
        boolean admin = CurrentUser.isAdmin(jwt);
        Standings.Format format = Standings.Format.valueOf(c.format());
        for (ProblemRef r : refs) {
            if (r == null || r.problemId() == null || !seen.add(r.problemId())) {
                throw ApiException.badRequest("each problem must be listed once, by problem_id");
            }
            if (r.points() != null && (r.points() < 1 || r.points() > 10_000)) {
                throw ApiException.badRequest("points must be between 1 and 10000");
            }
            boolean editable = jdbc.sql("SELECT count(*) FROM problems p WHERE p.id = ?"
                            + (admin ? "" : " AND (" + ProblemAccess.AUTHOR
                                    + " OR EXISTS (SELECT 1 FROM contest_problems x WHERE x.problem_id = p.id"
                                    + " AND x.contest_id = ?))"))
                    .params(admin ? List.of(r.problemId()) : List.of(r.problemId(), me, me, c.id()))
                    .query(Long.class)
                    .single() > 0;
            if (!editable) {
                throw ApiException.notFound("problem " + r.problemId() + " not found among your problems");
            }
        }
        jdbc.sql("DELETE FROM contest_problems WHERE contest_id = ?").param(c.id()).update();
        for (int i = 0; i < refs.size(); i++) {
            ProblemRef r = refs.get(i);
            jdbc.sql("INSERT INTO contest_problems (contest_id, problem_id, label, position, points) VALUES (?, ?, ?, ?, ?)")
                    .params(c.id(), r.problemId(), label(i), i,
                            r.points() != null ? r.points() : Standings.defaultPoints(format, i))
                    .update();
        }
        jdbc.sql("UPDATE contests SET updated_at = now() WHERE id = ?").param(c.id()).update();
        return get(jwt, slug);
    }

    // ---- competing ----------------------------------------------------------------------

    /** Open until the contest ends: late registration is allowed, as on Codeforces. */
    @PostMapping("/{slug}/registration")
    ContestDetail register(@AuthenticationPrincipal Jwt jwt, @PathVariable String slug) {
        Row c = visible(slug, jwt);
        if (!c.published()) {
            throw ApiException.conflict("the contest is not open for registration yet");
        }
        if (!Instant.now().isBefore(c.endsAt())) {
            throw ApiException.conflict("the contest has ended");
        }
        if (c.isAuthor()) {
            throw ApiException.conflict("authors cannot compete in their own contest");
        }
        jdbc.sql("INSERT INTO contest_registrations (contest_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING")
                .params(c.id(), CurrentUser.id(jwt))
                .update();
        return get(jwt, slug);
    }

    @DeleteMapping("/{slug}/registration")
    ContestDetail unregister(@AuthenticationPrincipal Jwt jwt, @PathVariable String slug) {
        Row c = visible(slug, jwt);
        if (!Instant.now().isBefore(c.startsAt())) {
            throw ApiException.conflict("the contest has started; registration can no longer be withdrawn");
        }
        jdbc.sql("DELETE FROM contest_registrations WHERE contest_id = ? AND user_id = ?")
                .params(c.id(), CurrentUser.id(jwt))
                .update();
        return get(jwt, slug);
    }

    @GetMapping("/{slug}/problems/{label}")
    ContestProblemView problem(@AuthenticationPrincipal Jwt jwt, @PathVariable String slug,
            @PathVariable String label) {
        Row c = visible(slug, jwt);
        if (!problemsVisible(c, jwt, Instant.now())) {
            throw ApiException.notFound("problem not found");
        }
        record Ref(UUID id, int points) {}
        Ref ref = jdbc.sql("SELECT problem_id, points FROM contest_problems WHERE contest_id = ? AND label = ?")
                .params(c.id(), label.toUpperCase(Locale.ROOT))
                .query((rs, i) -> new Ref(rs.getObject("problem_id", UUID.class), rs.getInt("points")))
                .optional()
                .orElseThrow(() -> ApiException.notFound("problem not found"));
        return new ContestProblemView(label.toUpperCase(Locale.ROOT), ref.points(), problems.detail(ref.id(), me(jwt)));
    }

    /**
     * During the contest a registered user's submission counts for the
     * standings and goes to its own, highest-priority topic. Before the start
     * only authors may submit (to test), and after the end anyone may
     * (upsolving); those are ordinary practice submissions.
     */
    @PostMapping("/{slug}/submissions")
    @ResponseStatus(HttpStatus.ACCEPTED)
    SubmitResponse submit(@AuthenticationPrincipal Jwt jwt, @PathVariable String slug, @RequestBody SubmitInput in) {
        UUID me = CurrentUser.id(jwt);
        limiter.check("submit", me.toString(), "too many submissions; please wait before submitting again");
        Row c = visible(slug, jwt);
        Language language = SourceRules.language(in.language());
        SourceRules.source(in.sourceCode(), props.limits());
        Instant now = Instant.now();
        String phase = c.phase(now);
        boolean inContest = "RUNNING".equals(phase) && c.registered() && c.published();
        if (!inContest && !c.isAuthor()) {
            if ("UPCOMING".equals(phase) || !c.published()) {
                throw ApiException.conflict("the contest has not started yet");
            }
            if ("RUNNING".equals(phase)) {
                throw ApiException.forbidden("register for the contest to submit");
            }
        }
        UUID problemId = jdbc.sql("SELECT problem_id FROM contest_problems WHERE contest_id = ? AND label = ?")
                .params(c.id(), in.label() == null ? "" : in.label().trim().toUpperCase(Locale.ROOT))
                .query(UUID.class)
                .optional()
                .orElseThrow(() -> ApiException.notFound("problem not found"));
        if (jdbc.sql("SELECT count(*) FROM test_cases WHERE problem_id = ?").param(problemId).query(Long.class)
                .single() == 0) {
            throw ApiException.badRequest("this problem has no test cases yet and cannot be judged");
        }
        String correlationId = CorrelationIdFilter.current();
        Integer elapsed = inContest ? (int) Duration.between(c.startsAt(), now).toSeconds() : null;
        UUID id = tx.execute(status -> {
            UUID sid = jdbc.sql("""
                            INSERT INTO submissions (user_id, problem_id, language, source_code, correlation_id,
                                                     contest_id, contest_elapsed_seconds)
                            VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id""")
                    .params(me, problemId, language.id(), in.sourceCode(), correlationId, inContest ? c.id() : null,
                            elapsed)
                    .query(UUID.class)
                    .single();
            outbox.append(inContest ? Topics.CONTEST_SUBMISSIONS : Topics.SUBMISSIONS, sid.toString(),
                    "submission.created", sid, JudgeJob.submission(sid, correlationId), correlationId);
            if (inContest) {
                // Live boards show it as pending straight away; the worker announces the verdict.
                outbox.append(Topics.VERDICTS, c.id().toString(), "submission.pending", sid,
                        VerdictEvent.of(c.id(), sid, me, null), correlationId);
            }
            return sid;
        });
        return new SubmitResponse(id, "QUEUED", inContest);
    }

    /**
     * The caller's submissions to this contest's problems since the contest was
     * created (an author's test runs, the contest itself, upsolving), newest first.
     */
    @GetMapping("/{slug}/submissions")
    List<ContestSubmission> mySubmissions(@AuthenticationPrincipal Jwt jwt, @PathVariable String slug) {
        if (jwt == null) {
            throw ApiException.unauthorized("sign in first");
        }
        Row c = visible(slug, jwt);
        return jdbc.sql("""
                        SELECT s.id, cp.label, p.title, s.language, s.status, s.verdict, s.passed_tests, s.total_tests,
                               s.max_time_ms, s.contest_elapsed_seconds, s.contest_id IS NOT NULL AS in_contest,
                               s.created_at
                        FROM submissions s
                        JOIN contest_problems cp ON cp.problem_id = s.problem_id AND cp.contest_id = ?
                        JOIN problems p ON p.id = s.problem_id
                        WHERE s.user_id = ?
                          AND (s.contest_id = ? OR s.created_at >= (SELECT created_at FROM contests WHERE id = ?))
                        ORDER BY s.created_at DESC LIMIT 200""")
                .params(c.id(), CurrentUser.id(jwt), c.id(), c.id())
                .query((rs, i) -> new ContestSubmission(rs.getObject("id", UUID.class), rs.getString("label"),
                        rs.getString("title"), rs.getString("language"), rs.getString("status"),
                        rs.getString("verdict"), rs.getInt("passed_tests"), rs.getInt("total_tests"),
                        (Integer) rs.getObject("max_time_ms"), (Integer) rs.getObject("contest_elapsed_seconds"),
                        rs.getBoolean("in_contest"), rs.getTimestamp("created_at").toInstant()))
                .list();
    }

    /** The editorial: for its authors at any time, for everyone once the contest has ended. */
    @GetMapping("/{slug}/editorial")
    Editorial editorial(@AuthenticationPrincipal Jwt jwt, @PathVariable String slug) {
        Row c = visible(slug, jwt);
        Instant now = Instant.now();
        if (!editorialReadable(c, jwt, now)) {
            throw ApiException.conflict("EDITORIAL_NOT_YET", "the editorial appears when the contest ends");
        }
        String intro = jdbc.sql("SELECT editorial FROM contests WHERE id = ?").param(c.id()).query(String.class)
                .single();
        List<EditorialProblem> list = jdbc.sql("""
                        SELECT cp.label, p.slug, p.title, cp.editorial FROM contest_problems cp
                        JOIN problems p ON p.id = cp.problem_id WHERE cp.contest_id = ? ORDER BY cp.position""")
                .param(c.id())
                .query((rs, i) -> new EditorialProblem(rs.getString("label"), rs.getString("slug"),
                        rs.getString("title"), rs.getString("editorial")))
                .list();
        return new Editorial(intro, list, c.published() && !now.isBefore(c.endsAt()));
    }

    /** Authors write it whenever they like; nobody else sees it before the end. */
    @PutMapping("/{slug}/editorial")
    @Transactional
    Editorial saveEditorial(@AuthenticationPrincipal Jwt jwt, @PathVariable String slug,
            @RequestBody EditorialInput in) {
        Row c = authored(slug, jwt);
        if (in == null) {
            throw ApiException.badRequest("nothing to save");
        }
        if (in.intro() != null) {
            if (in.intro().length() > 50_000) {
                throw ApiException.badRequest("the introduction must be at most 50000 characters");
            }
            jdbc.sql("UPDATE contests SET editorial = ?, updated_at = now() WHERE id = ?").params(in.intro(), c.id())
                    .update();
        }
        if (in.problems() != null) {
            for (Map.Entry<String, String> e : in.problems().entrySet()) {
                String text = e.getValue() == null ? "" : e.getValue();
                if (text.length() > 50_000) {
                    throw ApiException.badRequest("each write-up must be at most 50000 characters");
                }
                int n = jdbc.sql("UPDATE contest_problems SET editorial = ? WHERE contest_id = ? AND label = ?")
                        .params(text, c.id(), e.getKey().trim().toUpperCase(Locale.ROOT))
                        .update();
                if (n == 0) {
                    throw ApiException.badRequest("the contest has no problem " + e.getKey());
                }
            }
        }
        return editorial(jwt, slug);
    }

    private static boolean editorialReadable(Row c, Jwt jwt, Instant now) {
        return c.isAuthor() || CurrentUser.isAdmin(jwt) || (c.published() && !now.isBefore(c.endsAt()));
    }

    @GetMapping("/{slug}/standings")
    StandingsView standings(@AuthenticationPrincipal Jwt jwt, @PathVariable String slug) {
        Row c = visible(slug, jwt);
        Instant now = Instant.now();
        if (!problemsVisible(c, jwt, now)) {
            throw ApiException.conflict("standings appear when the contest starts");
        }
        return standingsOf(c, now);
    }

    StandingsView standingsOf(Row c, Instant now) {
        List<Standings.Problem> probs = jdbc.sql(
                        "SELECT label, points FROM contest_problems WHERE contest_id = ? ORDER BY position")
                .param(c.id())
                .query((rs, i) -> new Standings.Problem(rs.getString("label"), rs.getInt("points")))
                .list();
        List<Standings.Participant> people = jdbc.sql("""
                        SELECT u.id, u.username, u.display_name, u.avatar_url
                        FROM contest_registrations r JOIN users u ON u.id = r.user_id
                        WHERE r.contest_id = ?""")
                .param(c.id())
                .query((rs, i) -> new Standings.Participant(rs.getObject("id", UUID.class), rs.getString("username"),
                        rs.getString("display_name"), rs.getString("avatar_url")))
                .list();
        List<Standings.Submission> subs = jdbc.sql("""
                        SELECT s.user_id, cp.label, s.status, s.verdict, s.contest_elapsed_seconds, s.score,
                               s.max_score
                        FROM submissions s
                        JOIN contest_problems cp ON cp.contest_id = s.contest_id AND cp.problem_id = s.problem_id
                        WHERE s.contest_id = ? ORDER BY s.created_at, s.id""")
                .param(c.id())
                .query((rs, i) -> new Standings.Submission(rs.getObject("user_id", UUID.class), rs.getString("label"),
                        rs.getString("status"), rs.getString("verdict"), rs.getInt("contest_elapsed_seconds"),
                        rs.getInt("score"), rs.getInt("max_score")))
                .list();
        Standings.Format format = Standings.Format.valueOf(c.format());
        return new StandingsView(c.format(), c.phase(now), probs, Standings.compute(format, probs, people, subs), now);
    }

    // ---- access -------------------------------------------------------------------------

    private void requireHostPlan(Jwt jwt, String message) {
        if (!billing.canHost(CurrentUser.id(jwt), CurrentUser.isAdmin(jwt))) {
            throw ApiException.paymentRequired("HOST_PLAN_REQUIRED", message);
        }
    }

    /** A published contest, or a draft the caller authors (or any, for an admin); otherwise 404. */
    Row visible(String slug, Jwt jwt) {
        UUID me = me(jwt);
        Row c = jdbc.sql("SELECT " + COLUMNS + " FROM contests c WHERE c.slug = ?")
                .params(me, me, slug)
                .query((rs, i) -> map(rs))
                .optional()
                .orElseThrow(() -> ApiException.notFound("contest not found"));
        if (!c.published() && !c.isAuthor() && !CurrentUser.isAdmin(jwt)) {
            throw ApiException.notFound("contest not found");
        }
        return c;
    }

    private Row authored(String slug, Jwt jwt) {
        if (jwt == null) {
            throw ApiException.unauthorized("sign in first");
        }
        Row c = visible(slug, jwt);
        if (!c.isAuthor() && !CurrentUser.isAdmin(jwt)) {
            throw ApiException.forbidden("only the contest's authors can change it");
        }
        return c;
    }

    private static void requireOwner(Row c) {
        if (!"OWNER".equals(c.myRole())) {
            throw ApiException.forbidden("only the contest's owner can do that");
        }
    }

    private static boolean problemsVisible(Row c, Jwt jwt, Instant now) {
        return c.isAuthor() || CurrentUser.isAdmin(jwt) || (c.published() && !now.isBefore(c.startsAt()));
    }

    private UUID userByName(String username) {
        return jdbc.sql("SELECT id FROM users WHERE lower(username) = lower(?)")
                .param(username == null ? "" : username.trim())
                .query(UUID.class)
                .optional()
                .orElseThrow(() -> ApiException.notFound("no user called " + username));
    }

    private static UUID me(Jwt jwt) {
        return jwt == null ? null : CurrentUser.id(jwt);
    }

    static String label(int index) {
        return String.valueOf((char) ('A' + index));
    }

    private static ContestInput validated(ContestInput in) {
        String slug = in.slug() == null || in.slug().isBlank() ? null : in.slug().trim().toLowerCase(Locale.ROOT);
        if (slug != null && (slug.length() > 64 || !SLUG.matcher(slug).matches())) {
            throw ApiException.badRequest("slug must be lowercase letters, digits and single dashes, at most 64 long");
        }
        String title = in.title() == null ? null : in.title().trim();
        if (title != null && (title.isEmpty() || title.length() > 120)) {
            throw ApiException.badRequest("title must be 1-120 characters");
        }
        if (in.description() != null && in.description().length() > 20_000) {
            throw ApiException.badRequest("description must be at most 20000 characters");
        }
        String format = in.format() == null ? null : in.format().trim().toUpperCase(Locale.ROOT);
        if (format != null) {
            try {
                Standings.Format.valueOf(format);
            } catch (IllegalArgumentException e) {
                throw ApiException.badRequest("format must be CODEFORCES, ICPC, ATCODER or IOI");
            }
        }
        if (in.durationMinutes() != null && (in.durationMinutes() < MIN_MINUTES || in.durationMinutes() > MAX_MINUTES)) {
            throw ApiException.badRequest("duration_minutes must be between " + MIN_MINUTES + " and " + MAX_MINUTES);
        }
        return new ContestInput(slug, title, in.description(), format, in.startsAt(), in.durationMinutes());
    }

    /** {@code "Round #1: Warm-up!"} becomes {@code round-1-warm-up-x7k2}; the suffix keeps it unique. */
    static String slugFrom(String title) {
        String ascii = Normalizer.normalize(title, Normalizer.Form.NFKD).replaceAll("\\p{M}", "");
        String base = ascii.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "-").replaceAll("(^-|-$)", "");
        if (base.length() > 48) {
            base = base.substring(0, 48).replaceAll("-$", "");
        }
        String suffix = Integer.toString(ThreadLocalRandom.current().nextInt(36 * 36 * 36, 36 * 36 * 36 * 36), 36);
        return (base.isEmpty() ? "contest" : base) + "-" + suffix;
    }

    private static Row map(ResultSet rs) throws SQLException {
        Array a = rs.getArray("authors");
        return new Row(rs.getObject("id", UUID.class), rs.getString("slug"), rs.getString("title"),
                rs.getString("description"), rs.getString("format"), rs.getTimestamp("starts_at").toInstant(),
                rs.getTimestamp("ends_at").toInstant(), rs.getBoolean("published"),
                a == null ? List.of() : List.of((String[]) a.getArray()), rs.getInt("problem_count"),
                rs.getLong("participants"), rs.getBoolean("registered"), rs.getString("my_role"));
    }
}
