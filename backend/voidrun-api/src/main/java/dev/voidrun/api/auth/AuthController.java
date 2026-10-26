package dev.voidrun.api.auth;

import dev.voidrun.api.auth.AuthDtos.AuthResponse;
import dev.voidrun.api.ratelimit.RateLimiter;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Locale;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {

    private final AuthService auth;
    private final RateLimiter limiter;
    private final EmailCodes codes;

    public AuthController(AuthService auth, RateLimiter limiter, EmailCodes codes) {
        this.auth = auth;
        this.limiter = limiter;
        this.codes = codes;
    }

    @PostMapping("/register")
    @ResponseStatus(HttpStatus.CREATED)
    AuthResponse register(@RequestBody AuthDtos.RegisterRequest req, HttpServletRequest http) {
        limiter.check("register", http.getRemoteAddr(),
                "too many accounts created from this address; please try again later");
        return auth.register(req);
    }

    @PostMapping("/login")
    AuthResponse login(@RequestBody AuthDtos.LoginRequest req, HttpServletRequest http) {
        // Before any password work: this is the endpoint a credential stuffer
        // hammers, and Argon2 verification is deliberately expensive.
        limiter.check("login", http.getRemoteAddr(), "too many login attempts; please wait and try again");
        return auth.login(req);
    }

    /** Whether this server can email sign-in codes. */
    @GetMapping("/email")
    AuthDtos.EmailSignIn email() {
        return new AuthDtos.EmailSignIn(codes.enabled());
    }

    /** Always 202, whether or not an account has the address, so it cannot be used to find accounts. */
    @PostMapping("/email/code")
    @ResponseStatus(HttpStatus.ACCEPTED)
    void emailCode(@RequestBody AuthDtos.EmailCodeRequest req, HttpServletRequest http) {
        String message = "too many codes requested; please wait a few minutes";
        limiter.check("email-code", http.getRemoteAddr(), message);
        String email = req.email() == null ? "" : req.email().trim().toLowerCase(Locale.ROOT);
        limiter.check("email-code", "to:" + email, message);
        EmailCodes.Purpose purpose = "reset".equalsIgnoreCase(req.purpose()) ? EmailCodes.Purpose.RESET
                : EmailCodes.Purpose.LOGIN;
        codes.send(req.email(), purpose);
    }

    @PostMapping("/email/login")
    AuthResponse emailLogin(@RequestBody AuthDtos.CodeLoginRequest req, HttpServletRequest http) {
        limiter.check("login", http.getRemoteAddr(), "too many sign-in attempts; please wait and try again");
        return auth.loginWithCode(req);
    }

    @PostMapping("/password/reset")
    AuthResponse resetPassword(@RequestBody AuthDtos.ResetPasswordRequest req, HttpServletRequest http) {
        limiter.check("login", http.getRemoteAddr(), "too many attempts; please wait and try again");
        return auth.resetPassword(req);
    }

    @PostMapping("/refresh")
    AuthResponse refresh(@RequestBody AuthDtos.RefreshRequest req) {
        return auth.refresh(req.refreshToken());
    }

    @PostMapping("/logout")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void logout(@RequestBody AuthDtos.RefreshRequest req) {
        auth.logout(req.refreshToken());
    }
}
