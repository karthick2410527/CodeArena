package dev.voidrun.worker;

import static org.assertj.core.api.Assertions.assertThat;

import dev.voidrun.common.Topics;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Judging runs and submissions from Kafka against the seeded a-plus-b problem
 * (2 samples, 4 hidden tests), with the fake sandbox from the base class.
 */
class JudgeWorkerIntegrationTest extends WorkerIntegrationTestSupport {

    @Test
    void aRunIsJudgedAgainstEverySampleAndShowsTheOutput() throws Exception {
        UUID id = run(src("ok"), "SAMPLES", "");
        awaitStatus("runs", id, "FINISHED");

        assertThat(jdbc.sql("SELECT outcome FROM runs WHERE id = ?").param(id).query(String.class).single())
                .isEqualTo("OK");
        List<Map<String, Object>> cases = jdbc.sql("""
                        SELECT position, label, input, stdout, expected_output, exec_status, passed
                        FROM run_cases WHERE run_id = ? ORDER BY position""").param(id).query().listOfRows();
        assertThat(cases).hasSize(2);
        assertThat(cases.get(0)).containsEntry("label", "Sample 1").containsEntry("input", "3 5")
                .containsEntry("stdout", "8\n").containsEntry("expected_output", "8")
                .containsEntry("exec_status", "OK").containsEntry("passed", true);
        assertThat(cases.get(1)).containsEntry("label", "Sample 2").containsEntry("passed", true);
    }

    @Test
    void aCustomRunMakesNoClaimAboutCorrectness() throws Exception {
        UUID id = run(src("ok"), "CUSTOM", "40 2");
        awaitStatus("runs", id, "FINISHED");
        Map<String, Object> c = jdbc.sql("SELECT label, stdout, expected_output, passed FROM run_cases WHERE run_id = ?")
                .param(id).query().singleRow();
        assertThat(c).containsEntry("label", "Custom input").containsEntry("stdout", "42\n")
                .containsEntry("expected_output", null).containsEntry("passed", null);
    }

    @Test
    void aRunThatCrashesIsARuntimeErrorAndAWrongAnswerIsStillOk() throws Exception {
        UUID crash = run(src("crash"), "SAMPLES", "");
        UUID wrong = run(src("wrong"), "SAMPLES", "");
        awaitStatus("runs", crash, "FINISHED");
        awaitStatus("runs", wrong, "FINISHED");
        assertThat(outcome(crash)).isEqualTo("RUNTIME_ERROR");
        // A run reports what the program did; whether each answer was right is per case.
        assertThat(outcome(wrong)).isEqualTo("OK");
        assertThat(jdbc.sql("SELECT bool_or(passed) FROM run_cases WHERE run_id = ?").param(wrong)
                .query(Boolean.class).single()).isFalse();
    }

    @Test
    void aCorrectSubmissionIsAcceptedWithFullScore() throws Exception {
        UUID id = submit(src("ok"));
        awaitStatus("submissions", id, "FINISHED");
        Map<String, Object> s = submission(id);
        assertThat(s).containsEntry("verdict", "ACCEPTED").containsEntry("passed_tests", 6)
                .containsEntry("total_tests", 6).containsEntry("failed_case_position", null)
                .containsEntry("claimed_by", "test-worker");
        assertThat(s.get("score")).isEqualTo(s.get("max_score"));
        assertThat((Integer) s.get("max_time_ms")).isPositive();
        assertThat(results(id)).hasSize(6).allSatisfy(r -> assertThat(r).containsEntry("verdict", "ACCEPTED"));
    }

