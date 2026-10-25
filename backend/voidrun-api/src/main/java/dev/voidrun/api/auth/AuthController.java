package dev.voidrun.api.auth;

import dev.voidrun.api.auth.AuthDtos.AuthResponse;
import dev.voidrun.api.ratelimit.RateLimiter;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
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

    public AuthController(AuthService auth, RateLimiter limiter) {
        this.auth = auth;
        this.limiter = limiter;
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
