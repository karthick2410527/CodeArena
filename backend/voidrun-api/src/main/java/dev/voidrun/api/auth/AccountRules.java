package dev.voidrun.api.auth;

import dev.voidrun.api.web.ApiException;
import java.util.Locale;
import java.util.regex.Pattern;

/** Validation for usernames, emails and passwords, matching the Rust API's rules. */
public final class AccountRules {

    private static final Pattern USERNAME = Pattern.compile("[A-Za-z0-9_-]{3,32}");

    private AccountRules() {}

    public static String username(String raw) {
        String u = raw == null ? "" : raw.trim();
        if (!USERNAME.matcher(u).matches()) {
            throw ApiException.badRequest("username must be 3-32 characters: letters, digits, '_' or '-'");
        }
        return u;
    }

    public static String email(String raw) {
        String e = raw == null ? "" : raw.trim().toLowerCase(Locale.ROOT);
        int at = e.indexOf('@');
        String domain = at < 0 ? "" : e.substring(at + 1);
        boolean valid = e.length() <= 254
                && e.chars().noneMatch(Character::isWhitespace)
                && at > 0
                && !domain.contains("@")
                && domain.contains(".")
                && !domain.startsWith(".")
                && !domain.endsWith(".");
        if (!valid) {
            throw ApiException.badRequest("email address is not valid");
        }
        return e;
    }

    /**
     * A person's name as they want it shown: 1-60 characters with inner spaces
     * collapsed and no control characters. Null or blank means "no name".
     */
    public static String displayName(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String n = raw.strip().replaceAll("\\s+", " ");
        if (n.codePointCount(0, n.length()) > 60 || n.codePoints().anyMatch(Character::isISOControl)) {
            throw ApiException.badRequest("name must be at most 60 characters");
        }
        return n;
    }

    public static String password(String raw) {
        int n = raw == null ? 0 : raw.codePointCount(0, raw.length());
        if (n < 8 || n > 128) {
            throw ApiException.badRequest("password must be between 8 and 128 characters");
        }
        return raw;
    }

    /**
     * Turns a provider handle or name into a valid username stem: allowed
     * characters only, at least 3 and at most 24 long so a numeric suffix
     * still fits within 32.
     */
    public static String usernameStem(String raw) {
        String s = raw == null ? "" : raw.trim().replaceAll("\\s+", "-").replaceAll("[^A-Za-z0-9_-]", "");
        s = s.replaceAll("^[-_]+", "");
        if (s.length() > 24) {
            s = s.substring(0, 24);
        }
        if (s.length() < 3) {
            s = s + "coder";
        }
        return s;
    }
}
