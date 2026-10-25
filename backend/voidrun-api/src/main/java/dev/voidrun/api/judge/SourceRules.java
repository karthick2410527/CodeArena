package dev.voidrun.api.judge;

import dev.voidrun.api.config.VoidRunProperties;
import dev.voidrun.api.problems.ProblemAccess;
import dev.voidrun.api.web.ApiException;
import dev.voidrun.common.Language;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;

/** Checks shared by runs, submissions and replays. */
public final class SourceRules {

    private SourceRules() {}

    public static Language language(String id) {
        return Language.find(id).orElseThrow(() -> ApiException.badRequest(
                "unsupported language; supported: " + String.join(", ", Language.ids())));
    }

    public static void source(String source, VoidRunProperties.Limits limits) {
        if (source == null || source.isBlank()) {
            throw ApiException.badRequest("source_code must not be empty");
        }
        if (source.getBytes(StandardCharsets.UTF_8).length > limits.maxSourceBytes()) {
            throw ApiException.badRequest("source_code must be at most " + limits.maxSourceBytes() + " bytes");
        }
    }

    /**
     * A problem the caller may submit to outside a contest: one in the
     * practice set, or one they author (so authors can test their own
     * problems before a contest). Anything else is "not found", which does not
     * reveal that a hidden problem exists.
     */
    public static UUID practiceProblem(JdbcClient jdbc, String slug, UUID userId) {
        return jdbc.sql("SELECT p.id FROM problems p WHERE p.slug = ? AND (" + ProblemAccess.PRACTICE + " OR "
                        + ProblemAccess.AUTHOR + ")")
                .params(slug == null ? "" : slug.trim(), userId, userId)
                .query(UUID.class)
                .optional()
                .orElseThrow(() -> ApiException.notFound("problem not found"));
    }

    /** As {@link #practiceProblem}, plus contest problems while the caller is competing, for the Run button. */
    public static UUID runnableProblem(JdbcClient jdbc, String slug, UUID userId) {
        return jdbc.sql("SELECT p.id FROM problems p WHERE p.slug = ? AND (" + ProblemAccess.PRACTICE + " OR "
                        + ProblemAccess.AUTHOR + " OR " + ProblemAccess.CONTESTANT + ")")
                .params(slug == null ? "" : slug.trim(), userId, userId, userId)
                .query(UUID.class)
                .optional()
                .orElseThrow(() -> ApiException.notFound("problem not found"));
    }
}
