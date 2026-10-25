package dev.voidrun.api.problems.importer;

import java.util.List;

/**
 * A problem's editorial read from its judge, to prefill the contest editorial.
 *
 * @param text        the write-up as Markdown; empty when only the link was found
 * @param editorialUrl where it was read from, kept as credit
 */
public record ImportedEditorial(String text, String editorialUrl, List<String> warnings) {}
