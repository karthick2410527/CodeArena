package dev.voidrun.api;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.jayway.jsonpath.JsonPath;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import org.hamcrest.Matchers;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.TestPropertySource;

/** Plans required, no Razorpay keys: the built-in test checkout sells them without moving money. */
@TestPropertySource(properties = "voidrun.billing.required=true")
class TestPaymentsIntegrationTest extends ApiTestSupport {

    @Test
    void theTestCheckoutGrantsAPlanThatIsMarkedAsTest() throws Exception {
        mvc.perform(get("/api/v1/billing/plans"))
                .andExpect(jsonPath("$.enabled").value(true))
                .andExpect(jsonPath("$.mode").value("test"))
                .andExpect(jsonPath("$.key_id").doesNotExist());

        TestUser host = register();
        String newContest = """
                {"title":"Round","format":"ICPC","starts_at":"%s","duration_minutes":120}"""
                .formatted(Instant.now().plus(1, ChronoUnit.DAYS));
        mvc.perform(json(post("/api/v1/contests"), newContest).header("Authorization", host.bearer()))
                .andExpect(status().isPaymentRequired());

        String order = JsonPath.read(mvc.perform(json(post("/api/v1/billing/orders"), "{\"plan\":\"host-monthly\"}")
                        .header("Authorization", host.bearer()))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.mode").value("test"))
                .andExpect(jsonPath("$.order_id").value(Matchers.startsWith("test_order_")))
                .andReturn().getResponse().getContentAsString(), "$.order_id");

        // Someone else cannot pay (and so claim) your test order, and a test order is never "verified".
        TestUser other = register();
        mvc.perform(json(post("/api/v1/billing/test-pay"), "{\"order_id\":\"" + order + "\"}")
                        .header("Authorization", other.bearer()))
                .andExpect(status().isNotFound());
        mvc.perform(json(post("/api/v1/billing/verify"),
                        "{\"razorpay_order_id\":\"%s\",\"razorpay_payment_id\":\"x\",\"razorpay_signature\":\"x\"}"
                                .formatted(order))
                        .header("Authorization", host.bearer()))
                .andExpect(status().isBadRequest());

        mvc.perform(json(post("/api/v1/billing/test-pay"), "{\"order_id\":\"" + order + "\"}")
                        .header("Authorization", host.bearer()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.can_host").value(true))
                .andExpect(jsonPath("$.payments[0].test").value(true))
                .andExpect(jsonPath("$.payments[0].status").value("PAID"));
        mvc.perform(json(post("/api/v1/contests"), newContest).header("Authorization", host.bearer()))
                .andExpect(status().isCreated());
    }
}
