package dev.voidrun.api.oauth;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.security.oauth2.client.web.DefaultOAuth2AuthorizationRequestResolver;
import org.springframework.security.oauth2.client.web.OAuth2AuthorizationRequestResolver;
import org.springframework.security.oauth2.core.endpoint.OAuth2AuthorizationRequest;
import org.springframework.stereotype.Component;

/**
 * Starts a provider redirect as usual and, when the request carries
 * {@code ?link=<token>}, remembers the token in the (short-lived) OAuth
 * session, so the callback knows to link rather than sign in. A provider that
 * is not configured resolves to nothing, so its URL is a plain 404 rather
 * than an error.
 */
@Component
public class LinkAwareAuthorizationRequestResolver implements OAuth2AuthorizationRequestResolver {

    static final String LINK_TOKEN_ATTRIBUTE = "voidrun.oauth.link-token";
    private static final String BASE_URI = "/oauth2/authorization";

    private final OAuthProviders providers;
    private final DefaultOAuth2AuthorizationRequestResolver delegate;

    public LinkAwareAuthorizationRequestResolver(OAuthProviders providers) {
        this.providers = providers;
        this.delegate = new DefaultOAuth2AuthorizationRequestResolver(providers, BASE_URI);
    }

    @Override
    public OAuth2AuthorizationRequest resolve(HttpServletRequest request) {
        String path = request.getRequestURI().substring(request.getContextPath().length());
        if (path.startsWith(BASE_URI + "/") && !providers.enabled(path.substring(BASE_URI.length() + 1))) {
            return null;
        }
        return remember(request, delegate.resolve(request));
    }

    @Override
    public OAuth2AuthorizationRequest resolve(HttpServletRequest request, String clientRegistrationId) {
        if (!providers.enabled(clientRegistrationId)) {
            return null;
        }
        return remember(request, delegate.resolve(request, clientRegistrationId));
    }

    private static OAuth2AuthorizationRequest remember(HttpServletRequest request, OAuth2AuthorizationRequest auth) {
        if (auth != null) {
            String link = request.getParameter("link");
            if (link != null && !link.isBlank()) {
                request.getSession().setAttribute(LINK_TOKEN_ATTRIBUTE, link);
            } else if (request.getSession(false) != null) {
                request.getSession(false).removeAttribute(LINK_TOKEN_ATTRIBUTE);
            }
        }
        return auth;
    }
}
