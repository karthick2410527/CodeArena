package dev.voidrun.api.contests;

import dev.voidrun.common.Topics;
import dev.voidrun.common.events.VerdictEvent;
import java.io.IOException;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.json.JsonMapper;

/**
 * Live contest updates over Server-Sent Events.
 *
 * <p>Every API instance consumes {@code voidrun.verdicts} in a consumer group
 * of its own (a fresh id per process), so each instance sees every verdict and
 * tells the browsers connected to it; Kafka is the broadcast bus between
 * instances. The event only says that something changed and for whom; the
 * page then refetches the standings, which are always computed from the
 * database, so a dropped event costs freshness, never correctness.
 */
@RestController
public class LiveStandings {

    private static final Logger log = LoggerFactory.getLogger(LiveStandings.class);

    private final ContestController contests;
    private final Map<UUID, Set<SseEmitter>> watchers = new ConcurrentHashMap<>();
    private final JsonMapper json = JsonMapper.builder().build();

    public LiveStandings(ContestController contests) {
        this.contests = contests;
    }

    @GetMapping(path = "/api/v1/contests/{slug}/live", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    SseEmitter live(@AuthenticationPrincipal Jwt jwt, @PathVariable String slug) throws IOException {
        UUID contestId = contests.visible(slug, jwt).id();
        SseEmitter emitter = new SseEmitter(0L);
        Set<SseEmitter> set = watchers.computeIfAbsent(contestId, id -> ConcurrentHashMap.newKeySet());
        set.add(emitter);
        Runnable drop = () -> set.remove(emitter);
        emitter.onCompletion(drop);
        emitter.onTimeout(drop);
        emitter.onError(e -> drop.run());
        emitter.send(SseEmitter.event().name("hello").data("{}"));
        return emitter;
    }

    @KafkaListener(topics = Topics.VERDICTS, groupId = "voidrun-live-#{T(java.util.UUID).randomUUID().toString()}",
            properties = "auto.offset.reset=latest")
    void onVerdict(String value) {
        VerdictEvent e;
        try {
            e = json.readValue(value, VerdictEvent.class);
        } catch (JacksonException ex) {
            log.warn("ignoring unreadable verdict event: {}", ex.getOriginalMessage());
            return;
        }
        if (e.contestId() == null) {
            return;
        }
        String data = "{\"submission_id\":\"" + e.submissionId() + "\",\"user_id\":\"" + e.userId()
                + "\",\"verdict\":" + (e.verdict() == null ? "null" : "\"" + e.verdict() + "\"") + "}";
        broadcast(e.contestId(), SseEmitter.event().name("standings").data(data));
    }

    /** Keeps idle connections open through proxies that close silent ones. */
    @Scheduled(fixedDelay = 20_000)
    void heartbeat() {
        watchers.keySet().forEach(id -> broadcast(id, SseEmitter.event().comment("ping")));
    }

    int watching(UUID contestId) {
        Set<SseEmitter> set = watchers.get(contestId);
        return set == null ? 0 : set.size();
    }

    private void broadcast(UUID contestId, SseEmitter.SseEventBuilder event) {
        Set<SseEmitter> set = watchers.get(contestId);
        if (set == null) {
            return;
        }
        for (SseEmitter emitter : set) {
            try {
                emitter.send(event);
            } catch (IOException | IllegalStateException ex) {
                set.remove(emitter);
                emitter.completeWithError(ex);
            }
        }
        if (set.isEmpty()) {
            watchers.remove(contestId, set);
        }
    }
}
