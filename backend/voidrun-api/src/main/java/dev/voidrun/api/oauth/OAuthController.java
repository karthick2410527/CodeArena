package dev.voidrun.api.oauth;

import dev.voidrun.api.auth.AuthDtos.AuthResponse;
import dev.voidrun.api.auth.AuthService;
import dev.voidrun.api.ratelimit.RateLimiter;
import dev.voidrun.api.security.CurrentUser;
import dev.voidrun.api.web.ApiException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * The JSON half of provider sign-in. The redirect half lives under
 * {@code /oauth2/**} and {@code /login/oauth2/**} and is handled by Spring
 * Security; see {@link OAuthLoginHandler}.
 */
@RestController
@RequestMapping("/api/v1")
public class OAuthController {

    private final OAuthProviders providers;
    private final IdentityService identities;
    private final AuthService auth;
    private final RateLimiter limiter;

    public OAuthController(OAuthProviders providers, IdentityService identities, AuthService auth, RateLimiter limiter) {
        this.providers = providers;
        this.identities = identities;
        this.auth = auth;
        this.limiter = limiter;
    }

    /** {@code authorizeUrl} is null when the provider has no credentials on this server. */
    public record Provider(String id, String name, boolean enabled, String authorizeUrl) {}

    public record ExchangeRequest(String code) {}

    public record LinkRequest(String provider) {}

    public record LinkResponse(String authorizeUrl) {}

    /**
     * Every supported provider, and whether it can be used here. The client
     * always shows both buttons, so a missing configuration is visible rather
     * than looking like the feature does not exist.
     */
    @GetMapping("/auth/providers")
    List<Provider> providers() {
        return List.of(OAuthProviders.GOOGLE, OAuthProviders.GITHUB).stream()
                .map(id -> {
                    boolean on = providers.enabled(id);
                    return new Provider(id, OAuthProviders.displayName(id), on,
                            on ? "/oauth2/authorization/" + id : null);
                })
                .toList();
    }

    /** Trades the one-time code from {@code /auth/callback} for a token pair. Works once, within a minute. */
    @PostMapping("/auth/oauth/exchange")
    AuthResponse exchange(@RequestBody ExchangeRequest req, HttpServletRequest http, HttpServletResponse res) {
        limiter.check("login", http.getRemoteAddr(), "too many sign-in attempts; please wait and try again");
        String nonce = OAuthCookies.read(http, OAuthCookies.LOGIN);
        OAuthCookies.clear(http, res, OAuthCookies.LOGIN);
        return auth.issueTokens(identities.redeemLoginCode(req.code(), nonce));
    }

    /**
     * Starts connecting a provider to the signed-in account. The browser then
     * navigates to {@code authorize_url}; the redirect cannot carry the bearer
     * token, so it carries a single-use link token instead.
     */
    @PostMapping("/auth/oauth/link-intent")
    LinkResponse linkIntent(@AuthenticationPrincipal Jwt jwt, @RequestBody LinkRequest req,
            HttpServletRequest http, HttpServletResponse res) {
        String provider = req.provider() == null ? "" : req.provider().trim();
        if (!providers.enabled(provider)) {
            throw ApiException.badRequest("unknown or disabled provider: " + provider);
        }
        IdentityService.LinkIntent intent = identities.createLinkIntent(CurrentUser.id(jwt), provider);
        OAuthCookies.set(http, res, OAuthCookies.LINK, intent.nonce(), IdentityService.LINK_INTENT_TTL);
        return new LinkResponse("/oauth2/authorization/" + provider + "?link=" + intent.token());
    }

    @GetMapping("/users/me/identities")
    List<IdentityService.Identity> identities(@AuthenticationPrincipal Jwt jwt) {
        return identities.identities(CurrentUser.id(jwt));
    }

    @DeleteMapping("/users/me/identities/{provider}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void unlink(@AuthenticationPrincipal Jwt jwt, @PathVariable String provider) {
        identities.unlink(CurrentUser.id(jwt), provider);
    }
}
