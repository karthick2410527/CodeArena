package dev.voidrun.api.billing;

import dev.voidrun.api.config.VoidRunProperties;
import java.nio.charset.StandardCharsets;
import java.security.InvalidKeyException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Optional;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Who may host, and turning a confirmed payment into hosting time.
 *
 * <p>A payment can be confirmed twice, by the browser's checkout callback and by
 * Razorpay's webhook, in either order and possibly at once. {@link #markPaid}
 * locks the payment row and only the first confirmation extends the plan.
 */
@Service
public class BillingService {

    private final JdbcClient jdbc;
    private final VoidRunProperties.Billing billing;

    public BillingService(JdbcClient jdbc, VoidRunProperties props) {
        this.jdbc = jdbc;
        this.billing = props.billing();
    }

    public boolean enabled() {
        return billing.enabled();
    }

    /** When the user's Host plan runs out; empty if they never had one. */
    public Optional<Instant> hostingUntil(UUID userId) {
        return jdbc.sql("SELECT valid_until FROM host_plans WHERE user_id = ?")
                .param(userId)
                .query(Instant.class)
                .optional();
    }

    public boolean required() {
        return billing.required();
    }

    /**
     * Admins always may host; with plans not required everyone may. Otherwise it
     * takes a plan that has not run out (none can be bought until Razorpay is set up).
     */
    public boolean canHost(UUID userId, boolean admin) {
        if (admin || !billing.required()) {
            return true;
        }
        return hostingUntil(userId).map(until -> until.isAfter(Instant.now())).orElse(false);
    }

    /**
     * Records the payment for {@code orderId} as paid and extends the owner's
     * plan by its period, counted from now or from the current end, whichever is
     * later. Returns false when the order is unknown or was already paid.
     */
    @Transactional
    public boolean markPaid(String orderId, String paymentId) {
        record Pending(UUID id, UUID userId, String plan, int days, String status) {}
        Optional<Pending> p = jdbc.sql("""
                        SELECT id, user_id, plan, period_days, status FROM payments
                        WHERE razorpay_order_id = ? FOR UPDATE""")
                .param(orderId)
                .query((rs, i) -> new Pending(rs.getObject("id", UUID.class), rs.getObject("user_id", UUID.class),
                        rs.getString("plan"), rs.getInt("period_days"), rs.getString("status")))
                .optional();
        if (p.isEmpty() || p.get().status().equals("PAID")) {
            return false;
        }
        Pending pay = p.get();
        jdbc.sql("""
                        UPDATE payments SET status = 'PAID', razorpay_payment_id = ?, paid_at = now()
                        WHERE id = ? AND status <> 'PAID'""")
                .params(paymentId, pay.id())
                .update();
        jdbc.sql("""
                        INSERT INTO host_plans (user_id, plan, valid_until)
                        VALUES (?, ?, now() + make_interval(days => ?))
                        ON CONFLICT (user_id) DO UPDATE SET
                          plan = EXCLUDED.plan,
                          valid_until = GREATEST(host_plans.valid_until, now()) + make_interval(days => ?),
                          updated_at = now()""")
                .params(pay.userId(), pay.plan(), pay.days(), pay.days())
                .update();
        return true;
    }

    /** A declined or abandoned payment; a later successful attempt on the same order still counts. */
    public void markFailed(String orderId) {
        jdbc.sql("UPDATE payments SET status = 'FAILED' WHERE razorpay_order_id = ? AND status = 'CREATED'")
                .param(orderId)
                .update();
    }

    /** Checkout's proof of payment: HMAC-SHA256 of {@code order_id|payment_id} with the key secret. */
    public boolean checkoutSignatureValid(String orderId, String paymentId, String signature) {
        return matches(orderId + "|" + paymentId, billing.razorpay().keySecret(), signature);
    }

    /** Webhook authenticity: HMAC-SHA256 of the raw body with the webhook secret. */
    public boolean webhookSignatureValid(String body, String signature) {
        return matches(body, billing.razorpay().webhookSecret(), signature);
    }

    static String hmacHex(String data, String secret) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return HexFormat.of().formatHex(mac.doFinal(data.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException | InvalidKeyException e) {
            throw new IllegalStateException(e);
        }
    }

    private static boolean matches(String data, String secret, String signature) {
        if (secret == null || secret.isBlank() || signature == null || data == null) {
            return false;
        }
        byte[] expected = hmacHex(data, secret).getBytes(StandardCharsets.US_ASCII);
        // Constant time, so the comparison leaks nothing about how much matched.
        return MessageDigest.isEqual(expected, signature.trim().toLowerCase().getBytes(StandardCharsets.US_ASCII));
    }
}
