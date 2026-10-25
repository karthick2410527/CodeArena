package dev.voidrun.api.problems.importer;

import java.util.List;

/**
 * A problem read from another judge, to prefill the author's editor. Nothing
 * is saved until the author creates the problem, and the statement stays
 * credited to its source.
 *
 * @param platform   {@code codeforces} or {@code atcoder}
 * @param sourceId   the problem's id there, e.g. {@code 4A} or {@code abc300_a}
 * @param slug       a suggested slug for this judge
 * @param description the statement as Markdown, with Input, Output and Notes sections
 * @param constraints the constraints as Markdown (AtCoder lists them apart; Codeforces keeps them in the input)
 * @param warnings   what could not be read, for the author to fill in
 */
public record ImportedProblem(String platform, String sourceId, String sourceUrl, String slug, String title,
        String description, String constraints, String difficulty, int timeLimitMs, int memoryLimitMb,
        List<String> tags, List<Sample> samples, List<String> warnings) {

    public record Sample(String input, String output) {}
}
