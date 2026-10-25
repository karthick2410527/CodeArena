package dev.voidrun.api.web;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code /health} checks nothing, so a dependency hiccup never makes a load
 * balancer drop a working instance. {@code /ready} is 503 only when
 * PostgreSQL is unreachable; Redis is reported but optional, because the
 * rate limiter fails open without it.
 */
@RestController
@RequestMapping("/api/v1")
public class HealthController {

    private final JdbcClient jdbc;
    private final StringRedisTemplate redis;

    public HealthController(JdbcClient jdbc, StringRedisTemplate redis) {
        this.jdbc = jdbc;
        this.redis = redis;
    }

    @GetMapping("/health")
    Map<String, String> health() {
        return Map.of("status", "ok");
    }

    @GetMapping("/ready")
    ResponseEntity<Map<String, Object>> ready() {
        Map<String, Object> checks = new LinkedHashMap<>();
        boolean database = check(() -> jdbc.sql("SELECT 1").query(Integer.class).single());
        checks.put("status", database ? "ready" : "not_ready");
        checks.put("database", database);
        checks.put("redis", check(() -> redis.getConnectionFactory().getConnection().ping()));
        return ResponseEntity.status(database ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).body(checks);
    }

    private static boolean check(Runnable probe) {
        try {
            probe.run();
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }
}
