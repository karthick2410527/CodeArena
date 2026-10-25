package dev.voidrun.api.oauth;

/**
 * A provider sign-in or link that cannot complete. {@code code} is sent to
 * the web client as {@code /auth/callback?error=<code>}, which shows the
 * matching explanation; the message is for logs only.
 */
public class OAuthFlowException extends RuntimeException {

    private final String code;

    public OAuthFlowException(String code, String message) {
        super(message);
        this.code = code;
    }

    public String code() {
        return code;
    }
}
