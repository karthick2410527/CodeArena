package dev.voidrun.api.oauth;

import dev.voidrun.api.config.VoidRunProperties;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.security.config.oauth2.client.CommonOAuth2Provider;
import org.springframework.security.oauth2.client.registration.ClientRegistration;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.stereotype.Component;

/**
 * The sign-in providers that have credentials configured. Unlike Spring
 * Boot's own registration repository this one may be empty, so the API starts
 * and works with passwords alone and each provider appears as soon as its
 * client id and secret are set.
 */
@Component
public class OAuthProviders implements ClientRegistrationRepository, Iterable<ClientRegistration> {

    public static final String GOOGLE = "google";
    public static final String GITHUB = "github";

    private static final Map<String, String> DISPLAY_NAMES = Map.of(GOOGLE, "Google", GITHUB, "GitHub");

    private final Map<String, ClientRegistration> registrations = new LinkedHashMap<>();

    public OAuthProviders(VoidRunProperties props) {
        VoidRunProperties.OAuthClient google = props.oauth().get(GOOGLE);
        if (google != null && google.configured()) {
            registrations.put(GOOGLE, CommonOAuth2Provider.GOOGLE.getBuilder(GOOGLE)
                    .clientId(google.clientId())
                    .clientSecret(google.clientSecret())
                    .scope("openid", "profile", "email")
                    .build());
        }
        VoidRunProperties.OAuthClient github = props.oauth().get(GITHUB);
        if (github != null && github.configured()) {
            registrations.put(GITHUB, CommonOAuth2Provider.GITHUB.getBuilder(GITHUB)
                    .clientId(github.clientId())
                    .clientSecret(github.clientSecret())
                    // user:email is what lets us read the verified address.
                    .scope("read:user", "user:email")
                    .build());
        }
    }

    @Override
    public ClientRegistration findByRegistrationId(String registrationId) {
        return registrations.get(registrationId);
    }

    @Override
    public Iterator<ClientRegistration> iterator() {
        return registrations.values().iterator();
    }

    public boolean enabled(String provider) {
        return registrations.containsKey(provider);
    }

    public static String displayName(String provider) {
        return DISPLAY_NAMES.getOrDefault(provider, provider);
    }

    public List<String> enabledIds() {
        return new ArrayList<>(registrations.keySet());
    }
}
