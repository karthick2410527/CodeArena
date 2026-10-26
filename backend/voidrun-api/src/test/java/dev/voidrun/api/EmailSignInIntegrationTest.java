package dev.voidrun.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

class EmailSignInIntegrationTest extends ApiTestSupport {

    private static final Pattern CODE = Pattern.compile("\\b(\\d{6})\\b");
    private static final AtomicInteger IP = new AtomicInteger(10);

    @Autowired
    CapturingMailer mail;

    /** Each test talks from its own address, so the per-address rate limits never interfere. */
    private final String ip = "10.9.0." + IP.incrementAndGet();

    private MockHttpServletRequestBuilder from(MockHttpServletRequestBuilder b) {
        return b.with(r -> {
            r.setRemoteAddr(ip);
            return r;
        });
    }

    private String requestCode(String email, String purpose) throws Exception {
        int before = mail.to(email).size();
        mvc.perform(json(from(post("/api/v1/auth/email/code")),
                        "{\"email\":\"%s\",\"purpose\":\"%s\"}".formatted(email.toUpperCase(), purpose)))
                .andExpect(status().isAccepted());
        List<CapturingMailer.Mail> sent = mail.to(email);
        assertThat(sent).hasSize(before + 1);
        Matcher m = CODE.matcher(sent.getLast().text());
        assertThat(m.find()).isTrue();
        return m.group(1);
    }

    @Test
    void signsInWithAnEmailedCodeOnce() throws Exception {
        TestUser u = register();
        mvc.perform(get("/api/v1/auth/email")).andExpect(jsonPath("$.enabled").value(true));
        String code = requestCode(u.email(), "login");
        assertThat(mail.to(u.email()).getLast().subject()).contains(code).contains("sign-in");
        assertThat(mail.to(u.email()).getLast().html()).contains(">" + code + "<").contains("/login");

        String wrong = code.equals("000000") ? "111111" : "000000";
        mvc.perform(json(from(post("/api/v1/auth/email/login")), "{\"email\":\"%s\",\"code\":\"%s\"}".formatted(u.email(), wrong)))
                .andExpect(status().isUnauthorized());
        mvc.perform(json(from(post("/api/v1/auth/email/login")), "{\"email\":\"%s\",\"code\":\"%s\"}".formatted(u.email(), code)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.user.username").value(u.username()))
                .andExpect(jsonPath("$.access_token").isString());
        mvc.perform(json(from(post("/api/v1/auth/email/login")), "{\"email\":\"%s\",\"code\":\"%s\"}".formatted(u.email(), code)))
                .andExpect(status().isUnauthorized());
        assertThat(jdbc.sql("SELECT email_verified FROM users WHERE id = ?::uuid").param(u.id()).query(Boolean.class).single())
                .isTrue();
    }

    @Test
    void anUnknownAddressGetsTheSameAnswerAndNoMail() throws Exception {
        String nobody = unique("nobody") + "@example.com";
        mvc.perform(json(from(post("/api/v1/auth/email/code")), "{\"email\":\"%s\"}".formatted(nobody)))
                .andExpect(status().isAccepted());
        assertThat(mail.to(nobody)).isEmpty();
        mvc.perform(json(from(post("/api/v1/auth/email/login")), "{\"email\":\"%s\",\"code\":\"123456\"}".formatted(nobody)))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void aCodeIsBurnedAfterFiveWrongGuesses() throws Exception {
        TestUser u = register();
        String code = requestCode(u.email(), "login");
        String wrong = code.equals("000000") ? "111111" : "000000";
        for (int i = 0; i < 5; i++) {
            mvc.perform(json(from(post("/api/v1/auth/email/login")), "{\"email\":\"%s\",\"code\":\"%s\"}".formatted(u.email(), wrong)))
                    .andExpect(status().isUnauthorized());
        }
        mvc.perform(json(post("/api/v1/auth/email/login").with(r -> {
                            r.setRemoteAddr(ip + "1");
                            return r;
                        }), "{\"email\":\"%s\",\"code\":\"%s\"}".formatted(u.email(), code)))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void asksAgainWithinAMinuteSendsNoSecondMail() throws Exception {
        TestUser u = register();
        requestCode(u.email(), "login");
        mvc.perform(json(from(post("/api/v1/auth/email/code")), "{\"email\":\"%s\"}".formatted(u.email())))
                .andExpect(status().isAccepted());
        assertThat(mail.to(u.email())).hasSize(1);
    }

    @Test
    void resetsThePasswordAndSignsOutOtherSessions() throws Exception {
        TestUser u = register();
        String code = requestCode(u.email(), "reset");
        assertThat(mail.to(u.email()).getLast().subject()).contains("password reset");
        mvc.perform(json(from(post("/api/v1/auth/password/reset")),
                        "{\"email\":\"%s\",\"code\":\"%s\",\"password\":\"short\"}".formatted(u.email(), code)))
                .andExpect(status().isBadRequest());
        mvc.perform(json(from(post("/api/v1/auth/password/reset")),
                        "{\"email\":\"%s\",\"code\":\"%s\",\"password\":\"a brand new one\"}".formatted(u.email(), code)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.user.has_password").value(true));
        mvc.perform(json(post("/api/v1/auth/refresh"), "{\"refresh_token\":\"%s\"}".formatted(u.refreshToken())))
                .andExpect(status().isUnauthorized());
        mvc.perform(json(from(post("/api/v1/auth/login")), "{\"email\":\"%s\",\"password\":\"a brand new one\"}".formatted(u.email())))
                .andExpect(status().isOk());
        mvc.perform(json(from(post("/api/v1/auth/login")), "{\"email\":\"%s\",\"password\":\"%s\"}".formatted(u.email(), u.password())))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void changesTheUsernameAndKeepsTheName() throws Exception {
        TestUser u = register();
        TestUser other = register();
        mvc.perform(json(patch("/api/v1/users/me").header("Authorization", u.bearer()), "{\"display_name\":\"Ada L\"}"))
                .andExpect(status().isOk());
        String fresh = unique("renamed");
        mvc.perform(json(patch("/api/v1/users/me").header("Authorization", u.bearer()), "{\"username\":\"%s\"}".formatted(fresh)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.username").value(fresh))
                .andExpect(jsonPath("$.display_name").value("Ada L"));
        mvc.perform(json(patch("/api/v1/users/me").header("Authorization", u.bearer()),
                        "{\"username\":\"%s\"}".formatted(other.username().toUpperCase())))
                .andExpect(status().isConflict());
        mvc.perform(json(patch("/api/v1/users/me").header("Authorization", u.bearer()), "{\"username\":\"no spaces\"}"))
                .andExpect(status().isBadRequest());
        mvc.perform(json(patch("/api/v1/users/me").header("Authorization", u.bearer()), "{}"))
                .andExpect(status().isBadRequest());
        mvc.perform(get("/api/v1/profiles/" + fresh)).andExpect(status().isOk());
    }
}
