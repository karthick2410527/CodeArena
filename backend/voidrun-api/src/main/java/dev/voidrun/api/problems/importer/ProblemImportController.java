package dev.voidrun.api.problems.importer;

import dev.voidrun.api.ratelimit.RateLimiter;
import dev.voidrun.api.security.CurrentUser;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * "Import from a link": reads a Codeforces or AtCoder problem to prefill the
 * editor. It saves nothing; the author reviews, rewrites and then creates the
 * problem, which keeps the link as credit.
 */
@RestController
@RequestMapping({"/api/v1/admin/problems", "/api/v1/studio/problems"})
public class ProblemImportController {

    public record ImportInput(String url) {}

    private final ProblemImporter importer;
    private final RateLimiter limiter;

    public ProblemImportController(ProblemImporter importer, RateLimiter limiter) {
        this.importer = importer;
        this.limiter = limiter;
    }

    @PostMapping("/import")
    ImportedProblem importProblem(@AuthenticationPrincipal Jwt jwt, @RequestBody ImportInput in) {
        // Each import is a request to someone else's site: keep it polite.
        limiter.check("import", CurrentUser.id(jwt).toString(), "too many imports; please wait a few minutes");
        return importer.importFrom(in == null ? null : in.url());
    }

    /** The editorial of the problem at {@code url}, for the contest editorial; saves nothing. */
    @PostMapping("/import-editorial")
    ImportedEditorial importEditorial(@AuthenticationPrincipal Jwt jwt, @RequestBody ImportInput in) {
        limiter.check("import", CurrentUser.id(jwt).toString(), "too many imports; please wait a few minutes");
        return importer.editorialFor(in == null ? null : in.url());
    }
}
