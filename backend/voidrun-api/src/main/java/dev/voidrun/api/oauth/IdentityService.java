package dev.voidrun.api.oauth;

import dev.voidrun.api.auth.AccountRules;
import dev.voidrun.api.auth.Tokens;
import dev.voidrun.api.auth.UserRepository;
import dev.voidrun.api.auth.UserRow;
import dev.voidrun.api.web.ApiException;
import java.security.SecureRandom;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Decides which VoidRun user a provider account signs in as.
 *
 * <ol>
 *   <li>An identity already linked to this provider account → that user.</li>
 *   <li>Else, a verified email that matches a user whose own email is
 *       verified → link to that user. A password account's email was never
 *       verified, so it is <em>not</em> linked automatically: otherwise
 *       anyone could pre-register a victim's address with a password and
 *       inherit their Google sign-in later. That case is refused with
 *       {@code email_in_use}; the owner signs in with the password and links
 *       from their profile instead.</li>
 *   <li>Else a new user. Its email is stored only if the provider verified it.</li>
 * </ol>
 */
@Service
public class IdentityService {

    static final Duration LOGIN_CODE_TTL = Duration.ofSeconds(60);
    static final Duration LINK_INTENT_TTL = Duration.ofMinutes(5);
    private static final SecureRandom RANDOM = new SecureRandom();

    private final JdbcClient jdbc;
    private final UserRepository users;

    public IdentityService(JdbcClient jdbc, UserRepository users) {
        this.jdbc = jdbc;
        this.users = users;
    }

    public record Identity(String provider, String login, String email, Instant createdAt, Instant lastUsedAt) {}

    public record LinkIntent(String token, String nonce) {}

    @Transactional
    public UUID signIn(ProviderAccount acct) {
        Optional<UUID> linked = jdbc.sql("""
                        UPDATE user_identities
                        SET last_used_at = now(), email = ?, email_verified = ?, login = ?
                        WHERE provider = ? AND subject = ?
                        RETURNING user_id""")
                .params(acct.email(), acct.emailVerified(), acct.login(), acct.provider(), acct.subject())
                .query(UUID.class)
                .optional();
        if (linked.isPresent()) {
            return linked.get();
        }

        if (acct.emailVerified() && acct.email() != null) {
            Optional<UserRow> sameEmail = users.findByEmail(acct.email());
            if (sameEmail.isPresent()) {
                UserRow existing = sameEmail.get();
                if (!existing.emailVerified()) {
                    throw new OAuthFlowException("email_in_use",
                            "unverified account " + existing.id() + " already uses " + acct.provider() + " email");
                }
                insertIdentity(existing.id(), acct);
                return existing.id();
            }
        }

        UserRow created = createUser(acct);
        insertIdentity(created.id(), acct);
        return created.id();
    }

    /** Attaches a provider account to the user who asked for it in {@link #createLinkIntent}. */
    @Transactional
    public UUID link(String token, String nonce, ProviderAccount acct) {
        if (token == null || nonce == null) {
            throw new OAuthFlowException("link_expired", "link token or browser nonce missing");
        }
        UUID userId = jdbc.sql("""
                        UPDATE oauth_link_intents SET used_at = now()
                        WHERE token_hash = ? AND nonce_hash = ? AND provider = ?
                          AND used_at IS NULL AND expires_at > now()
                        RETURNING user_id""")
                .params(Tokens.hash(token), Tokens.hash(nonce), acct.provider())
                .query(UUID.class)
                .optional()
                .orElseThrow(() -> new OAuthFlowException("link_expired", "link intent not found or expired"));

        Optional<UUID> owner = jdbc.sql("SELECT user_id FROM user_identities WHERE provider = ? AND subject = ?")
                .params(acct.provider(), acct.subject())
                .query(UUID.class)
                .optional();
        if (owner.isPresent()) {
            if (!owner.get().equals(userId)) {
                throw new OAuthFlowException("identity_in_use",
                        acct.provider() + " account already signs in as another user");
            }
            return userId;
        }
        insertIdentity(userId, acct);
        if (acct.emailVerified() && acct.email() != null) {
            // The provider now vouches for the address this user already had.
            jdbc.sql("UPDATE users SET email_verified = TRUE WHERE id = ? AND lower(email) = lower(?)")
                    .params(userId, acct.email())
                    .update();
        }
        return userId;
    }

    public LinkIntent createLinkIntent(UUID userId, String provider) {
        LinkIntent intent = new LinkIntent(Tokens.random(), Tokens.random());
        jdbc.sql("INSERT INTO oauth_link_intents (token_hash, nonce_hash, user_id, provider, expires_at) VALUES (?, ?, ?, ?, ?)")
                .params(Tokens.hash(intent.token()), Tokens.hash(intent.nonce()), userId, provider,
                        Timestamp.from(Instant.now().plus(LINK_INTENT_TTL)))
                .update();
        return intent;
    }

