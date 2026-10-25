package dev.voidrun.api.oauth;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpHeaders;
import org.springframework.security.oauth2.client.userinfo.DefaultOAuth2UserService;
import org.springframework.security.oauth2.client.userinfo.OAuth2UserRequest;
import org.springframework.security.oauth2.client.userinfo.OAuth2UserService;
import org.springframework.security.oauth2.core.user.DefaultOAuth2User;
import org.springframework.security.oauth2.core.user.OAuth2User;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/**
 * Loads a GitHub user and adds the primary <em>verified</em> email.
 *
 * <p>The {@code email} field on GitHub's {@code /user} is whatever the person
 * chose to make public, verified or not, so it is never trusted. Only
 * {@code /user/emails} says which address is verified.
 */
@Component
public class GitHubUserService implements OAuth2UserService<OAuth2UserRequest, OAuth2User> {

    private static final Logger log = LoggerFactory.getLogger(GitHubUserService.class);

    private final DefaultOAuth2UserService delegate = new DefaultOAuth2UserService();
    private final RestClient github;

    public GitHubUserService() {
        this.github = RestClient.builder().baseUrl("https://api.github.com").build();
    }

    @Override
    public OAuth2User loadUser(OAuth2UserRequest request) {
        OAuth2User user = delegate.loadUser(request);
        if (!OAuthProviders.GITHUB.equals(request.getClientRegistration().getRegistrationId())) {
            return user;
        }
        Map<String, Object> attributes = new HashMap<>(user.getAttributes());
        attributes.put(ProviderAccount.GITHUB_VERIFIED_EMAIL, primaryVerifiedEmail(request.getAccessToken().getTokenValue()));
        return new DefaultOAuth2User(user.getAuthorities(), attributes, "id");
    }

    private String primaryVerifiedEmail(String accessToken) {
        try {
            List<Map<String, Object>> emails = github.get()
                    .uri("/user/emails")
                    .header(HttpHeaders.AUTHORIZATION, "Bearer " + accessToken)
                    .header(HttpHeaders.ACCEPT, "application/vnd.github+json")
                    .retrieve()
                    .body(new ParameterizedTypeReference<>() {});
            if (emails == null) {
                return null;
            }
            return emails.stream()
                    .filter(e -> Boolean.TRUE.equals(e.get("primary")) && Boolean.TRUE.equals(e.get("verified")))
                    .map(e -> (String) e.get("email"))
                    .findFirst()
                    .orElse(null);
        } catch (RuntimeException e) {
            // Sign-in still works without an email; it just cannot be linked by address.
            log.warn("could not read GitHub emails: {}", e.toString());
            return null;
        }
    }
}
