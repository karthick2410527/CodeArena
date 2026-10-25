package dev.voidrun.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.jayway.jsonpath.JsonPath;
import dev.voidrun.api.ratelimit.RateLimiter;
import dev.voidrun.api.web.ApiException;
import org.hamcrest.Matchers;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

class AuthIntegrationTest extends ApiTestSupport {

    @Autowired
    RateLimiter limiter;

    @Test
    void registerThenReadMe() throws Exception {
        TestUser u = register();
        mvc.perform(get("/api/v1/users/me").header("Authorization", u.bearer()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.username").value(u.username()))
                .andExpect(jsonPath("$.email").value(u.email()))
                .andExpect(jsonPath("$.role").value("USER"))
                .andExpect(jsonPath("$.has_password").value(true))
                .andExpect(jsonPath("$.created_at").isString());
    }

    @Test
    void duplicateUsernameOrEmailIsAConflict() throws Exception {
        TestUser u = register();
        mvc.perform(json(post("/api/v1/auth/register"),
                        "{\"username\":\"%s\",\"email\":\"other-%s\",\"password\":\"12345678\"}"
                                .formatted(u.username().toUpperCase(), u.email())))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("CONFLICT"));
        mvc.perform(json(post("/api/v1/auth/register"),
                        "{\"username\":\"%s\",\"email\":\"%s\",\"password\":\"12345678\"}"
                                .formatted(unique("x"), u.email().toUpperCase())))
                .andExpect(status().isConflict());
    }

    @Test
    void validationErrorsUseTheErrorEnvelope() throws Exception {
        mvc.perform(json(post("/api/v1/auth/register"), "{\"username\":\"a b\",\"email\":\"a@b.co\",\"password\":\"12345678\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("BAD_REQUEST"))
                .andExpect(jsonPath("$.error.message").value(Matchers.containsString("username")));
        mvc.perform(json(post("/api/v1/auth/register"), "{\"username\":\"abc\",\"email\":\"nope\",\"password\":\"12345678\"}"))
                .andExpect(status().isBadRequest());
        mvc.perform(json(post("/api/v1/auth/register"), "{\"username\":\"abc\",\"email\":\"a@b.co\",\"password\":\"short\"}"))
                .andExpect(status().isBadRequest());
        mvc.perform(json(post("/api/v1/auth/register"), "not json"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("BAD_REQUEST"));
    }

    @Test
    void loginFailuresDoNotSayWhichPartWasWrong() throws Exception {
        TestUser u = register();
        String wrongPassword = mvc.perform(json(post("/api/v1/auth/login"),
                        "{\"email\":\"%s\",\"password\":\"wrong password\"}".formatted(u.email())))
                .andExpect(status().isUnauthorized())
                .andReturn().getResponse().getContentAsString();
        String noAccount = mvc.perform(json(post("/api/v1/auth/login"),
                        "{\"email\":\"nobody-%s\",\"password\":\"wrong password\"}".formatted(u.email())))
                .andExpect(status().isUnauthorized())
                .andReturn().getResponse().getContentAsString();
        assertThat(wrongPassword).isEqualTo(noAccount);
        mvc.perform(json(post("/api/v1/auth/login"),
                        "{\"email\":\"%s\",\"password\":\"%s\"}".formatted(u.email().toUpperCase(), u.password())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.token_type").value("Bearer"))
                .andExpect(jsonPath("$.expires_in").value(900));
    }

    @Test
    void refreshTokensWorkExactlyOnce() throws Exception {
        TestUser u = register();
        String body = "{\"refresh_token\":\"%s\"}".formatted(u.refreshToken());
        String rotated = mvc.perform(json(post("/api/v1/auth/refresh"), body))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString();
        mvc.perform(json(post("/api/v1/auth/refresh"), body)).andExpect(status().isUnauthorized());

        String next = JsonPath.read(rotated, "$.refresh_token");
        mvc.perform(json(post("/api/v1/auth/logout"), "{\"refresh_token\":\"%s\"}".formatted(next)))
                .andExpect(status().isNoContent());
        mvc.perform(json(post("/api/v1/auth/refresh"), "{\"refresh_token\":\"%s\"}".formatted(next)))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void missingOrBadTokensAre401AndUsersCannotReachAdmin() throws Exception {
        mvc.perform(get("/api/v1/users/me"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("UNAUTHORIZED"));
        mvc.perform(get("/api/v1/users/me").header("Authorization", "Bearer not.a.token"))
                .andExpect(status().isUnauthorized());
        TestUser u = register();
        mvc.perform(get("/api/v1/admin/problems").header("Authorization", u.bearer()))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code").value("FORBIDDEN"));
    }

    @Test
    void everyResponseCarriesACorrelationId() throws Exception {
        mvc.perform(get("/api/v1/languages").header("X-Correlation-Id", "trace-123"))
                .andExpect(header().string("X-Correlation-Id", "trace-123"));
        mvc.perform(get("/api/v1/languages").header("X-Correlation-Id", "bad id with spaces"))
                .andExpect(header().string("X-Correlation-Id", Matchers.not("bad id with spaces")));
    }

    @Test
    void rateLimiterRefusesPastTheBudgetWithRetryAfter() {
        String who = unique("ip");
        limiter.check("probe", who, "slow down");
        limiter.check("probe", who, "slow down");
        assertThatThrownBy(() -> limiter.check("probe", who, "slow down"))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.status().value()).isEqualTo(429);
                    assertThat(e.retryAfterSeconds()).isBetween(1L, 60L);
                });
        // Unconfigured buckets are unlimited; another identity has its own budget.
        limiter.check("probe", unique("ip"), "slow down");
        for (int i = 0; i < 10; i++) limiter.check("not-configured", who, "x");
    }

    @Test
    void theNameGivenAtSignUpIsShownAndCanBeChanged() throws Exception {
        String username = unique("named");
        String body = mvc.perform(json(post("/api/v1/auth/register"), """
                        {"username":"%s","email":"%s@example.com","password":"correct horse","display_name":"  Ada   Lovelace "}"""
                        .formatted(username, username)))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.user.display_name").value("Ada Lovelace"))
                .andReturn().getResponse().getContentAsString();
        String bearer = "Bearer " + JsonPath.read(body, "$.access_token");
        mvc.perform(get("/api/v1/profiles/" + username)).andExpect(jsonPath("$.display_name").value("Ada Lovelace"));

        mvc.perform(json(patch("/api/v1/users/me"), "{\"display_name\":\"Ada King\"}").header("Authorization", bearer))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.display_name").value("Ada King"));
        mvc.perform(json(patch("/api/v1/users/me"), "{\"display_name\":\"%s\"}".formatted("x".repeat(61)))
                        .header("Authorization", bearer))
                .andExpect(status().isBadRequest());
        // Blank clears it: the username stands in.
        mvc.perform(json(patch("/api/v1/users/me"), "{\"display_name\":\" \"}").header("Authorization", bearer))
                .andExpect(jsonPath("$.display_name").doesNotExist());
    }
}
