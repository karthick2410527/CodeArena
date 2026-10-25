package dev.voidrun.api.contests;

import static org.assertj.core.api.Assertions.assertThat;

import dev.voidrun.api.contests.Standings.Format;
import dev.voidrun.api.contests.Standings.Participant;
import dev.voidrun.api.contests.Standings.Problem;
import dev.voidrun.api.contests.Standings.Row;
import dev.voidrun.api.contests.Standings.Submission;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class StandingsTest {

    static final Participant ADA = p("ada");
    static final Participant BOB = p("bob");
    static final Participant CY = p("cy");
    static final List<Problem> AB = List.of(new Problem("A", 500), new Problem("B", 1000));

    static Participant p(String name) {
        return new Participant(UUID.nameUUIDFromBytes(name.getBytes()), name, null, null);
    }

    static Submission s(Participant who, String label, String verdict, int minute) {
        return new Submission(who.userId(), label, "FINISHED", verdict, minute * 60, 0, 0);
    }

    static Row row(List<Row> rows, Participant who) {
        return rows.stream().filter(r -> r.participant().equals(who)).findFirst().orElseThrow();
    }

    @Test
    void codeforcesPointsDecayPerMinuteAndPerWrongTryButNeverBelowThirty() {
        assertThat(Standings.codeforcesPoints(500, 0, 0)).isEqualTo(500);
        // 500 - 2*10 - 50 = 430
        assertThat(Standings.codeforcesPoints(500, 10 * 60 + 59, 1)).isEqualTo(430);
        assertThat(Standings.codeforcesPoints(1000, 119 * 60, 10)).isEqualTo(300);
    }

    @Test
    void codeforcesRanksByPointsAndCompileErrorsCostNothing() {
        List<Row> rows = Standings.compute(Format.CODEFORCES, AB, List.of(ADA, BOB, CY), List.of(
                s(ADA, "A", "COMPILATION_ERROR", 1),
                s(ADA, "A", "ACCEPTED", 5),            // 500 - 10 = 490
                s(BOB, "A", "WRONG_ANSWER", 2),
                s(BOB, "A", "ACCEPTED", 4),            // 500 - 8 - 50 = 442
                s(BOB, "B", "ACCEPTED", 30),           // 1000 - 120 = 880
                s(ADA, "B", "WRONG_ANSWER", 60)));
        assertThat(rows).extracting(r -> r.participant().username()).containsExactly("bob", "ada", "cy");
        assertThat(row(rows, BOB).score()).isEqualTo(442 + 880);
        assertThat(row(rows, ADA).score()).isEqualTo(490);
        assertThat(row(rows, ADA).cells().get(0).wrong()).isZero();
        assertThat(row(rows, ADA).cells().get(1).wrong()).isEqualTo(1);
        assertThat(row(rows, CY).rank()).isEqualTo(3);
        assertThat(row(rows, ADA).cells().get(0).firstSolve()).isFalse();
        assertThat(row(rows, BOB).cells().get(0).firstSolve()).isTrue();
    }

    @Test
    void icpcCountsSolvesThenPenaltyMinutesAndSharesTies() {
        List<Row> rows = Standings.compute(Format.ICPC, AB, List.of(ADA, BOB, CY), List.of(
                s(ADA, "A", "WRONG_ANSWER", 3),
                s(ADA, "A", "ACCEPTED", 10),           // 10 + 20 = 30
                s(ADA, "B", "ACCEPTED", 50),           // 50          -> 80
                s(BOB, "A", "ACCEPTED", 20),
                s(BOB, "B", "ACCEPTED", 60),           // 20 + 60     -> 80
                s(BOB, "B", "WRONG_ANSWER", 70),       // after the solve: ignored
                s(CY, "A", "ACCEPTED", 1)));
        assertThat(row(rows, ADA)).extracting(Row::score, Row::penalty, Row::rank).containsExactly(2, 80, 1);
        assertThat(row(rows, BOB)).extracting(Row::score, Row::penalty, Row::rank).containsExactly(2, 80, 1);
        assertThat(row(rows, CY).rank()).isEqualTo(3);
        assertThat(row(rows, ADA).cells().get(1).score()).isNull();
    }

    @Test
    void atcoderBreaksTiesByLastSolvePlusFiveMinutesPerWrongTry() {
        List<Problem> problems = List.of(new Problem("A", 100), new Problem("B", 200));
        List<Row> rows = Standings.compute(Format.ATCODER, problems, List.of(ADA, BOB), List.of(
                s(ADA, "A", "ACCEPTED", 2),
                s(ADA, "B", "RUNTIME_ERROR", 5),
                s(ADA, "B", "ACCEPTED", 20),           // last 20:00 + 5:00 -> 1500 s
                s(BOB, "B", "ACCEPTED", 22),
                s(BOB, "A", "ACCEPTED", 23)));         // last 23:00        -> 1380 s
        assertThat(rows).extracting(r -> r.participant().username()).containsExactly("bob", "ada");
        assertThat(row(rows, ADA)).extracting(Row::score, Row::penalty).containsExactly(300, 1500);
        assertThat(row(rows, BOB)).extracting(Row::score, Row::penalty).containsExactly(300, 1380);
    }

    @Test
    void ioiTakesTheBestPartialScorePerProblem() {
        List<Problem> problems = List.of(new Problem("A", 100));
        List<Row> rows = Standings.compute(Format.IOI, problems, List.of(ADA, BOB), List.of(
                new Submission(ADA.userId(), "A", "FINISHED", "WRONG_ANSWER", 60, 3, 10),
                new Submission(ADA.userId(), "A", "FINISHED", "TIME_LIMIT_EXCEEDED", 120, 7, 10),
                new Submission(ADA.userId(), "A", "FINISHED", "WRONG_ANSWER", 180, 2, 10),
                new Submission(BOB.userId(), "A", "FINISHED", "ACCEPTED", 300, 10, 10)));
        assertThat(row(rows, ADA).score()).isEqualTo(70);
        assertThat(row(rows, BOB).score()).isEqualTo(100);
        assertThat(row(rows, BOB).rank()).isEqualTo(1);
    }

    @Test
    void submissionsStillBeingJudgedArePending() {
        List<Row> rows = Standings.compute(Format.ICPC, AB, List.of(ADA), List.of(
                s(ADA, "A", "WRONG_ANSWER", 1),
                new Submission(ADA.userId(), "A", "RUNNING", null, 120, 0, 0)));
        assertThat(row(rows, ADA).cells().get(0)).extracting(Standings.Cell::pending, Standings.Cell::wrong,
                Standings.Cell::solved).containsExactly(1, 1, false);
    }
}
