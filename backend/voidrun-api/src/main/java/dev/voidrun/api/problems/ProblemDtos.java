package dev.voidrun.api.problems;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** Problem shapes. Public ones never carry hidden test data. Serialized snake_case. */
public final class ProblemDtos {

    private ProblemDtos() {}

    /**
     * @param solvedBy       distinct users with an accepted submission
     * @param acceptanceRate accepted ÷ judged submissions (compile errors excluded), in percent; null before any
     * @param status         the caller's SOLVED / ATTEMPTED, or null (or signed out)
     * @param author         the community author's username; null for the platform's own problems
     */
    public record ProblemSummary(
            long number, String slug, String title, String difficulty, int timeLimitMs, int memoryLimitMb,
            List<String> tags, long solvedBy, Double acceptanceRate, String status, String author) {}

    public record Sample(String input, String expectedOutput, String explanation) {}

    public record ProblemDetail(
            long number, String slug, String title, String difficulty, int timeLimitMs, int memoryLimitMb,
            List<String> tags, String description, String constraints, List<Sample> samples, long solvedBy,
            Double acceptanceRate, String status, String author, ProblemEditorial editorial, String sourceUrl) {}

    /** A finished contest's write-up for this problem. */
    public record ProblemEditorial(String contestSlug, String contestTitle, String label, String text) {}

    public record TagCount(String name, long count) {}

    public record AdminProblem(
            UUID id, long number, String slug, String title, String description, String constraints,
            String difficulty, int timeLimitMs, int memoryLimitMb, boolean published, List<String> tags,
            long sampleCount, long hiddenCount, long submissionCount, Instant createdAt, Instant updatedAt,
            String owner, List<String> contests, String sourceUrl) {}

    /** Create body, or a PATCH body where a null field means "leave unchanged". */
    public record ProblemInput(
            String slug, String title, String description, String constraints, String difficulty,
            Integer timeLimitMs, Integer memoryLimitMb, Boolean published, List<String> tags, String sourceUrl) {}

    public record AdminTestCase(
            UUID id, int position, String input, String expectedOutput, String explanation, boolean isSample,
            int points) {}

    /** Create body, or a PATCH body where a null field means "leave unchanged". */
    public record TestCaseInput(
            String input, String expectedOutput, String explanation, Boolean isSample, Integer points,
            Integer position) {}
}