    @Test
    void theFirstFailingTestDecidesTheVerdictAndJudgingStopsThere() throws Exception {
        UUID wrong = submit(src("wrong"));
        UUID slow = submit(src("slow-on-3"));
        awaitStatus("submissions", wrong, "FINISHED");
        awaitStatus("submissions", slow, "FINISHED");

        assertThat(submission(wrong)).containsEntry("verdict", "WRONG_ANSWER").containsEntry("passed_tests", 0)
                .containsEntry("failed_case_position", 1);
        assertThat(results(wrong)).hasSize(1);

        assertThat(submission(slow)).containsEntry("verdict", "TIME_LIMIT_EXCEEDED").containsEntry("passed_tests", 2)
                .containsEntry("failed_case_position", 3);
        assertThat(results(slow)).extracting(r -> r.get("verdict"))
                .containsExactly("ACCEPTED", "ACCEPTED", "TIME_LIMIT_EXCEEDED");
    }

    @Test
    void aCompileErrorIsReportedWithTheDiagnostics() throws Exception {
        UUID sub = submit(src("compile-error"));
        UUID run = run(src("compile-error"), "SAMPLES", "");
        awaitStatus("submissions", sub, "FINISHED");
        awaitStatus("runs", run, "FINISHED");
        assertThat(submission(sub)).containsEntry("verdict", "COMPILATION_ERROR")
                .containsEntry("compile_output", "main.cpp:1:1: error: expected unqualified-id")
                .containsEntry("total_tests", 6);
        assertThat(results(sub)).isEmpty();
        assertThat(outcome(run)).isEqualTo("COMPILATION_ERROR");
    }

    @Test
    void aDuplicateDeliveryIsNotJudgedTwice() throws Exception {
        String source = src("ok");
        UUID id = submit(source, false);
        publish(Topics.SUBMISSIONS, id.toString(), job("SUBMISSION", id));
        publish(Topics.SUBMISSIONS, id.toString(), job("SUBMISSION", id));
        // Same key, same partition: once this is judged, both copies before it were consumed.
        UUID marker = submit(src("ok"), false);
        publish(Topics.SUBMISSIONS, id.toString(), job("SUBMISSION", marker));

        awaitStatus("submissions", marker, "FINISHED");
        assertThat(sandbox.opensFor(source)).isEqualTo(1);
        assertThat(submission(id)).containsEntry("attempts", 1);
        assertThat(results(id)).hasSize(6);
    }

    @Test
    void aSandboxFailureIsRetriedAndThenSucceeds() throws Exception {
        String source = src("sandbox-flaky");
        UUID id = submit(source);
        awaitStatus("submissions", id, "FINISHED");
        assertThat(submission(id)).containsEntry("verdict", "ACCEPTED").containsEntry("attempts", 2);
        assertThat(sandbox.opensFor(source)).isEqualTo(2);
    }

    @Test
    void aSandboxThatNeverComesBackEndsAsAnInternalErrorAndADeadLetter() throws Exception {
        String source = src("sandbox-down");
        UUID sub = submit(source);
        UUID run = run(source, "SAMPLES", "");
        awaitStatus("submissions", sub, "FINISHED");
        awaitStatus("runs", run, "FINISHED");

        assertThat(submission(sub)).containsEntry("verdict", "INTERNAL_ERROR");
        assertThat((String) submission(sub).get("internal_error")).contains("Cannot connect to the Docker daemon");
        assertThat(outcome(run)).isEqualTo("INTERNAL_ERROR");
        assertThat(sandbox.opensFor(source)).isEqualTo(6); // three attempts each
        assertThat(jdbc.sql("SELECT event_type FROM dead_letter_events WHERE submission_id = ?").param(sub)
                .query(String.class).single()).isEqualTo("submission.created");
    }

    @Test
    void aMalformedJobIsDeadLetteredWithoutRetries() throws Exception {
        UUID id = submit(src("ok"), false);
        publish(Topics.SUBMISSIONS, id.toString(), "{\"version\":1,\"kind\":\"RUN\",\"id\":\"" + id + "\"}");
        awaitStatus("submissions", id, "FINISHED");
        assertThat(submission(id)).containsEntry("verdict", "INTERNAL_ERROR").containsEntry("attempts", 0);
    }

