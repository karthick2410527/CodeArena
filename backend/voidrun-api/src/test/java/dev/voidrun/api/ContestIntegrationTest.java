package dev.voidrun.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.jayway.jsonpath.JsonPath;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import org.hamcrest.Matchers;
import org.junit.jupiter.api.Test;

/** A community contest from draft to upsolving, with the clock moved by SQL. */
class ContestIntegrationTest extends ApiTestSupport {

    private static final String CPP = "int main(){return 0;}";

    private String problem(TestUser owner, boolean withTests) throws Exception {
        String slug = unique("p");
        String body = mvc.perform(json(post("/api/v1/studio/problems"), """
                        {"slug":"%s","title":"Sum %s","description":"Add them.","difficulty":"EASY",
                         "time_limit_ms":1000,"memory_limit_mb":256}""".formatted(slug, slug))
                        .header("Authorization", owner.bearer()))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.owner").value(owner.username()))
                .andExpect(jsonPath("$.published").value(false))
                .andReturn().getResponse().getContentAsString();
        String id = JsonPath.read(body, "$.id");
        if (withTests) {
            mvc.perform(json(post("/api/v1/studio/problems/" + id + "/test-cases"),
                            "{\"input\":\"1 2\",\"expected_output\":\"3\",\"is_sample\":true}")
                            .header("Authorization", owner.bearer()))
                    .andExpect(status().isCreated());
        }
        return id;
    }

    private String contest(TestUser owner) throws Exception {
        String body = mvc.perform(json(post("/api/v1/contests"), """
                        {"title":"Round %s","format":"ICPC","starts_at":"%s","duration_minutes":120}"""
                        .formatted(unique("r"), Instant.now().plus(1, ChronoUnit.DAYS)))
                        .header("Authorization", owner.bearer()))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.contest.phase").value("UPCOMING"))
                .andExpect(jsonPath("$.contest.published").value(false))
                .andExpect(jsonPath("$.contest.duration_minutes").value(120))
                .andExpect(jsonPath("$.contest.my_role").value("OWNER"))
                .andReturn().getResponse().getContentAsString();
        return JsonPath.read(body, "$.contest.slug");
    }

    private void setProblems(TestUser who, String slug, String... problemIds) throws Exception {
        StringBuilder list = new StringBuilder("[");
        for (int i = 0; i < problemIds.length; i++) {
            list.append(i > 0 ? "," : "").append("{\"problem_id\":\"").append(problemIds[i]).append("\"}");
        }
        mvc.perform(json(put("/api/v1/contests/" + slug + "/problems"), list.append("]").toString())
                        .header("Authorization", who.bearer()))
                .andExpect(status().isOk());
    }

    private void startNow(String slug) {
        jdbc.sql("UPDATE contests SET starts_at = now() - interval '5 minutes', ends_at = now() + interval '1 hour'"
                + " WHERE slug = ?").param(slug).update();
    }

    private void end(String slug) {
        jdbc.sql("UPDATE contests SET starts_at = now() - interval '3 hours', ends_at = now() - interval '1 hour'"
                + " WHERE slug = ?").param(slug).update();
    }

