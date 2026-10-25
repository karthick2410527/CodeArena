package dev.voidrun.api.billing;

import dev.voidrun.api.config.VoidRunProperties;
import dev.voidrun.api.ratelimit.RateLimiter;
import dev.voidrun.api.security.CurrentUser;
import dev.voidrun.api.web.ApiException;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Host plans, paid with Razorpay Checkout.
 *
 * <ol>
 *   <li>{@code POST /billing/orders}: the server prices the plan (the browser never sends an
 *       amount), creates a Razorpay order and records a pending payment.</li>
 *   <li>The browser opens Razorpay Checkout for that order.</li>
 *   <li>{@code POST /billing/verify}: Checkout's signed result; a valid signature marks the
 *       payment paid and extends the plan.</li>
 *   <li>{@code POST /billing/webhook}: Razorpay's own notice of the same payment, so a closed tab
 *       after paying still counts. Whichever arrives first wins; the other changes nothing.</li>
 * </ol>
 */
@RestController
@RequestMapping("/api/v1/billing")
public class BillingController {

    private static final Logger log = LoggerFactory.getLogger(BillingController.class);
    private static final String CURRENCY = "INR";

    public record PlanView(String id, String name, int amountPaise, String currency, int periodDays) {}

    /**
     * @param enabled  plans can be bought
     * @param mode     {@code razorpay} (real payments), {@code test} (the built-in test checkout,
     *                 no money moves) or {@code off}
     * @param required hosting needs a plan; false means hosting is free on this server
     * @param keyId    Razorpay's public key, which Checkout needs; null unless mode is razorpay
     */
    public record Plans(boolean enabled, String mode, boolean required, String keyId, List<PlanView> plans) {}

    /** @param test made with the test checkout: no money moved */
    public record PaymentView(UUID id, String plan, int amountPaise, String currency, String status,
            String razorpayPaymentId, boolean test, Instant createdAt, Instant paidAt) {}

    /** @param canHost may create and publish contests now (always for admins, and when plans aren't required) */
    public record Me(boolean enabled, String mode, boolean required, boolean canHost, Instant hostingUntil,
            String plan, List<PaymentView> payments) {}

    public record OrderInput(String plan) {}

    /** @param mode how to pay it: {@code razorpay} (open Checkout) or {@code test} (POST /billing/test-pay) */
    public record OrderView(String orderId, String mode, int amountPaise, String currency, String keyId, String plan,
            String planName, String name, String email) {}

    public record TestPayInput(String orderId) {}

    public record VerifyInput(String razorpayOrderId, String razorpayPaymentId, String razorpaySignature) {}

    private final JdbcClient jdbc;
    private final BillingService billing;
    private final RazorpayGateway razorpay;
    private final RateLimiter limiter;
    private final VoidRunProperties.Billing config;
    private final JsonMapper json;

    public BillingController(JdbcClient jdbc, BillingService billing, RazorpayGateway razorpay, RateLimiter limiter,
            VoidRunProperties props, JsonMapper json) {
        this.jdbc = jdbc;
        this.billing = billing;
        this.razorpay = razorpay;
        this.limiter = limiter;
        this.config = props.billing();
        this.json = json;
    }

    @GetMapping("/plans")
    Plans plans() {
        return new Plans(config.enabled(), mode(), config.required(),
                config.mode() == VoidRunProperties.Billing.Mode.RAZORPAY ? config.razorpay().keyId() : null,
                config.plans().entrySet().stream()
                        .map(e -> new PlanView(e.getKey(), e.getValue().name(), e.getValue().amountPaise(), CURRENCY,
                                e.getValue().days()))
                        .toList());
    }

    @GetMapping("/me")
    Me me(@AuthenticationPrincipal Jwt jwt) {
        UUID me = CurrentUser.id(jwt);
        Instant until = billing.hostingUntil(me).orElse(null);
        String plan = jdbc.sql("SELECT plan FROM host_plans WHERE user_id = ?").param(me).query(String.class)
                .optional().orElse(null);
        List<PaymentView> payments = jdbc.sql("""
                        SELECT id, plan, amount_paise, currency, status, razorpay_payment_id, test, created_at, paid_at
                        FROM payments WHERE user_id = ? AND status <> 'CREATED'
                        ORDER BY created_at DESC LIMIT 50""")
                .param(me)
                .query((rs, i) -> new PaymentView(rs.getObject("id", UUID.class), rs.getString("plan"),
                        rs.getInt("amount_paise"), rs.getString("currency"), rs.getString("status"),
                        rs.getString("razorpay_payment_id"), rs.getBoolean("test"), rs.getTimestamp("created_at").toInstant(),
                        rs.getTimestamp("paid_at") == null ? null : rs.getTimestamp("paid_at").toInstant()))
                .list();
        return new Me(config.enabled(), mode(), config.required(), billing.canHost(me, CurrentUser.isAdmin(jwt)), until,
                plan, payments);
    }

