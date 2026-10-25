package dev.voidrun.api.web;

import org.springframework.http.HttpStatus;

/**
 * An error a client can act on. Rendered as
 * {@code {"error": {"code": ..., "message": ...}}}, the shape the web client
 * already understands. Anything else that escapes a handler is logged and
 * reported as a generic 500, so internals never leak into a response.
 */
public class ApiException extends RuntimeException {

    private final HttpStatus status;
    private final String code;
    private final Long retryAfterSeconds;

    public ApiException(HttpStatus status, String code, String message) {
        this(status, code, message, null);
    }

    private ApiException(HttpStatus status, String code, String message, Long retryAfterSeconds) {
        super(message);
        this.status = status;
        this.code = code;
        this.retryAfterSeconds = retryAfterSeconds;
    }

    public static ApiException badRequest(String message) {
        return new ApiException(HttpStatus.BAD_REQUEST, "BAD_REQUEST", message);
    }

    public static ApiException unauthorized(String message) {
        return new ApiException(HttpStatus.UNAUTHORIZED, "UNAUTHORIZED", message);
    }

    public static ApiException forbidden(String message) {
        return new ApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", message);
    }

    public static ApiException notFound(String message) {
        return new ApiException(HttpStatus.NOT_FOUND, "NOT_FOUND", message);
    }

    public static ApiException conflict(String message) {
        return new ApiException(HttpStatus.CONFLICT, "CONFLICT", message);
    }

    public static ApiException conflict(String code, String message) {
        return new ApiException(HttpStatus.CONFLICT, code, message);
    }

    /** 402: the action needs a paid plan. */
    public static ApiException paymentRequired(String code, String message) {
        return new ApiException(HttpStatus.PAYMENT_REQUIRED, code, message);
    }

    /** 502: a service we depend on (the payment provider) failed. */
    public static ApiException badGateway(String message) {
        return new ApiException(HttpStatus.BAD_GATEWAY, "UPSTREAM_ERROR", message);
    }

    public static ApiException tooManyRequests(String message, long retryAfterSeconds) {
        return new ApiException(HttpStatus.TOO_MANY_REQUESTS, "RATE_LIMITED", message, retryAfterSeconds);
    }

    public HttpStatus status() {
        return status;
    }

    public String code() {
        return code;
    }

    public Long retryAfterSeconds() {
        return retryAfterSeconds;
    }
}