    @Test
    void authorsWriteProblemsThatOnlyTheyCanSeeAndCoAuthorsShareTheContestsProblems() throws Exception {
        TestUser ada = register();
        TestUser bob = register();
        String mine = problem(ada, true);
        String slug = contest(ada);

        // Someone else's hidden problem is invisible to bob, and cannot go into his contest.
        mvc.perform(get("/api/v1/studio/problems/" + mine).header("Authorization", bob.bearer()))
                .andExpect(status().isNotFound());
        String bobs = contest(bob);
        mvc.perform(json(put("/api/v1/contests/" + bobs + "/problems"), "[{\"problem_id\":\"" + mine + "\"}]")
                        .header("Authorization", bob.bearer()))
                .andExpect(status().isNotFound());
        mvc.perform(get("/api/v1/studio/problems").header("Authorization", bob.bearer()))
                .andExpect(jsonPath("$.items[*].id").value(Matchers.not(Matchers.hasItem(mine))));

        // A draft does not exist for outsiders; the owner adds authors, who then edit the contest's problems.
        mvc.perform(json(post("/api/v1/contests/" + slug + "/authors"), "{\"username\":\"" + ada.username() + "\"}")
                        .header("Authorization", bob.bearer()))
                .andExpect(status().isNotFound());
        mvc.perform(json(post("/api/v1/contests/" + slug + "/authors"), "{\"username\":\"" + bob.username() + "\"}")
                        .header("Authorization", ada.bearer()))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.contest.authors").value(Matchers.contains(ada.username(), bob.username())));
        TestUser cy = register();
        mvc.perform(json(post("/api/v1/contests/" + slug + "/authors"), "{\"username\":\"" + cy.username() + "\"}")
                        .header("Authorization", bob.bearer()))
                .andExpect(status().isForbidden());
        setProblems(ada, slug, mine);
        mvc.perform(get("/api/v1/studio/problems/" + mine).header("Authorization", bob.bearer()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.contests").value(Matchers.contains(slug)));
        String bobsOwn = problem(bob, true);
        setProblems(bob, slug, mine, bobsOwn);
        mvc.perform(get("/api/v1/contests/" + slug).header("Authorization", bob.bearer()))
                .andExpect(jsonPath("$.problems[*].label").value(Matchers.contains("A", "B")))
                .andExpect(jsonPath("$.problems[0].points").value(1));
        mvc.perform(get("/api/v1/contests/mine").header("Authorization", bob.bearer()))
                .andExpect(jsonPath("$[*].slug").value(Matchers.hasItems(slug, bobs)));
    }

    @Test
    void publishingNeedsJudgeableProblemsAndHidesThemUntilTheStart() throws Exception {
        TestUser ada = register();
        String slug = contest(ada);
        mvc.perform(json(post("/api/v1/contests/" + slug + "/publish"), "{}").header("Authorization", ada.bearer()))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.message").value(Matchers.containsString("at least one problem")));
        String untested = problem(ada, false);
        setProblems(ada, slug, untested);
        mvc.perform(json(post("/api/v1/contests/" + slug + "/publish"), "{}").header("Authorization", ada.bearer()))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.message").value(Matchers.containsString("problem A has no test cases")));
        String p = problem(ada, true);
        // Only contests put community problems into practice: the author cannot publish one directly.
        mvc.perform(json(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch(
                        "/api/v1/studio/problems/" + p), "{\"published\":true}").header("Authorization", ada.bearer()))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.message").value(Matchers.containsString("through a contest")));
        // One an admin published, then put in a contest: it leaves practice until the contest ends.
        jdbc.sql("UPDATE problems SET published = true WHERE id = ?::uuid").param(p).update();
        String problemSlug = jdbc.sql("SELECT slug FROM problems WHERE id = ?::uuid").param(p).query(String.class).single();
        mvc.perform(get("/api/v1/problems/" + problemSlug)).andExpect(status().isOk());
        setProblems(ada, slug, p);
        mvc.perform(json(post("/api/v1/contests/" + slug + "/publish"), "{}").header("Authorization", ada.bearer()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.contest.published").value(true));

        mvc.perform(get("/api/v1/problems/" + problemSlug)).andExpect(status().isNotFound());
        mvc.perform(get("/api/v1/problems").param("q", "Sum " + problemSlug))
                .andExpect(jsonPath("$.total").value(0));
        mvc.perform(get("/api/v1/contests").param("phase", "upcoming"))
                .andExpect(jsonPath("$.items[*].slug").value(Matchers.hasItem(slug)));
        mvc.perform(get("/api/v1/contests/" + slug))
                .andExpect(jsonPath("$.problems_visible").value(false))
                .andExpect(jsonPath("$.problems.length()").value(0));
        mvc.perform(get("/api/v1/contests/" + slug + "/problems/A")).andExpect(status().isNotFound());
        mvc.perform(get("/api/v1/contests/" + slug + "/standings")).andExpect(status().isConflict());
    }

    @Test
    void registeredUsersCompeteAndTheStandingsFollowTheVerdicts() throws Exception {
        TestUser host = register();
        String p = problem(host, true);
        String slug = contest(host);
        setProblems(host, slug, p);
        mvc.perform(json(post("/api/v1/contests/" + slug + "/publish"), "{}").header("Authorization", host.bearer()))
                .andExpect(status().isOk());

        TestUser cy = register();
        TestUser dee = register();
        mvc.perform(post("/api/v1/contests/" + slug + "/registration").header("Authorization", host.bearer()))
                .andExpect(status().isConflict());
        mvc.perform(post("/api/v1/contests/" + slug + "/registration").header("Authorization", cy.bearer()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.contest.registered").value(true))
                .andExpect(jsonPath("$.contest.participants").value(1));
        mvc.perform(json(post("/api/v1/contests/" + slug + "/submissions"),
                        "{\"label\":\"A\",\"language\":\"cpp17\",\"source_code\":\"%s\"}".formatted(CPP))
                        .header("Authorization", cy.bearer()))
                .andExpect(status().isConflict());

        startNow(slug);
        mvc.perform(get("/api/v1/contests/" + slug + "/problems/a"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.label").value("A"))
                .andExpect(jsonPath("$.problem.samples[0].input").value("1 2"));
        String body = mvc.perform(json(post("/api/v1/contests/" + slug + "/submissions"),
                        "{\"label\":\"A\",\"language\":\"cpp17\",\"source_code\":\"%s\"}".formatted(CPP))
                        .header("Authorization", cy.bearer()))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.in_contest").value(true))
                .andReturn().getResponse().getContentAsString();
        UUID sub = UUID.fromString(JsonPath.read(body, "$.submission_id"));
        assertThat(jdbc.sql("SELECT topic FROM outbox_events WHERE aggregate_id = ? ORDER BY id").param(sub)
                .query(String.class).list()).containsExactly("voidrun.contest-submissions", "voidrun.verdicts");
        assertThat(jdbc.sql("SELECT contest_elapsed_seconds FROM submissions WHERE id = ?").param(sub)
                .query(Integer.class).single()).isBetween(290, 310);

        // Not registered while it runs: refused, until a late registration.
        mvc.perform(json(post("/api/v1/contests/" + slug + "/submissions"),
                        "{\"label\":\"A\",\"language\":\"cpp17\",\"source_code\":\"%s\"}".formatted(CPP))
                        .header("Authorization", dee.bearer()))
                .andExpect(status().isForbidden());
        mvc.perform(post("/api/v1/contests/" + slug + "/registration").header("Authorization", dee.bearer()))
                .andExpect(status().isOk());

        mvc.perform(get("/api/v1/contests/" + slug + "/standings"))
                .andExpect(jsonPath("$.phase").value("RUNNING"))
                .andExpect(jsonPath("$.rows.length()").value(2))
                .andExpect(jsonPath("$.rows[?(@.participant.username == '%s')].cells[0].pending"
                        .formatted(cy.username())).value(Matchers.contains(1)));

        jdbc.sql("UPDATE submissions SET status = 'FINISHED', verdict = 'ACCEPTED', finished_at = now() WHERE id = ?")
                .param(sub).update();
        mvc.perform(get("/api/v1/contests/" + slug + "/standings"))
                .andExpect(jsonPath("$.rows[0].participant.username").value(cy.username()))
                .andExpect(jsonPath("$.rows[0].rank").value(1))
                .andExpect(jsonPath("$.rows[0].score").value(1))
                .andExpect(jsonPath("$.rows[0].penalty").value(5))
                .andExpect(jsonPath("$.rows[0].cells[0].first_solve").value(true))
                .andExpect(jsonPath("$.rows[1].rank").value(2));
        mvc.perform(get("/api/v1/contests/" + slug + "/submissions").header("Authorization", cy.bearer()))
                .andExpect(jsonPath("$[0].label").value("A"))
                .andExpect(jsonPath("$[0].in_contest").value(true));

        // After the end: the problem is practice, and submitting is upsolving.
        end(slug);
        String problemSlug = jdbc.sql("SELECT slug FROM problems WHERE id = ?::uuid").param(p).query(String.class).single();
        mvc.perform(get("/api/v1/problems/" + problemSlug)).andExpect(status().isOk());
        mvc.perform(json(post("/api/v1/contests/" + slug + "/submissions"),
                        "{\"label\":\"A\",\"language\":\"cpp17\",\"source_code\":\"%s\"}".formatted(CPP))
                        .header("Authorization", dee.bearer()))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.in_contest").value(false));
        mvc.perform(get("/api/v1/contests").param("phase", "past"))
                .andExpect(jsonPath("$.items[*].slug").value(Matchers.hasItem(slug)));
        mvc.perform(get("/api/v1/profiles/" + cy.username()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.contests[0].slug").value(slug))
                .andExpect(jsonPath("$.contests[0].rank").value(1))
                .andExpect(jsonPath("$.solved.total").value(1))
                .andExpect(jsonPath("$.current_streak").value(1))
                .andExpect(jsonPath("$.activity.length()").value(1))
                .andExpect(jsonPath("$.email").doesNotExist());
        // The joined list is the participant's; the host's lives under /mine.
        mvc.perform(get("/api/v1/contests/joined").header("Authorization", cy.bearer()))
                .andExpect(jsonPath("$[0].contest.slug").value(slug))
                .andExpect(jsonPath("$[0].contest.phase").value("ENDED"))
                .andExpect(jsonPath("$[0].rank").value(1))
                .andExpect(jsonPath("$[0].ranked").value(2))
                .andExpect(jsonPath("$[0].solved").value(1));
        mvc.perform(get("/api/v1/contests/joined").header("Authorization", host.bearer()))
                .andExpect(jsonPath("$.length()").value(0));
        // Each person's own rounds can be left out of the general lists.
        mvc.perform(get("/api/v1/contests").param("phase", "past").param("exclude", "hosted")
                        .header("Authorization", host.bearer()))
                .andExpect(jsonPath("$.items[*].slug").value(Matchers.not(Matchers.hasItem(slug))));
        mvc.perform(get("/api/v1/contests").param("phase", "past").param("exclude", "registered")
                        .header("Authorization", cy.bearer()))
                .andExpect(jsonPath("$.items[*].slug").value(Matchers.not(Matchers.hasItem(slug))));
        mvc.perform(get("/api/v1/contests").param("phase", "past").param("exclude", "hosted,registered")
                        .header("Authorization", register().bearer()))
                .andExpect(jsonPath("$.items[*].slug").value(Matchers.hasItem(slug)));
        mvc.perform(get("/api/v1/contests").param("exclude", "everything").header("Authorization", cy.bearer()))
                .andExpect(status().isBadRequest());
        mvc.perform(get("/api/v1/contests/joined")).andExpect(status().isUnauthorized());
    }

    @Test
    void theEditorialIsForAuthorsUntilTheEndAndThenOnTheContestAndTheProblem() throws Exception {
        TestUser host = register();
        String p = problem(host, true);
        String slug = contest(host);
        setProblems(host, slug, p);
        mvc.perform(json(post("/api/v1/contests/" + slug + "/publish"), "{}").header("Authorization", host.bearer()))
                .andExpect(status().isOk());
        mvc.perform(json(put("/api/v1/contests/" + slug + "/editorial"),
                        "{\"intro\":\"Thanks for playing.\",\"problems\":{\"a\":\"Add the numbers.\"}}")
                        .header("Authorization", host.bearer()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.intro").value("Thanks for playing."))
                .andExpect(jsonPath("$.problems[0].editorial").value("Add the numbers."))
                .andExpect(jsonPath("$.is_public").value(false));
        mvc.perform(json(put("/api/v1/contests/" + slug + "/editorial"), "{\"problems\":{\"Z\":\"x\"}}")
                        .header("Authorization", host.bearer()))
                .andExpect(status().isBadRequest());

        TestUser reader = register();
        startNow(slug);
        mvc.perform(get("/api/v1/contests/" + slug + "/editorial").header("Authorization", reader.bearer()))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("EDITORIAL_NOT_YET"));
        mvc.perform(get("/api/v1/contests/" + slug)).andExpect(jsonPath("$.editorial_available").value(false));
        String problemSlug = jdbc.sql("SELECT slug FROM problems WHERE id = ?::uuid").param(p).query(String.class).single();
        mvc.perform(get("/api/v1/contests/" + slug + "/problems/A"))
                .andExpect(jsonPath("$.problem.editorial").doesNotExist());

        end(slug);
        mvc.perform(get("/api/v1/contests/" + slug)).andExpect(jsonPath("$.editorial_available").value(true));
        mvc.perform(get("/api/v1/contests/" + slug + "/editorial"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.is_public").value(true))
                .andExpect(jsonPath("$.problems[0].label").value("A"));
        mvc.perform(get("/api/v1/problems/" + problemSlug))
                .andExpect(jsonPath("$.editorial.contest_slug").value(slug))
                .andExpect(jsonPath("$.editorial.label").value("A"))
                .andExpect(jsonPath("$.editorial.text").value("Add the numbers."));
    }

    @Test
    void peopleAndContestsCanBeSearched() throws Exception {
        TestUser ada = register();
        String part = ada.username().substring(1, 6);
        mvc.perform(get("/api/v1/profiles").param("q", part.toUpperCase()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[*].username").value(Matchers.hasItem(ada.username())))
                .andExpect(jsonPath("$[0].email").doesNotExist());
        mvc.perform(get("/api/v1/profiles").param("q", ada.username()))
                .andExpect(jsonPath("$[0].username").value(ada.username()));
        mvc.perform(get("/api/v1/profiles")).andExpect(jsonPath("$.length()").value(0));

        String p = problem(ada, true);
        String slug = contest(ada);
        setProblems(ada, slug, p);
        mvc.perform(json(post("/api/v1/contests/" + slug + "/publish"), "{}").header("Authorization", ada.bearer()))
                .andExpect(status().isOk());
        String title = jdbc.sql("SELECT title FROM contests WHERE slug = ?").param(slug).query(String.class).single();
        mvc.perform(get("/api/v1/contests").param("phase", "upcoming").param("q", title.substring(6)))
                .andExpect(jsonPath("$.items[*].slug").value(Matchers.contains(slug)));
    }

    @Test
    void draftsAreForTheirAuthorsAndOnlyTheOwnerDeletes() throws Exception {
        TestUser ada = register();
        TestUser bob = register();
        String slug = contest(ada);
        mvc.perform(get("/api/v1/contests/" + slug)).andExpect(status().isNotFound());
        mvc.perform(get("/api/v1/contests/" + slug).header("Authorization", bob.bearer()))
                .andExpect(status().isNotFound());
        mvc.perform(delete("/api/v1/contests/" + slug).header("Authorization", bob.bearer()))
                .andExpect(status().isNotFound());
        mvc.perform(json(post("/api/v1/contests"), "{\"title\":\"x\",\"starts_at\":\"%s\",\"duration_minutes\":5}"
                        .formatted(Instant.now().plus(1, ChronoUnit.DAYS))).header("Authorization", ada.bearer()))
                .andExpect(status().isBadRequest());
        mvc.perform(get("/api/v1/contests/mine")).andExpect(status().isUnauthorized());
        mvc.perform(delete("/api/v1/contests/" + slug).header("Authorization", ada.bearer()))
                .andExpect(status().isNoContent());
        assertThat(jdbc.sql("SELECT count(*) FROM contests WHERE slug = ?").param(slug).query(Long.class).single())
                .isZero();
    }
}
