package dev.voidrun.api.security;

import java.util.UUID;
import org.springframework.security.oauth2.jwt.Jwt;

/** Reads the caller out of a verified access token. */
public final class CurrentUser {

    private CurrentUser() {}

    public static UUID id(Jwt jwt) {
        return UUID.fromString(jwt.getSubject());
    }

    public static boolean isAdmin(Jwt jwt) {
        return jwt != null && "ADMIN".equals(jwt.getClaimAsString("role"));
    }
}
