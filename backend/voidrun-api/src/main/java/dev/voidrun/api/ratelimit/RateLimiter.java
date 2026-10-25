package dev.voidrun.api.ratelimit;

import dev.voidrun.api.config.VoidRunProperties;
import dev.voidrun.api.web.ApiException;
import java.time.Duration;
import java.util.HashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

/**
 * Fixed-window rate limiting in Redis, shared by every API instance.
 *
 * <p>Fails open: if Redis is unreachable the request is allowed and a warning
 * is logged. Redis holds no authoritative state here, and a limiter outage
 * should not become a sign-in outage.
 */
@Component
public class RateLimiter {

    private static final Logger log = LoggerFactory.getLogger(RateLimiter.class);

    record Rate(int max, int windowSeconds) {
        static Rate parse(String bucket, String spec) {
            String[] parts = spec.trim().split("/");
            try {
                Rate r = new Rate(Integer.parseInt(parts[0].trim()), Integer.parseInt(parts[1].trim()));
                if (r.max < 1 || r.windowSeconds < 1) throw new NumberFormatException();
                return r;
            } catch (RuntimeException e) {
                throw new IllegalStateException(
                        "voidrun.rate-limits." + bucket + " must look like <max>/<window seconds>, got " + spec);
            }
        }
    }

    private final StringRedisTemplate redis;
    private final Map<String, Rate> rates = new HashMap<>();

    public RateLimiter(StringRedisTemplate redis, VoidRunProperties props) {
        this.redis = redis;
        props.rateLimits().forEach((bucket, spec) -> rates.put(bucket, Rate.parse(bucket, spec)));
    }

    /** Throws 429 when {@code identity} has used up {@code bucket}; buckets without a configured rate are unlimited. */
    public void check(String bucket, String identity, String message) {
        Rate rate = rates.get(bucket);
        if (rate == null) {
            return;
        }
        long now = System.currentTimeMillis() / 1000;
        long window = now / rate.windowSeconds();
        String key = "voidrun:rl:" + bucket + ":" + identity + ":" + window;
        long count;
        try {
            Long n = redis.opsForValue().increment(key);
            if (n != null && n == 1) {
                redis.expire(key, Duration.ofSeconds(rate.windowSeconds() + 1L));
            }
            count = n == null ? 0 : n;
        } catch (RuntimeException e) {
            log.warn("rate limiter unavailable, allowing request: {}", e.toString());
            return;
        }
        if (count > rate.max()) {
            long retryAfter = Math.max(1, (window + 1) * rate.windowSeconds() - now);
            throw ApiException.tooManyRequests(message, retryAfter);
        }
    }
}
