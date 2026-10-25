package dev.voidrun.api.auth;

import java.time.Instant;
import java.util.UUID;

/** A {@code users} row. {@code passwordHash} is null for provider-only accounts. */
public record UserRow(
        UUID id,
        String username,
        String email,
        boolean emailVerified,
        String passwordHash,
        String displayName,
        String avatarUrl,
        String role,
        Instant createdAt) {

    public boolean isAdmin() {
        return "ADMIN".equals(role);
    }
}
