package dev.voidrun.api.auth;

import java.time.Instant;
import java.util.UUID;

/** Request and response bodies of the auth endpoints. Serialized snake_case. */
public final class AuthDtos {

    private AuthDtos() {}

    /** @param displayName the name shown on the profile and in standings; optional, the username stands in */
    public record RegisterRequest(String username, String email, String password, String displayName) {}

    public record LoginRequest(String email, String password) {}

    public record RefreshRequest(String refreshToken) {}

    /** @param purpose {@code login} (the default) or {@code reset} */
    public record EmailCodeRequest(String email, String purpose) {}

    public record CodeLoginRequest(String email, String code) {}

    public record ResetPasswordRequest(String email, String code, String password) {}

    public record EmailSignIn(boolean enabled) {}

    public record UserDto(
            UUID id,
            String username,
            String email,
            String displayName,
            String avatarUrl,
            String role,
            boolean hasPassword,
            Instant createdAt) {

        public static UserDto of(UserRow u) {
            return new UserDto(u.id(), u.username(), u.email(), u.displayName(), u.avatarUrl(), u.role(),
                    u.passwordHash() != null, u.createdAt());
        }
    }

    public record AuthResponse(
            String accessToken, String refreshToken, String tokenType, long expiresIn, UserDto user) {}
}
