package dev.voidrun.api.oauth;

import java.util.Map;
import org.springframework.security.oauth2.core.oidc.user.OidcUser;
import org.springframework.security.oauth2.core.user.OAuth2User;

/**
 * What a provider told us about the account that just signed in.
 *
 * @param subject       the provider's stable, never-reassigned account id
 * @param email         an address the provider says the person controls, or null
 * @param emailVerified whether the provider vouches for {@code email}
 * @param usernameHint  starting point for a new VoidRun username
 */
public record ProviderAccount(
        String provider,
        String subject,
        String email,
        boolean emailVerified,
        String login,
        String displayName,
        String avatarUrl,
        String usernameHint) {

    /** Attribute {@link GitHubUserService} adds: the primary verified email, if any. */
    static final String GITHUB_VERIFIED_EMAIL = "voidrun_verified_email";

    static ProviderAccount from(String provider, OAuth2User user) {
        if (OAuthProviders.GOOGLE.equals(provider) && user instanceof OidcUser oidc) {
            String email = oidc.getEmail();
            String hint = oidc.getGivenName() != null ? oidc.getGivenName()
                    : email != null ? email.substring(0, email.indexOf('@')) : null;
            return new ProviderAccount(provider, oidc.getSubject(), email,
                    Boolean.TRUE.equals(oidc.getEmailVerified()), null, oidc.getFullName(), oidc.getPicture(), hint);
        }
        if (OAuthProviders.GITHUB.equals(provider)) {
            Map<String, Object> a = user.getAttributes();
            String email = (String) a.get(GITHUB_VERIFIED_EMAIL);
            String login = (String) a.get("login");
            return new ProviderAccount(provider, String.valueOf(a.get("id")), email, email != null, login,
                    (String) a.get("name"), (String) a.get("avatar_url"), login);
        }
        throw new OAuthFlowException("provider_error", "unsupported provider " + provider);
    }
}
