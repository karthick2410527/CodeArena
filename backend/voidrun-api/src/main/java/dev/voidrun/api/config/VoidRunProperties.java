package dev.voidrun.api.config;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Everything VoidRun-specific in {@code application.yml}, under {@code voidrun.*}.
 *
 * @param frontendUrl where provider sign-ins return the browser to
 * @param jwt         access and refresh token settings
 * @param oauth       provider credentials; a provider without both id and secret is disabled
 * @param limits      size limits on code and input
 * @param rateLimits  per-bucket limits as {@code "<max>/<window seconds>"}, e.g. {@code login: 10/60}
 * @param runRetention how long a Run's output is kept
 * @param outbox      the relay that delivers outbox events to Kafka
 * @param replay      execution recordings for step-through replay
 * @param billing     Host plans and the Razorpay account that takes payment for them
 */
@ConfigurationProperties("voidrun")
public record VoidRunProperties(
        String frontendUrl,
        Jwt jwt,
        Map<String, OAuthClient> oauth,
        Limits limits,
        Map<String, String> rateLimits,
        Duration runRetention,
        Outbox outbox,
        Replay replay,
        Billing billing) {

    public VoidRunProperties {
        frontendUrl = frontendUrl == null ? "http://localhost:5173" : frontendUrl.replaceAll("/+$", "");
        oauth = oauth == null ? Map.of() : Map.copyOf(oauth);
        rateLimits = rateLimits == null ? Map.of() : Map.copyOf(rateLimits);
        runRetention = runRetention == null ? Duration.ofHours(24) : runRetention;
        outbox = outbox == null ? new Outbox(true, 100, 3, 1) : outbox;
        replay = replay == null ? new Replay(Duration.ofDays(7)) : replay;
        billing = billing == null ? new Billing(true, true, null, null) : billing;
        if (jwt == null || jwt.secret() == null || jwt.secret().length() < 32) {
            throw new IllegalStateException(
                    "voidrun.jwt.secret (JWT_SECRET) must be set to at least 32 characters, e.g. `openssl rand -hex 32`");
        }
        if (limits == null) {
            limits = new Limits(64 * 1024, 64 * 1024, 64 * 1024);
        }
    }

    public record Jwt(String secret, Duration accessTokenTtl, Duration refreshTokenTtl) {
        public Jwt {
            accessTokenTtl = accessTokenTtl == null ? Duration.ofMinutes(15) : accessTokenTtl;
            refreshTokenTtl = refreshTokenTtl == null ? Duration.ofDays(30) : refreshTokenTtl;
        }
    }

    public record OAuthClient(String clientId, String clientSecret) {
        public boolean configured() {
            return clientId != null && !clientId.isBlank() && clientSecret != null && !clientSecret.isBlank();
        }
    }

    public record Limits(int maxSourceBytes, int maxInputBytes, int maxOutputBytes) {}

    /**
     * @param relayEnabled      whether this instance relays the outbox; any number may, they never
     *                          claim the same row
     * @param batchSize         rows claimed per relay pass
     * @param partitions        partitions for the topics the API declares
     * @param replicationFactor replicas for those topics
     */
    public record Outbox(boolean relayEnabled, int batchSize, int partitions, int replicationFactor) {}

    /** @param retention how long a recording is kept before it is deleted */
    public record Replay(Duration retention) {
        public Replay {
            retention = retention == null ? Duration.ofDays(7) : retention;
        }
    }

    /**
     * @param required whether hosting needs a paid plan (admins never do). Off makes hosting free
     *                 for everyone, e.g. on a private server or for local development
     * @param testPayments without Razorpay keys, sell plans through a built-in test checkout
     *                 that moves no money (local development and demos; off in production)
     * @param razorpay the account real payments go to; its keys take precedence over test payments
     * @param plans    purchasable plans by id, in display order
     */
    public record Billing(Boolean required, Boolean testPayments, Razorpay razorpay, Map<String, Plan> plans) {

        /** How plans are paid for. */
        public enum Mode { RAZORPAY, TEST, OFF }

        public Billing {
            required = required == null || required;
            testPayments = testPayments == null || testPayments;
            razorpay = razorpay == null ? new Razorpay(null, null, null, null) : razorpay;
            plans = plans == null || plans.isEmpty()
                    ? defaultPlans()
                    : java.util.Collections.unmodifiableMap(new LinkedHashMap<>(plans));
        }

        public Mode mode() {
            return razorpay.configured() ? Mode.RAZORPAY : testPayments ? Mode.TEST : Mode.OFF;
        }

        /** Plans can be bought, for real or in test mode. */
        public boolean enabled() {
            return mode() != Mode.OFF;
        }

        private static Map<String, Plan> defaultPlans() {
            Map<String, Plan> m = new LinkedHashMap<>();
            m.put("host-monthly", new Plan("Host Monthly", 49_900, 30));
            m.put("host-yearly", new Plan("Host Yearly", 4_99_900, 365));
            return java.util.Collections.unmodifiableMap(m);
        }
    }

    /** @param apiUrl Razorpay's API, overridable for tests */
    public record Razorpay(String keyId, String keySecret, String webhookSecret, String apiUrl) {
        public Razorpay {
            apiUrl = apiUrl == null || apiUrl.isBlank() ? "https://api.razorpay.com" : apiUrl.replaceAll("/+$", "");
        }

        public boolean configured() {
            return keyId != null && !keyId.isBlank() && keySecret != null && !keySecret.isBlank();
        }
    }

    /** @param amountPaise the price in paise (₹1 = 100 paise) */
    public record Plan(String name, int amountPaise, int days) {}
}