    /** A single-use code the browser trades for tokens; {@code nonce} goes into an HttpOnly cookie. */
    public String issueLoginCode(UUID userId, String nonce) {
        String code = Tokens.random();
        jdbc.sql("INSERT INTO oauth_login_codes (code_hash, nonce_hash, user_id, expires_at) VALUES (?, ?, ?, ?)")
                .params(Tokens.hash(code), Tokens.hash(nonce), userId, Timestamp.from(Instant.now().plus(LOGIN_CODE_TTL)))
                .update();
        return code;
    }

    public UserRow redeemLoginCode(String code, String nonce) {
        if (code == null || code.isBlank() || nonce == null || nonce.isBlank()) {
            throw ApiException.unauthorized("this sign-in has expired; please sign in again");
        }
        UUID userId = jdbc.sql("""
                        UPDATE oauth_login_codes SET used_at = now()
                        WHERE code_hash = ? AND nonce_hash = ? AND used_at IS NULL AND expires_at > now()
                        RETURNING user_id""")
                .params(Tokens.hash(code), Tokens.hash(nonce))
                .query(UUID.class)
                .optional()
                .orElseThrow(() -> ApiException.unauthorized("this sign-in has expired; please sign in again"));
        return users.findById(userId).orElseThrow(() -> ApiException.unauthorized("account no longer exists"));
    }

    public List<Identity> identities(UUID userId) {
        return jdbc.sql("""
                        SELECT provider, login, email, created_at, last_used_at
                        FROM user_identities WHERE user_id = ? ORDER BY created_at""")
                .param(userId)
                .query((rs, i) -> new Identity(rs.getString("provider"), rs.getString("login"), rs.getString("email"),
                        rs.getTimestamp("created_at").toInstant(), rs.getTimestamp("last_used_at").toInstant()))
                .list();
    }

    /** Removes a provider, unless it is the only way left to sign in. */
    @Transactional
    public void unlink(UUID userId, String provider) {
        Boolean hasPassword = jdbc.sql("SELECT password_hash IS NOT NULL FROM users WHERE id = ? FOR UPDATE")
                .param(userId)
                .query(Boolean.class)
                .optional()
                .orElseThrow(() -> ApiException.notFound("account not found"));
        int identities = jdbc.sql("SELECT count(*) FROM user_identities WHERE user_id = ?")
                .param(userId)
                .query(Integer.class)
                .single();
        boolean linked = jdbc.sql("SELECT EXISTS (SELECT 1 FROM user_identities WHERE user_id = ? AND provider = ?)")
                .params(userId, provider)
                .query(Boolean.class)
                .single();
        if (!linked) {
            throw ApiException.notFound(OAuthProviders.displayName(provider) + " is not connected");
        }
        if (!hasPassword && identities <= 1) {
            throw ApiException.conflict("LAST_SIGN_IN_METHOD",
                    "this is your only way to sign in; connect another provider first");
        }
        jdbc.sql("DELETE FROM user_identities WHERE user_id = ? AND provider = ?").params(userId, provider).update();
    }

    private void insertIdentity(UUID userId, ProviderAccount acct) {
        int inserted = jdbc.sql("""
                        INSERT INTO user_identities (user_id, provider, subject, email, email_verified, login)
                        VALUES (?, ?, ?, ?, ?, ?)
                        ON CONFLICT DO NOTHING""")
                .params(userId, acct.provider(), acct.subject(), acct.email(), acct.emailVerified(), acct.login())
                .update();
        if (inserted == 0) {
            // (user_id, provider) is taken: this user already has a different
            // account at this provider. (provider, subject) was checked above.
            throw new OAuthFlowException("provider_conflict",
                    "user " + userId + " already has another " + acct.provider() + " account linked");
        }
    }

    private UserRow createUser(ProviderAccount acct) {
        String stem = AccountRules.usernameStem(acct.usernameHint());
        String email = acct.emailVerified() ? acct.email() : null;
        for (int attempt = 0; attempt < 20; attempt++) {
            String candidate = attempt == 0 ? stem
                    : attempt < 5 ? stem + "-" + (attempt + 1)
                    : stem + "-" + (1000 + RANDOM.nextInt(9000));
            // ON CONFLICT DO NOTHING rather than catching the violation: a failed
            // INSERT would abort the surrounding transaction.
            Optional<UserRow> row = jdbc.sql("""
                            INSERT INTO users (username, email, email_verified, display_name, avatar_url)
                            VALUES (?, ?, ?, ?, ?)
                            ON CONFLICT DO NOTHING
                            RETURNING id, username, email, email_verified, password_hash, display_name, avatar_url,
                                      role, created_at""")
                    .params(candidate, email, email != null, acct.displayName(), acct.avatarUrl())
                    .query(UserRepository::map)
                    .optional();
            if (row.isPresent()) {
                return row.get();
            }
            if (email != null && users.findByEmail(email).isPresent()) {
                throw new OAuthFlowException("email_in_use", "email taken while creating the account");
            }
        }
        throw new OAuthFlowException("provider_error", "could not find a free username for " + stem);
    }
}
