package dev.voidrun.api.problems;

/**
 * Who may see or use a problem, as SQL conditions on a problems row aliased
 * {@code p}. One definition, used by every query, so a contest problem cannot
 * leak through a path that forgot a rule.
 *
 * <ul>
 *   <li><b>Practice</b> (anyone): published, or part of a published contest
 *       that has ended, and not part of any contest that has not ended yet.</li>
 *   <li><b>Author</b>: its owner, or an author of a contest that contains it.</li>
 *   <li><b>Contestant</b>: registered for a running, published contest that
 *       contains it.</li>
 * </ul>
 */
public final class ProblemAccess {

    private ProblemAccess() {}

    /** A contest containing {@code p} that has not finished (upcoming, running, or a draft). */
    static final String IN_UNFINISHED_CONTEST = """
            EXISTS (SELECT 1 FROM contest_problems cp JOIN contests c ON c.id = cp.contest_id
                    WHERE cp.problem_id = p.id AND c.ends_at > now())""";

    /** In the practice set. No parameters. */
    public static final String PRACTICE = """
            ((p.published OR EXISTS (SELECT 1 FROM contest_problems cp JOIN contests c ON c.id = cp.contest_id
                                     WHERE cp.problem_id = p.id AND c.published AND c.ends_at <= now()))
             AND NOT\s""" + IN_UNFINISHED_CONTEST + ")";

    /** The caller owns it or co-authors a contest containing it. Two parameters: the user id, twice. */
    public static final String AUTHOR = """
            (p.owner_id = ? OR EXISTS (SELECT 1 FROM contest_problems cp
                                       JOIN contest_authors ca ON ca.contest_id = cp.contest_id
                                       WHERE cp.problem_id = p.id AND ca.user_id = ?))""";

    /** The caller is competing in a running contest that contains it. One parameter: the user id. */
    public static final String CONTESTANT = """
            EXISTS (SELECT 1 FROM contest_problems cp JOIN contests c ON c.id = cp.contest_id
                    JOIN contest_registrations r ON r.contest_id = c.id AND r.user_id = ?
                    WHERE cp.problem_id = p.id AND c.published AND c.starts_at <= now() AND c.ends_at > now())""";
}