    @PostMapping("/orders")
    @ResponseStatus(HttpStatus.CREATED)
    OrderView createOrder(@AuthenticationPrincipal Jwt jwt, @RequestBody OrderInput in) {
        if (!config.enabled()) {
            throw ApiException.conflict("BILLING_DISABLED", "payments are not set up on this server yet");
        }
        VoidRunProperties.Plan plan = in == null || in.plan() == null ? null : config.plans().get(in.plan());
        if (plan == null) {
            throw ApiException.badRequest("plan must be one of " + String.join(", ", config.plans().keySet()));
        }
        UUID me = CurrentUser.id(jwt);
        limiter.check("billing", me.toString(), "too many checkout attempts; please wait a little");
        UUID paymentId = UUID.randomUUID();
        boolean test = config.mode() == VoidRunProperties.Billing.Mode.TEST;
        String orderId = test
                ? "test_order_" + paymentId.toString().replace("-", "")
                : razorpay.createOrder(plan.amountPaise(), CURRENCY, paymentId.toString(),
                        Map.of("user_id", me.toString(), "plan", in.plan())).id();
        try {
            jdbc.sql("""
                            INSERT INTO payments (id, user_id, plan, amount_paise, currency, period_days, razorpay_order_id,
                                                  test)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)""")
                    .params(paymentId, me, in.plan(), plan.amountPaise(), CURRENCY, plan.days(), orderId, test)
                    .update();
        } catch (DuplicateKeyException e) {
            throw ApiException.conflict("that order already exists; start the checkout again");
        }
        record Who(String username, String displayName, String email) {}
        Who who = jdbc.sql("SELECT username, display_name, email FROM users WHERE id = ?")
                .param(me)
                .query((rs, i) -> new Who(rs.getString("username"), rs.getString("display_name"), rs.getString("email")))
                .single();
        return new OrderView(orderId, mode(), plan.amountPaise(), CURRENCY, test ? null : config.razorpay().keyId(), in.plan(),
                plan.name(), who.displayName() == null ? who.username() : who.displayName(), who.email());
    }

    /**
     * The test checkout's "pay" button: marks a test order paid at once. Only while test
     * payments are on, so it can never stand in for a real payment.
     */
    @PostMapping("/test-pay")
    Me testPay(@AuthenticationPrincipal Jwt jwt, @RequestBody TestPayInput in) {
        if (config.mode() != VoidRunProperties.Billing.Mode.TEST) {
            throw ApiException.conflict("TEST_PAYMENTS_OFF", "test payments are turned off on this server");
        }
        UUID me = CurrentUser.id(jwt);
        boolean mine = in != null && in.orderId() != null && jdbc.sql("""
                        SELECT count(*) FROM payments WHERE razorpay_order_id = ? AND user_id = ? AND test""")
                .params(in.orderId(), me)
                .query(Long.class)
                .single() > 0;
        if (!mine) {
            throw ApiException.notFound("order not found");
        }
        billing.markPaid(in.orderId(), "test_pay_" + UUID.randomUUID().toString().replace("-", "").substring(0, 14));
        return me(jwt);
    }

    private String mode() {
        return config.mode().name().toLowerCase(java.util.Locale.ROOT);
    }

    /** Checkout's success callback, forwarded by the browser. */
    @PostMapping("/verify")
    Me verify(@AuthenticationPrincipal Jwt jwt, @RequestBody VerifyInput in) {
        if (in == null || in.razorpayOrderId() == null || in.razorpayPaymentId() == null) {
            throw ApiException.badRequest("razorpay_order_id, razorpay_payment_id and razorpay_signature are required");
        }
        UUID me = CurrentUser.id(jwt);
        boolean mine = jdbc.sql("SELECT count(*) FROM payments WHERE razorpay_order_id = ? AND user_id = ?")
                .params(in.razorpayOrderId(), me)
                .query(Long.class)
                .single() > 0;
        if (!mine) {
            throw ApiException.notFound("order not found");
        }
        if (!billing.checkoutSignatureValid(in.razorpayOrderId(), in.razorpayPaymentId(), in.razorpaySignature())) {
            throw ApiException.badRequest("the payment could not be verified");
        }
        billing.markPaid(in.razorpayOrderId(), in.razorpayPaymentId());
        return me(jwt);
    }

    /**
     * Razorpay's server-to-server events. Configure it in the dashboard (Settings → Webhooks) for
     * {@code payment.captured}, {@code order.paid} and {@code payment.failed}, with the same
     * secret as {@code RAZORPAY_WEBHOOK_SECRET}.
     */
    @PostMapping("/webhook")
    Map<String, String> webhook(@RequestBody String body,
            @RequestHeader(name = "X-Razorpay-Signature", required = false) String signature,
            @RequestHeader(name = "X-Razorpay-Event-Id", required = false) String eventId) {
        if (!billing.webhookSignatureValid(body, signature)) {
            throw ApiException.badRequest("invalid signature");
        }
        JsonNode event = json.readTree(body);
        String type = event.path("event").asString("");
        String id = eventId != null && !eventId.isBlank() ? eventId : type + ":" + event.path("created_at").asString("");
        int fresh = jdbc.sql("INSERT INTO billing_webhook_events (event_id, event_type) VALUES (?, ?) ON CONFLICT DO NOTHING")
                .params(id, type)
                .update();
        if (fresh == 0) {
            return Map.of("status", "duplicate");
        }
        JsonNode payment = event.path("payload").path("payment").path("entity");
        String orderId = payment.path("order_id").asString(null);
        if (orderId == null) {
            orderId = event.path("payload").path("order").path("entity").path("id").asString(null);
        }
        switch (type) {
            case "payment.captured", "order.paid" -> {
                if (orderId != null && billing.markPaid(orderId, payment.path("id").asString(null))) {
                    log.info("host plan extended by webhook for order {}", orderId);
                }
            }
            case "payment.failed" -> {
                if (orderId != null) {
                    billing.markFailed(orderId);
                }
            }
            default -> log.debug("ignoring razorpay event {}", type);
        }
        return Map.of("status", "ok");
    }
}
