package dev.voidrun.api.contests;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/** The contests a user registered for, with their final (or current) place, for profiles. */
@Component
public class ContestHistory {

    static final int LIMIT = 20;

    /** @param rank null before the contest starts */
    public record Entry(String slug, String title, String format, Instant startsAt, String phase, Integer rank,
            int participants, int solved, int score) {}

    private final JdbcClient jdbc;
    private final ContestController contests;

    public ContestHistory(JdbcClient jdbc, ContestController contests) {
        this.jdbc = jdbc;
        this.contests = contests;
    }

    public List<Entry> of(UUID userId) {
        List<String> slugs = jdbc.sql("""
                        SELECT c.slug FROM contests c
                        JOIN contest_registrations r ON r.contest_id = c.id AND r.user_id = ?
                        WHERE c.published ORDER BY c.starts_at DESC LIMIT ?""")
                .params(userId, LIMIT)
                .query(String.class)
                .list();
        Instant now = Instant.now();
        List<Entry> out = new ArrayList<>(slugs.size());
        for (String slug : slugs) {
            ContestController.Row c = contests.visible(slug, null);
            String phase = c.phase(now);
            if (phase.equals("UPCOMING")) {
                out.add(new Entry(c.slug(), c.title(), c.format(), c.startsAt(), phase, null, (int) c.participants(),
                        0, 0));
                continue;
            }
            ContestController.StandingsView s = contests.standingsOf(c, now);
            Standings.Row mine = s.rows().stream().filter(r -> r.participant().userId().equals(userId)).findFirst()
                    .orElse(null);
            out.add(new Entry(c.slug(), c.title(), c.format(), c.startsAt(), phase, mine == null ? null : mine.rank(),
                    s.rows().size(), mine == null ? 0 : mine.solved(), mine == null ? 0 : mine.score()));
        }
        return out;
    }
}
