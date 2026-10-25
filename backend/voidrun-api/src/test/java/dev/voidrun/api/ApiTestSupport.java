package dev.voidrun.api;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.jayway.jsonpath.JsonPath;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

@SpringBootTest
@AutoConfigureMockMvc
@Import(TestcontainersConfiguration.class)
@TestPropertySource(properties = {
        "voidrun.jwt.secret=test-secret-test-secret-test-secret-0123",
        "voidrun.frontend-url=http://web.test",
        "voidrun.oauth.github.client-id=test-client",
        "voidrun.oauth.github.client-secret=test-secret",
        "voidrun.rate-limits.login=1000/60",
        "voidrun.rate-limits.register=1000/60",
        "voidrun.rate-limits.run=1000/60",
        "voidrun.rate-limits.submit=1000/60",
        "voidrun.rate-limits.replay=1000/60",
        "voidrun.rate-limits.contest=1000/60",
        "voidrun.rate-limits.import=1000/60",
        "voidrun.outbox.poll-interval-ms=50",
        "voidrun.rate-limits.probe=2/60",
        // Contest tests host freely; BillingIntegrationTest turns the plan requirement on.
        "voidrun.billing.required=false",
})
public abstract class ApiTestSupport {

    private static final AtomicInteger SEQ = new AtomicInteger();

    @Autowired
    protected MockMvc mvc;

    @Autowired
    protected JdbcClient jdbc;

    /** A signed-up user with a fresh access token. */
    public record TestUser(String id, String username, String email, String password, String accessToken,
            String refreshToken) {
        public String bearer() {
            return "Bearer " + accessToken;
        }
    }

    protected static String unique(String prefix) {
        return prefix + SEQ.incrementAndGet() + "-" + UUID.randomUUID().toString().substring(0, 6);
    }

    protected TestUser register() throws Exception {
        String username = unique("u");
        String email = username + "@example.com";
        String body = mvc.perform(json(post("/api/v1/auth/register"),
                        "{\"username\":\"%s\",\"email\":\"%s\",\"password\":\"correct horse\"}"
                                .formatted(username, email)))
                .andExpect(status().isCreated())
                .andReturn().getResponse().getContentAsString();
        return new TestUser(JsonPath.read(body, "$.user.id"), username, email, "correct horse",
                JsonPath.read(body, "$.access_token"), JsonPath.read(body, "$.refresh_token"));
    }

    /** Promotes {@code user} to ADMIN and signs in again so the token carries the role. */
    protected TestUser admin() throws Exception {
        TestUser u = register();
        jdbc.sql("UPDATE users SET role = 'ADMIN' WHERE id = ?::uuid").param(u.id()).update();
        String body = mvc.perform(json(post("/api/v1/auth/login"),
                        "{\"email\":\"%s\",\"password\":\"%s\"}".formatted(u.email(), u.password())))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString();
        return new TestUser(u.id(), u.username(), u.email(), u.password(), JsonPath.read(body, "$.access_token"),
                JsonPath.read(body, "$.refresh_token"));
    }

    protected static MockHttpServletRequestBuilder json(MockHttpServletRequestBuilder b, String body) {
        return b.contentType(MediaType.APPLICATION_JSON).content(body);
    }
}