    @Test
    void aContestSubmissionIsJudgedFromItsOwnTopicAndItsVerdictIsAnnounced() throws Exception {
        UUID user = newUser();
        UUID contest = jdbc.sql("""
                        INSERT INTO contests (slug, title, starts_at, ends_at, published)
                        VALUES (?, 'Live', now() - interval '10 minutes', now() + interval '1 hour', true)
                        RETURNING id""")
                .param("c-" + UUID.randomUUID()).query(UUID.class).single();
        jdbc.sql("INSERT INTO contest_problems (contest_id, problem_id, label, position) VALUES (?, ?, 'A', 0)")
                .params(contest, problem()).update();
        UUID id = jdbc.sql("""
                        INSERT INTO submissions (user_id, problem_id, language, source_code, contest_id,
                                                 contest_elapsed_seconds)
                        VALUES (?, ?, 'cpp17', ?, ?, 600) RETURNING id""")
                .params(user, problem(), src("ok"), contest).query(UUID.class).single();
        publish(Topics.CONTEST_SUBMISSIONS, id.toString(), job("SUBMISSION", id));

        awaitStatus("submissions", id, "FINISHED");
        assertThat(submission(id)).containsEntry("verdict", "ACCEPTED");
        Map<String, Object> event = jdbc.sql("""
                        SELECT topic, message_key, event_type, payload->>'verdict' AS verdict,
                               payload->>'submissionId' AS submission
                        FROM outbox_events WHERE aggregate_id = ?""").param(id).query().singleRow();
        assertThat(event).containsEntry("topic", "voidrun.verdicts").containsEntry("message_key", contest.toString())
                .containsEntry("event_type", "verdict.decided").containsEntry("verdict", "ACCEPTED")
                .containsEntry("submission", id.toString());
    }

    @Test
    void aPracticeSubmissionAnnouncesNothing() throws Exception {
        UUID id = submit(src("ok"));
        awaitStatus("submissions", id, "FINISHED");
        assertThat(jdbc.sql("SELECT count(*) FROM outbox_events WHERE aggregate_id = ?").param(id)
                .query(Long.class).single()).isZero();
    }

    // ---- helpers ---------------------------------------------------------------

    private static String src(String behaviour) {
        return "int main(){} // " + behaviour + " " + UUID.randomUUID();
    }

    private UUID problem() {
        return jdbc.sql("SELECT id FROM problems WHERE slug = 'a-plus-b'").query(UUID.class).single();
    }

    private UUID run(String source, String mode, String stdin) throws Exception {
        UUID id = jdbc.sql("""
                        INSERT INTO runs (user_id, problem_id, language, source_code, mode, stdin, expires_at)
                        VALUES (?, ?, 'cpp17', ?, ?, ?, now() + interval '1 day') RETURNING id""")
                .params(newUser(), problem(), source, mode, stdin).query(UUID.class).single();
        publish(Topics.RUNS, id.toString(), job("RUN", id));
        return id;
    }

    private UUID submit(String source) throws Exception {
        return submit(source, true);
    }

    private UUID submit(String source, boolean publish) throws Exception {
        UUID id = jdbc.sql("""
                        INSERT INTO submissions (user_id, problem_id, language, source_code)
                        VALUES (?, ?, 'cpp17', ?) RETURNING id""")
                .params(newUser(), problem(), source).query(UUID.class).single();
        if (publish) {
            publish(Topics.SUBMISSIONS, id.toString(), job("SUBMISSION", id));
        }
        return id;
    }

    private static String job(String kind, UUID id) {
        return "{\"version\":1,\"kind\":\"" + kind + "\",\"id\":\"" + id + "\",\"correlationId\":\"test\"}";
    }

    private String outcome(UUID run) {
        return jdbc.sql("SELECT outcome FROM runs WHERE id = ?").param(run).query(String.class).single();
    }

    private Map<String, Object> submission(UUID id) {
        return jdbc.sql("SELECT * FROM submissions WHERE id = ?").param(id).query().singleRow();
    }

    private List<Map<String, Object>> results(UUID id) {
        return jdbc.sql("SELECT verdict, position FROM submission_results WHERE submission_id = ? ORDER BY position")
                .param(id).query().listOfRows();
    }
}
