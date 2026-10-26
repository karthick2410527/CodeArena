package dev.voidrun.api.auth;

import dev.voidrun.api.auth.AuthDtos.AuthResponse;
import dev.voidrun.api.auth.AuthDtos.UserDto;
import dev.voidrun.api.config.VoidRunProperties;
import dev.voidrun.api.web.ApiException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.crypto.argon2.Argon2PasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

/** Password sign-up and sign-in, and the token pair every sign-in method ends with. */
@Service
public class AuthService {

    private final JdbcClient jdbc;
    private final UserRepository users;
    private final JwtService jwt;
    private final VoidRunProperties props;
    private final PasswordEncoder passwords = Argon2PasswordEncoder.defaultsForSpringSecurity_v5_8();
    // Verified against when the account does not exist or has no password, so
    // a failed sign-in takes the same time either way and does not reveal
    // which emails are registered.
    private final String dummyHash = passwords.encode("voidrun-timing-equaliser");

    private final EmailCodes codes;

    public AuthService(JdbcClient jdbc, UserRepository users, JwtService jwt, VoidRunProperties props,
            EmailCodes codes) {
        this.jdbc = jdbc;
        this.users = users;
        this.jwt = jwt;
        this.props = props;
        this.codes = codes;
    }

    public AuthResponse register(AuthDtos.RegisterRequest req) {
        String username = AccountRules.username(req.username());
        String email = AccountRules.email(req.email());
        String password = AccountRules.password(req.password());
        String name = AccountRules.displayName(req.displayName());
        UserRow user;
        try {
            user = users.insert(username, email, false, passwords.encode(password), name, null);
        } catch (DuplicateKeyException e) {
            throw ApiException.conflict("username or email is already in use");
        }
        return issueTokens(user);
    }

    public AuthResponse login(AuthDtos.LoginRequest req) {
        String email = req.email() == null ? "" : req.email().trim();
        String password = req.password() == null ? "" : req.password();
        UserRow user = email.isEmpty() ? null : users.findByEmail(email).orElse(null);
        String hash = user == null || user.passwordHash() == null ? dummyHash : user.passwordHash();
        boolean ok = passwords.matches(password, hash);
        if (user == null || user.passwordHash() == null || !ok) {
            throw ApiException.unauthorized("invalid email or password");
        }
        return issueTokens(user);
    }

    /** Signs in with a code from {@link EmailCodes}; receiving it proves the address, so it is marked verified. */
    public AuthResponse loginWithCode(AuthDtos.CodeLoginRequest req) {
        UserRow user = codes.redeem(req.email(), req.code(), EmailCodes.Purpose.LOGIN);
        return issueTokens(markVerified(user));
    }

    /**
     * Sets a new password with a reset code. Every other session is signed out,
     * since a reset usually means the old password is no longer safe.
     */
    public AuthResponse resetPassword(AuthDtos.ResetPasswordRequest req) {
        String password = AccountRules.password(req.password());
        UserRow user = codes.redeem(req.email(), req.code(), EmailCodes.Purpose.RESET);
        jdbc.sql("UPDATE users SET password_hash = ? WHERE id = ?").params(passwords.encode(password), user.id()).update();
        jdbc.sql("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = ? AND revoked_at IS NULL")
                .param(user.id())
                .update();
        return issueTokens(markVerified(user));
    }

    private UserRow markVerified(UserRow user) {
        jdbc.sql("UPDATE users SET email_verified = TRUE WHERE id = ? AND NOT email_verified").param(user.id()).update();
        return users.findById(user.id()).orElse(user);
    }

    /** Rotates a refresh token: the presented one is revoked atomically, so it works exactly once. */
    public AuthResponse refresh(String refreshToken) {
        if (refreshToken == null || refreshToken.isBlank()) {
            throw ApiException.unauthorized("invalid or expired refresh token");
        }
        UUID userId = jdbc.sql("""
                        UPDATE refresh_tokens SET revoked_at = now()
                        WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > now()
                        RETURNING user_id""")
                .param(Tokens.hash(refreshToken))
                .query(UUID.class)
                .optional()
                .orElseThrow(() -> ApiException.unauthorized("invalid or expired refresh token"));
        UserRow user = users.findById(userId)
                .orElseThrow(() -> ApiException.unauthorized("account no longer exists"));
        return issueTokens(user);
    }

    public void logout(String refreshToken) {
        if (refreshToken == null || refreshToken.isBlank()) {
            return;
        }
        jdbc.sql("UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = ? AND revoked_at IS NULL")
                .param(Tokens.hash(refreshToken))
                .update();
    }

    public AuthResponse issueTokens(UserRow user) {
        String refresh = Tokens.random();
        Instant expires = Instant.now().plus(props.jwt().refreshTokenTtl());
        jdbc.sql("INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)")
                .params(user.id(), Tokens.hash(refresh), Timestamp.from(expires))
                .update();
        return new AuthResponse(jwt.issue(user), refresh, "Bearer", jwt.ttlSeconds(), UserDto.of(user));
    }
}
