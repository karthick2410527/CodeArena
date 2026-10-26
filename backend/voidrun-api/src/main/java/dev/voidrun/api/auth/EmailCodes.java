package dev.voidrun.api.auth;

import dev.voidrun.api.config.VoidRunProperties;
import dev.voidrun.api.mail.CodeEmail;
import dev.voidrun.api.mail.Mailer;
import dev.voidrun.api.web.ApiException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Six-digit codes sent by email, to sign in without a password or to set a
 * new one. Asking for a code never reveals whether an account has that
 * email: the answer is the same either way, and only an existing account
 * gets mail. A code is stored hashed, works once, expires after ten minutes,
 * and is burned after five wrong guesses, so guessing one of a million
 * values is hopeless. Asking again replaces the previous code.
 */
@Component
public class EmailCodes {

    public enum Purpose { LOGIN, RESET }

    static final Duration TTL = Duration.ofMinutes(10);
    static final int MAX_ATTEMPTS = 5;
    /** One email per account and purpose per minute, however many addresses ask. */
    static final Duration RESEND_AFTER = Duration.ofSeconds(60);

    private static final Logger log = LoggerFactory.getLogger(EmailCodes.class);
    private static final SecureRandom RANDOM = new SecureRandom();

    private final JdbcClient jdbc;
    private final TransactionTemplate tx;
    private final UserRepository users;
    private final Mailer mailer;
    private final String frontendUrl;

    public EmailCodes(JdbcClient jdbc, TransactionTemplate tx, UserRepository users, Mailer mailer,
            VoidRunProperties props) {
        this.jdbc = jdbc;
        this.tx = tx;
        this.users = users;
        this.mailer = mailer;
        this.frontendUrl = props.frontendUrl();
    }

    public boolean enabled() {
        return mailer.enabled();
    }

    /** Emails a fresh code if an account has this address; otherwise does nothing, silently. */
    public void send(String rawEmail, Purpose purpose) {
        if (!mailer.enabled()) {
            throw ApiException.notFound("email sign-in is not set up on this server");
        }
        String email = AccountRules.email(rawEmail);
        Optional<UserRow> user = users.findByEmail(email);
        if (user.isEmpty()) {
            return;
        }
        UUID userId = user.get().id();
        String code = "%06d".formatted(RANDOM.nextInt(1_000_000));
        UUID id = UUID.randomUUID();
        Boolean created = tx.execute(status -> {
            boolean recent = jdbc.sql("""
                            SELECT EXISTS (SELECT 1 FROM email_codes
                                           WHERE user_id = ? AND purpose = ? AND created_at > now() - make_interval(secs => ?))""")
                    .params(userId, purpose.name(), RESEND_AFTER.toSeconds())
                    .query(Boolean.class)
                    .single();
            if (recent) {
                return false;
            }
            jdbc.sql("UPDATE email_codes SET used_at = now() WHERE user_id = ? AND purpose = ? AND used_at IS NULL")
                    .params(userId, purpose.name())
                    .update();
            jdbc.sql("""
                            INSERT INTO email_codes (id, user_id, purpose, code_hash, expires_at)
                            VALUES (?, ?, ?, ?, now() + make_interval(secs => ?))""")
                    .params(id, userId, purpose.name(), hash(id, code), TTL.toSeconds())
                    .update();
            return true;
        });
        if (!Boolean.TRUE.equals(created)) {
            log.info("email code for {} not resent: one was sent less than {}s ago", purpose, RESEND_AFTER.toSeconds());
            return;
        }
        try {
            UserRow u = user.get();
            CodeEmail mail = CodeEmail.of(purpose == Purpose.LOGIN ? CodeEmail.Kind.SIGN_IN : CodeEmail.Kind.RESET, code,
                    u.displayName() != null ? u.displayName() : u.username(), u.email(), TTL.toMinutes(),
                    frontendUrl + (purpose == Purpose.LOGIN ? "/login" : "/forgot-password"));
            mailer.send(u.email(), mail.subject(), mail.text(), mail.html());
        } catch (RuntimeException e) {
            log.warn("could not send the {} code: {}", purpose, e.toString());
            jdbc.sql("UPDATE email_codes SET used_at = now() WHERE id = ?").param(id).update();
            throw ApiException.badGateway("could not send the email; please try again in a minute");
        }
    }

    /** The account the code belongs to, once; any failure is the same "invalid or expired" answer. */
    public UserRow redeem(String rawEmail, String rawCode, Purpose purpose) {
        String email = rawEmail == null ? "" : rawEmail.trim();
        String code = rawCode == null ? "" : rawCode.replaceAll("\\s+", "");
        ApiException invalid = ApiException.unauthorized("that code is wrong or has expired; ask for a new one");
        UserRow user = email.isEmpty() || !code.matches("\\d{6}") ? null : users.findByEmail(email).orElse(null);
        if (user == null) {
            throw invalid;
        }
        record Open(UUID id, String hash, int attempts) {}
        Boolean ok = tx.execute(status -> {
            Optional<Open> open = jdbc.sql("""
                            SELECT id, code_hash, attempts FROM email_codes
                            WHERE user_id = ? AND purpose = ? AND used_at IS NULL AND expires_at > now()
                            ORDER BY created_at DESC LIMIT 1
                            FOR UPDATE""")
                    .params(user.id(), purpose.name())
                    .query((rs, i) -> new Open(rs.getObject("id", UUID.class), rs.getString("code_hash"), rs.getInt("attempts")))
                    .optional();
            if (open.isEmpty()) {
                return false;
            }
            Open o = open.get();
            boolean match = MessageDigest.isEqual(o.hash().getBytes(StandardCharsets.UTF_8),
                    hash(o.id(), code).getBytes(StandardCharsets.UTF_8));
            if (match) {
                jdbc.sql("UPDATE email_codes SET used_at = now() WHERE id = ?").param(o.id()).update();
                return true;
            }
            jdbc.sql("""
                            UPDATE email_codes SET attempts = attempts + 1,
                                   used_at = CASE WHEN attempts + 1 >= ? THEN now() END
                            WHERE id = ?""")
                    .params(MAX_ATTEMPTS, o.id())
                    .update();
            return false;
        });
        if (!Boolean.TRUE.equals(ok)) {
            throw invalid;
        }
        return user;
    }

    private static String hash(UUID id, String code) {
        return Tokens.hash(id + ":" + code);
    }
}
