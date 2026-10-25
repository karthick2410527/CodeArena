package dev.voidrun.worker.judge;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class OutputCompareTest {

    @Test
    void whitespaceAtLineEndsAndTheEndIsHowItPrintedNotWhatItSaid() {
        assertThat(OutputCompare.matches("8", "8\n")).isTrue();
        assertThat(OutputCompare.matches("1 2  \r\n3\t\n\n\n", "1 2\n3")).isTrue();
        assertThat(OutputCompare.matches("", "\n \n")).isTrue();
    }

    @Test
    void anythingElseMustMatchExactly() {
        assertThat(OutputCompare.matches("12", "1 2")).isFalse();
        assertThat(OutputCompare.matches("0.50", "0.5")).isFalse();
        assertThat(OutputCompare.matches(" 8", "8")).isFalse();
        assertThat(OutputCompare.matches("1\n\n2", "1\n2")).isFalse();
    }
}
