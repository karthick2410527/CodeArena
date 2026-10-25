package dev.voidrun.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.cookie;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.jayway.jsonpath.JsonPath;
import dev.voidrun.api.auth.Tokens;
import dev.voidrun.api.oauth.IdentityService;
import dev.voidrun.api.oauth.OAuthFlowException;
import dev.voidrun.api.oauth.ProviderAccount;
import dev.voidrun.api.web.ApiException;
import jakarta.servlet.http.Cookie;
import java.util.UUID;
import org.hamcrest.Matchers;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/**
 * Provider sign-in. The redirect dance with a real provider is Spring
 * Security's; what is ours, and tested here, is which user an account signs
 * in as, and that the code and link tokens are single-use and browser-bound.
 */
class OAuthIntegrationTest extends ApiTestSupport {

    @Autowired
    IdentityService identities;

    static ProviderAccount github(String subject, String email, String login) {
        return new ProviderAccount("github", subject, email, email != null, login, "Ada L", null, login);
    }

    static ProviderAccount google(String subject, String email) {
        return new ProviderAccount("google", subject, email, true, null, "Ada", null, "ada");
    }

    @Test
    void bothProvidersAreListedAndOnlyConfiguredOnesAreUsable() throws Exception {
        mvc.perform(get("/api/v1/auth/providers"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(2))
                .andExpect(jsonPath("$[0].id").value("google"))
                .andExpect(jsonPath("$[0].enabled").value(false))
                .andExpect(jsonPath("$[0].authorize_url").doesNotExist())
                .andExpect(jsonPath("$[1].id").value("github"))
                .andExpect(jsonPath("$[1].name").value("GitHub"))
                .andExpect(jsonPath("$[1].enabled").value(true))
                .andExpect(jsonPath("$[1].authorize_url").value("/oauth2/authorization/github"));
    }

    @Test
    void authorizationRedirectGoesToGitHubWithState() throws Exception {
        String location = mvc.perform(get("/oauth2/authorization/github"))
                .andExpect(status().is3xxRedirection())
                .andReturn().getResponse().getHeader("Location");
        assertThat(location).startsWith("https://github.com/login/oauth/authorize")
                .contains("client_id=test-client", "state=", "scope=read:user%20user:email");
        mvc.perform(get("/oauth2/authorization/google")).andExpect(status().isNotFound());
    }

    @Test
    void sameProviderAccountAlwaysSignsInAsTheSameUser() {
        String subject = unique("gh");
        UUID first = identities.signIn(github(subject, null, unique("octo")));
        UUID again = identities.signIn(github(subject, null, "renamed-login"));
        assertThat(again).isEqualTo(first);
        boolean noEmail = jdbc.sql("SELECT email IS NULL FROM users WHERE id = ?").param(first).query(Boolean.class).single();
        assertThat(noEmail).as("no verified email, so none stored").isTrue();
    }

    @Test
    void verifiedEmailLinksToAnAccountWhoseEmailIsVerified() {
        String email = unique("ada") + "@example.com";
        UUID viaGoogle = identities.signIn(google(unique("g"), email));
        UUID viaGitHub = identities.signIn(github(unique("gh"), email, unique("ada")));
        assertThat(viaGitHub).isEqualTo(viaGoogle);
        assertThat(identities.identities(viaGoogle)).extracting(IdentityService.Identity::provider)
                .containsExactly("google", "github");
    }

    @Test
    void verifiedEmailNeverTakesOverAPasswordAccount() throws Exception {
        // Someone registers a victim's address with a password (email unverified)...
        TestUser squatter = register();
        // ...then the real owner signs in with Google: refused, not merged.
        assertThatThrownBy(() -> identities.signIn(google(unique("g"), squatter.email())))
                .isInstanceOfSatisfying(OAuthFlowException.class, e -> assertThat(e.code()).isEqualTo("email_in_use"));
        long linked = jdbc.sql("SELECT count(*) FROM user_identities WHERE user_id = ?::uuid")
                .param(squatter.id()).query(Long.class).single();
        assertThat(linked).isZero();
    }

    @Test
    void takenUsernamesGetASuffix() throws Exception {
        TestUser existing = register();
        UUID id = identities.signIn(github(unique("gh"), null, existing.username()));
        String username = jdbc.sql("SELECT username FROM users WHERE id = ?").param(id).query(String.class).single();
        assertThat(username).isEqualTo(existing.username() + "-2");
    }

    @Test
    void loginCodeIsSingleUseAndBoundToTheBrowser() throws Exception {
        UUID user = identities.signIn(github(unique("gh"), null, unique("octo")));
        String nonce = Tokens.random();
        String code = identities.issueLoginCode(user, nonce);
        String body = "{\"code\":\"%s\"}".formatted(code);

        // Another browser (no or wrong cookie) cannot redeem it...
        mvc.perform(json(post("/api/v1/auth/oauth/exchange"), body)).andExpect(status().isUnauthorized());
        mvc.perform(json(post("/api/v1/auth/oauth/exchange"), body).cookie(new Cookie("vr_login", Tokens.random())))
                .andExpect(status().isUnauthorized());
        // ...the right one can, once, and the cookie is cleared.
        mvc.perform(json(post("/api/v1/auth/oauth/exchange"), body).cookie(new Cookie("vr_login", nonce)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.user.id").value(user.toString()))
                .andExpect(jsonPath("$.user.has_password").value(false))
                .andExpect(cookie().maxAge("vr_login", 0));
        mvc.perform(json(post("/api/v1/auth/oauth/exchange"), body).cookie(new Cookie("vr_login", nonce)))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void expiredLoginCodeIsRefused() {
        UUID user = identities.signIn(github(unique("gh"), null, unique("octo")));
        String nonce = Tokens.random();
        String code = identities.issueLoginCode(user, nonce);
        jdbc.sql("UPDATE oauth_login_codes SET expires_at = now() - interval '1 second' WHERE code_hash = ?")
                .param(Tokens.hash(code)).update();
        assertThatThrownBy(() -> identities.redeemLoginCode(code, nonce)).isInstanceOf(ApiException.class);
    }

    @Test
    void linkIntentConnectsAProviderToTheSignedInUserOnce() throws Exception {
        TestUser u = register();
        var response = mvc.perform(json(post("/api/v1/auth/oauth/link-intent"), "{\"provider\":\"github\"}")
                        .header("Authorization", u.bearer()))
                .andExpect(status().isOk())
                .andExpect(cookie().httpOnly("vr_link", true))
                .andExpect(jsonPath("$.authorize_url").value(Matchers.startsWith("/oauth2/authorization/github?link=")))
                .andReturn().getResponse();
        String token = ((String) JsonPath.read(response.getContentAsString(), "$.authorize_url"))
                .replaceFirst(".*link=", "");
        String nonce = response.getCookie("vr_link").getValue();

        String subject = unique("gh");
        // Without the browser's cookie nonce the token is useless.
        assertThatThrownBy(() -> identities.link(token, Tokens.random(), github(subject, null, "x")))
                .isInstanceOfSatisfying(OAuthFlowException.class, e -> assertThat(e.code()).isEqualTo("link_expired"));
        UUID linked = identities.link(token, nonce, github(subject, null, unique("octo")));
        assertThat(linked.toString()).isEqualTo(u.id());
        assertThatThrownBy(() -> identities.link(token, nonce, github(subject, null, "x")))
                .isInstanceOfSatisfying(OAuthFlowException.class, e -> assertThat(e.code()).isEqualTo("link_expired"));

        mvc.perform(get("/api/v1/users/me/identities").header("Authorization", u.bearer()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].provider").value("github"));
    }

    @Test
    void aProviderAccountCannotBeLinkedToTwoUsers() throws Exception {
        String subject = unique("gh");
        identities.signIn(github(subject, null, unique("octo")));
        TestUser other = register();
        IdentityService.LinkIntent intent = identities.createLinkIntent(UUID.fromString(other.id()), "github");
        assertThatThrownBy(() -> identities.link(intent.token(), intent.nonce(), github(subject, null, "octo")))
                .isInstanceOfSatisfying(OAuthFlowException.class, e -> assertThat(e.code()).isEqualTo("identity_in_use"));
    }

    @Test
    void theLastWayToSignInCannotBeRemoved() throws Exception {
        UUID providerOnly = identities.signIn(github(unique("gh"), null, unique("octo")));
        String token = issueAccessToken(providerOnly);
        mvc.perform(delete("/api/v1/users/me/identities/github").header("Authorization", "Bearer " + token))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("LAST_SIGN_IN_METHOD"));

        TestUser withPassword = register();
        IdentityService.LinkIntent intent = identities.createLinkIntent(UUID.fromString(withPassword.id()), "github");
        identities.link(intent.token(), intent.nonce(), github(unique("gh"), null, unique("octo")));
        mvc.perform(delete("/api/v1/users/me/identities/github").header("Authorization", withPassword.bearer()))
                .andExpect(status().isNoContent());
        mvc.perform(delete("/api/v1/users/me/identities/github").header("Authorization", withPassword.bearer()))
                .andExpect(status().isNotFound());
    }

    private String issueAccessToken(UUID userId) throws Exception {
        String nonce = Tokens.random();
        String code = identities.issueLoginCode(userId, nonce);
        String body = mvc.perform(json(post("/api/v1/auth/oauth/exchange"), "{\"code\":\"%s\"}".formatted(code))
                        .cookie(new Cookie("vr_login", nonce)))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString();
        return JsonPath.read(body, "$.access_token");
    }
}
