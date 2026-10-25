package dev.voidrun.api.oauth;

import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.time.Duration;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;

/**
 * Short-lived HttpOnly cookies that bind a sign-in or link flow to the
 * browser that started it. SameSite=Lax keeps them off cross-site POSTs.
 */
final class OAuthCookies {

    /** Nonce for the login code handed to {@code /auth/callback}. */
    static final String LOGIN = "vr_login";
    /** Nonce for a link intent created by a signed-in user. */
    static final String LINK = "vr_link";

    private OAuthCookies() {}

    static void set(HttpServletRequest req, HttpServletResponse res, String name, String value, Duration ttl) {
        res.addHeader(HttpHeaders.SET_COOKIE, ResponseCookie.from(name, value)
                .httpOnly(true)
                .secure(req.isSecure())
                .sameSite("Lax")
                .path("/")
                .maxAge(ttl)
                .build()
                .toString());
    }

    static void clear(HttpServletRequest req, HttpServletResponse res, String name) {
        set(req, res, name, "", Duration.ZERO);
    }

    static String read(HttpServletRequest req, String name) {
        Cookie[] cookies = req.getCookies();
        if (cookies == null) {
            return null;
        }
        for (Cookie c : cookies) {
            if (name.equals(c.getName()) && !c.getValue().isEmpty()) {
                return c.getValue();
            }
        }
        return null;
    }
}
