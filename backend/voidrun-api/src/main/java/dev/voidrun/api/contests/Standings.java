package dev.voidrun.api.contests;

import dev.voidrun.common.Verdict;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Contest standings, computed from a contest's submissions in order. Pure: no
 * database, no clock, so every scoring rule is tested with worked examples.
 *
 * <p>Common rules: only submissions made during the contest count (the caller
 * passes those); a compile error or a judge failure is never a penalty; after a
 * problem is accepted, later submissions to it change nothing, except under IOI,
 * where the best score counts. A submission still being judged shows as pending.
 */
public final class Standings {

    public enum Format {
        /** Points decay with time; 50 per wrong try; at least 30% of a solved problem's points. */
        CODEFORCES,
        /** Problems solved, then penalty: minutes to each solve plus 20 per earlier wrong try. */
        ICPC,
        /** Points of solved problems, then the time of the last solve plus 5 minutes per wrong try. */
        ATCODER,
        /** Each problem's best partial score: the share of test points passed. No time penalty. */
        IOI
    }

    public record Problem(String label, int points) {}

    public record Participant(UUID userId, String username, String displayName, String avatarUrl) {}

    /**
     * @param status   QUEUED / RUNNING / FINISHED
     * @param verdict  null until finished
     * @param elapsedSeconds since the contest started
     * @param score    test points passed, and {@code maxScore} the problem's total (for IOI)
     */
    public record Submission(UUID userId, String label, String status, String verdict, int elapsedSeconds, int score,
            int maxScore) {}

    /**
     * @param wrong        penalised tries before the first acceptance (or all, if unsolved)
     * @param solvedAt     seconds into the contest of the first acceptance, or null
     * @param score        points this problem gives (null for ICPC)
     * @param firstSolve   the first accepted solution of this problem in the contest
     */
    public record Cell(String label, boolean solved, int wrong, int pending, Integer solvedAt, Integer score,
            boolean firstSolve) {}

    /** @param penalty ICPC: minutes; ATCODER: seconds; otherwise null */
    public record Row(int rank, Participant participant, int score, Integer penalty, int solved, List<Cell> cells) {}

    private Standings() {}

    public static List<Row> compute(Format format, List<Problem> problems, List<Participant> participants,
            List<Submission> submissions) {
        Map<UUID, Map<String, Acc>> acc = new HashMap<>();
        Map<String, Integer> firstSolveAt = new HashMap<>();
        for (Submission s : submissions) {
            Acc a = acc.computeIfAbsent(s.userId(), u -> new HashMap<>()).computeIfAbsent(s.label(), l -> new Acc());
            a.add(format, s);
        }
        for (Map<String, Acc> cells : acc.values()) {
            cells.forEach((label, a) -> {
                if (a.solvedAt != null) {
                    firstSolveAt.merge(label, a.solvedAt, Math::min);
                }
            });
        }

        List<Row> rows = new ArrayList<>(participants.size());
        for (Participant p : participants) {
            Map<String, Acc> mine = acc.getOrDefault(p.userId(), Map.of());
            List<Cell> cells = new ArrayList<>(problems.size());
            int score = 0;
            int solved = 0;
            int penalty = 0;
            int lastSolve = 0;
            int wrongOnSolved = 0;
            for (Problem pr : problems) {
                Acc a = mine.getOrDefault(pr.label(), new Acc());
                Integer cellScore = switch (format) {
                    case ICPC -> null;
                    case CODEFORCES -> a.solvedAt == null ? 0 : codeforcesPoints(pr.points(), a.solvedAt, a.wrong);
                    case ATCODER -> a.solvedAt == null ? 0 : pr.points();
                    case IOI -> (int) Math.round(a.bestShare * pr.points());
                };
                if (a.solvedAt != null) {
                    solved++;
                    penalty += a.solvedAt / 60 + 20 * a.wrong;
                    lastSolve = Math.max(lastSolve, a.solvedAt);
                    wrongOnSolved += a.wrong;
                }
                if (cellScore != null) {
                    score += cellScore;
                }
                cells.add(new Cell(pr.label(), a.solvedAt != null, a.wrong, a.pending, a.solvedAt, cellScore,
                        a.solvedAt != null && a.solvedAt.equals(firstSolveAt.get(pr.label()))));
            }
            Integer shownPenalty = switch (format) {
                case ICPC -> penalty;
                case ATCODER -> solved == 0 ? 0 : lastSolve + 300 * wrongOnSolved;
                default -> null;
            };
            rows.add(new Row(0, p, format == Format.ICPC ? solved : score, shownPenalty, solved, cells));
        }

        Comparator<Row> order = switch (format) {
            case ICPC, ATCODER -> Comparator.comparingInt(Row::score).reversed()
                    .thenComparingInt(r -> r.penalty() == null ? 0 : r.penalty());
            case CODEFORCES, IOI -> Comparator.comparingInt(Row::score).reversed();
        };
        // Ties share a rank (1, 2, 2, 4); within a tie, names keep the order stable.
        rows.sort(order.thenComparing(r -> r.participant().username()));
        List<Row> ranked = new ArrayList<>(rows.size());
        for (int i = 0; i < rows.size(); i++) {
            Row r = rows.get(i);
            int rank = i > 0 && order.compare(rows.get(i - 1), r) == 0 ? ranked.get(i - 1).rank() : i + 1;
            ranked.add(new Row(rank, r.participant(), r.score(), r.penalty(), r.solved(), r.cells()));
        }
        return ranked;
    }

    /**
     * Codeforces' decay: {@code max(0.3·P, P − P/250 · minutes − 50 · wrong)},
     * with minutes whole minutes into the contest.
     */
    static int codeforcesPoints(int points, int solvedAtSeconds, int wrong) {
        int minutes = solvedAtSeconds / 60;
        double decayed = points - points / 250.0 * minutes - 50.0 * wrong;
        return (int) Math.round(Math.max(0.3 * points, decayed));
    }

    /** Default points for the problem at {@code index} (0 = A) under a format. */
    public static int defaultPoints(Format format, int index) {
        return switch (format) {
            case CODEFORCES -> 500 * (index + 1);
            case ATCODER -> 100 * (index + 1);
            case IOI -> 100;
            case ICPC -> 1;
        };
    }

    /** One participant's history on one problem. */
    private static final class Acc {
        int wrong;
        int pending;
        Integer solvedAt;
        double bestShare;

        void add(Format format, Submission s) {
            if (!"FINISHED".equals(s.status()) || s.verdict() == null) {
                if (solvedAt == null || format == Format.IOI) {
                    pending++;
                }
                return;
            }
            Verdict v = Verdict.valueOf(s.verdict());
            if (format == Format.IOI) {
                if (v != Verdict.COMPILATION_ERROR && v != Verdict.INTERNAL_ERROR && s.maxScore() > 0) {
                    bestShare = Math.max(bestShare, (double) s.score() / s.maxScore());
                }
                if (v == Verdict.ACCEPTED && solvedAt == null) {
                    solvedAt = s.elapsedSeconds();
                }
                return;
            }
            if (solvedAt != null) {
                return; // solved already: nothing later changes this problem
            }
            if (v == Verdict.ACCEPTED) {
                solvedAt = s.elapsedSeconds();
            } else if (v.isPenalised()) {
                wrong++;
            }
        }
    }
}
