package dev.voidrun.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.jayway.jsonpath.JsonPath;
import dev.voidrun.api.billing.RazorpayGateway;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HexFormat;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;

/** Host plans with billing switched on, against a fake Razorpay that hands out order ids. */
@TestPropertySource(properties = {
        "voidrun.billing.required=true",
        "voidrun.billing.razorpay.key-id=rzp_test_key",
        "voidrun.billing.razorpay.key-secret=" + BillingIntegrationTest.KEY_SECRET,
        "voidrun.billing.razorpay.webhook-secret=" + BillingIntegrationTest.WEBHOOK_SECRET,
})
class BillingIntegrationTest extends ApiTestSupport {

    static final String KEY_SECRET = "test-key-secret";
    static final String WEBHOOK_SECRET = "test-webhook-secret";

    @TestConfiguration
    static class FakeRazorpay {
        static final AtomicInteger ORDERS = new AtomicInteger();

        @Bean
        @Primary
        RazorpayGateway fakeRazorpay() {
            return (amount, currency, receipt, notes) ->
                    new RazorpayGateway.Order("order_" + ORDERS.incrementAndGet(), amount, currency);
        }
    }

    static String hmac(String data, String secret) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return HexFormat.of().formatHex(mac.doFinal(data.getBytes(StandardCharsets.UTF_8)));
    }

    private String order(TestUser who, String plan) throws Exception {
        String body = mvc.perform(json(post("/api/v1/billing/orders"), "{\"plan\":\"" + plan + "\"}")
                        .header("Authorization", who.bearer()))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.key_id").value("rzp_test_key"))
                .andExpect(jsonPath("$.mode").value("razorpay"))
                .andExpect(jsonPath("$.currency").value("INR"))
                .andReturn().getResponse().getContentAsString();
        return JsonPath.read(body, "$.order_id");
    }

    /** A contest that is ready to publish but for the plan. */
    private String readyContest(TestUser host) throws Exception {
        String p = JsonPath.read(mvc.perform(json(post("/api/v1/studio/problems"), """
                        {"slug":"%s","title":"Sum","description":"Add them.","difficulty":"EASY",
                         "time_limit_ms":1000,"memory_limit_mb":256}""".formatted(unique("p")))
                        .header("Authorization", host.bearer()))
                .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString(), "$.id");
        mvc.perform(json(post("/api/v1/studio/problems/" + p + "/test-cases"),
                        "{\"input\":\"1 2\",\"expected_output\":\"3\",\"is_sample\":true}")
                        .header("Authorization", host.bearer()))
                .andExpect(status().isCreated());
        String slug = JsonPath.read(mvc.perform(json(post("/api/v1/contests"), """
                        {"title":"Round %s","format":"ICPC","starts_at":"%s","duration_minutes":120}"""
                        .formatted(unique("r"), Instant.now().plus(1, ChronoUnit.DAYS)))
                        .header("Authorization", host.bearer()))
                .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString(), "$.contest.slug");
        mvc.perform(json(put("/api/v1/contests/" + slug + "/problems"), "[{\"problem_id\":\"" + p + "\"}]")
                        .header("Authorization", host.bearer()))
                .andExpect(status().isOk());
        return slug;
    }

    @Test
    void publishingNeedsAHostPlanBoughtThroughCheckout() throws Exception {
        mvc.perform(get("/api/v1/billing/plans"))
                .andExpect(jsonPath("$.enabled").value(true))
                .andExpect(jsonPath("$.mode").value("razorpay"))
                .andExpect(jsonPath("$.key_id").value("rzp_test_key"))
                .andExpect(jsonPath("$.plans[0].id").value("host-monthly"))
                .andExpect(jsonPath("$.plans[0].amount_paise").value(49900));

        TestUser host = register();
        mvc.perform(json(post("/api/v1/contests"), """
                        {"title":"Round","format":"ICPC","starts_at":"%s","duration_minutes":120}"""
                        .formatted(Instant.now().plus(1, ChronoUnit.DAYS)))
                        .header("Authorization", host.bearer()))
                .andExpect(status().isPaymentRequired())
                .andExpect(jsonPath("$.error.code").value("HOST_PLAN_REQUIRED"));
        mvc.perform(get("/api/v1/billing/me").header("Authorization", host.bearer()))
                .andExpect(jsonPath("$.required").value(true))
                .andExpect(jsonPath("$.can_host").value(false));

        // The browser never names a price, and an unknown plan is refused.
        mvc.perform(json(post("/api/v1/billing/orders"), "{\"plan\":\"free-forever\"}").header("Authorization", host.bearer()))
                .andExpect(status().isBadRequest());
        String orderId = order(host, "host-monthly");
        assertThat(jdbc.sql("SELECT amount_paise FROM payments WHERE razorpay_order_id = ?").param(orderId)
                .query(Integer.class).single()).isEqualTo(49900);

        // A forged signature, or someone else's order, changes nothing.
        String verify = "{\"razorpay_order_id\":\"%s\",\"razorpay_payment_id\":\"pay_1\",\"razorpay_signature\":\"%s\"}";
        mvc.perform(json(post("/api/v1/billing/verify"), verify.formatted(orderId, "deadbeef")).header("Authorization", host.bearer()))
                .andExpect(status().isBadRequest());
        TestUser other = register();
        String good = hmac(orderId + "|pay_1", KEY_SECRET);
        mvc.perform(json(post("/api/v1/billing/verify"), verify.formatted(orderId, good)).header("Authorization", other.bearer()))
                .andExpect(status().isNotFound());

        mvc.perform(json(post("/api/v1/billing/verify"), verify.formatted(orderId, good)).header("Authorization", host.bearer()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.can_host").value(true))
                .andExpect(jsonPath("$.plan").value("host-monthly"))
                .andExpect(jsonPath("$.payments[0].status").value("PAID"))
                .andExpect(jsonPath("$.payments[0].razorpay_payment_id").value("pay_1"));
        Instant until = hostingUntil(host);
        assertThat(until).isBetween(Instant.now().plus(29, ChronoUnit.DAYS), Instant.now().plus(31, ChronoUnit.DAYS));

        // The webhook for the same payment arrives too: the plan is not extended twice.
        String event = """
                {"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_1","order_id":"%s","amount":49900}}}}"""
                .formatted(orderId);
        webhook(event, "evt_1").andExpect(status().isOk());
        assertThat(hostingUntil(host)).isEqualTo(until);

        String slug = readyContest(host);
        mvc.perform(json(post("/api/v1/contests/" + slug + "/publish"), "{}").header("Authorization", host.bearer()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.contest.published").value(true));

        // Once the plan runs out, a draft made while it lasted cannot go live.
        String later = readyContest(host);
        jdbc.sql("UPDATE host_plans SET valid_until = now() - interval '1 minute' WHERE user_id = ?::uuid")
                .param(host.id()).update();
        mvc.perform(json(post("/api/v1/contests/" + later + "/publish"), "{}").header("Authorization", host.bearer()))
                .andExpect(status().isPaymentRequired());
    }

    @Test
    void theWebhookAloneGrantsTheExtraTimeOnceAndRejectsForgeries() throws Exception {
        TestUser host = register();
        String orderId = order(host, "host-yearly");
        String event = """
                {"event":"order.paid","payload":{"order":{"entity":{"id":"%s"}},"payment":{"entity":{"id":"pay_w","order_id":"%s"}}}}"""
                .formatted(orderId, orderId);

        mvc.perform(post("/api/v1/billing/webhook").contentType(MediaType.APPLICATION_JSON).content(event)
                        .header("X-Razorpay-Signature", hmac(event, "wrong-secret")))
                .andExpect(status().isBadRequest());
        assertThat(jdbc.sql("SELECT count(*) FROM host_plans WHERE user_id = ?::uuid").param(host.id())
                .query(Long.class).single()).isZero();

        String eventId = "evt_" + UUID.randomUUID();
        webhook(event, eventId).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("ok"));
        Instant until = hostingUntil(host);
        assertThat(until).isAfter(Instant.now().plus(364, ChronoUnit.DAYS));
        webhook(event, eventId).andExpect(jsonPath("$.status").value("duplicate"));
        assertThat(hostingUntil(host)).isEqualTo(until);

        // A second purchase adds its days to the end of the current plan.
        String second = order(host, "host-monthly");
        mvc.perform(json(post("/api/v1/billing/verify"),
                        "{\"razorpay_order_id\":\"%s\",\"razorpay_payment_id\":\"pay_2\",\"razorpay_signature\":\"%s\"}"
                                .formatted(second, hmac(second + "|pay_2", KEY_SECRET)))
                        .header("Authorization", host.bearer()))
                .andExpect(status().isOk());
        assertThat(hostingUntil(host)).isEqualTo(until.plus(30, ChronoUnit.DAYS));
    }

    @Test
    void adminsHostWithoutAPlan() throws Exception {
        TestUser admin = admin();
        String slug = readyContest(admin);
        mvc.perform(json(post("/api/v1/contests/" + slug + "/publish"), "{}").header("Authorization", admin.bearer()))
                .andExpect(status().isOk());
    }

    private Instant hostingUntil(TestUser u) {
        return jdbc.sql("SELECT valid_until FROM host_plans WHERE user_id = ?::uuid").param(u.id())
                .query(Instant.class).single();
    }

    private org.springframework.test.web.servlet.ResultActions webhook(String body, String eventId) throws Exception {
        return mvc.perform(post("/api/v1/billing/webhook").contentType(MediaType.APPLICATION_JSON).content(body)
                .header("X-Razorpay-Signature", hmac(body, WEBHOOK_SECRET))
                .header("X-Razorpay-Event-Id", eventId));
    }
}
