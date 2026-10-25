package dev.voidrun.common;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class LanguageTest {

    @Test
    void wireIdsAreStable() {
        // Stored with every submission: changing one orphans history.
        assertEquals(List.of("cpp17", "java21", "node22"), Language.ids());
    }

    @Test
    void findTrimsAndRejectsUnknown() {
        assertEquals(Language.JAVA21, Language.find(" java21 ").orElseThrow());
        assertTrue(Language.find("python3").isEmpty());
        assertTrue(Language.find(null).isEmpty());
    }

    @Test
    void onlyContestantMistakesArePenalised() {
        assertTrue(Verdict.WRONG_ANSWER.isPenalised());
        assertTrue(Verdict.TIME_LIMIT_EXCEEDED.isPenalised());
        assertFalse(Verdict.ACCEPTED.isPenalised());
        assertFalse(Verdict.COMPILATION_ERROR.isPenalised());
        assertFalse(Verdict.INTERNAL_ERROR.isPenalised());
    }
}
