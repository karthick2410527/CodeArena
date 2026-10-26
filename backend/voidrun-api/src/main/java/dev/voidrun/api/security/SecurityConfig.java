package dev.voidrun.api.security;

import dev.voidrun.api.auth.JwtService;
import dev.voidrun.api.config.VoidRunProperties;
import dev.voidrun.api.oauth.GitHubUserService;
import dev.voidrun.api.oauth.LinkAwareAuthorizationRequestResolver;
import dev.voidrun.api.oauth.OAuthLoginHandler;
import dev.voidrun.api.oauth.OAuthProviders;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.client.web.HttpSessionOAuth2AuthorizedClientRepository;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationConverter;
import org.springframework.security.oauth2.server.resource.authentication.JwtGrantedAuthoritiesConverter;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.context.RequestAttributeSecurityContextRepository;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

/**
 * Two filter chains.
 *
 * <ul>
 *   <li><b>Provider redirects</b> ({@code /oauth2/**}, {@code /login/oauth2/**}):
 *       the only place a server session exists, holding the OAuth state and
 *       PKCE values for the few seconds of a redirect. Nothing is
 *       authenticated by it afterwards.</li>
 *   <li><b>API</b>: stateless; every request is authenticated by its bearer
 *       access token alone. CSRF protection is off because no API endpoint is
 *       authorised by a cookie.</li>
 * </ul>
 */
@Configuration
public class SecurityConfig {

    @Bean
    @Order(1)
    SecurityFilterChain providerRedirects(HttpSecurity http, OAuthProviders providers,
            LinkAwareAuthorizationRequestResolver resolver, GitHubUserService gitHubUsers,
            OAuthLoginHandler handler) throws Exception {
        http.securityMatcher("/oauth2/**", "/login/oauth2/**")
                .authorizeHttpRequests(a -> a.anyRequest().permitAll())
                // Never persist the provider login as a session login.
                .securityContext(c -> c.securityContextRepository(new RequestAttributeSecurityContextRepository()))
                .requestCache(c -> c.disable())
                .oauth2Login(o -> o
                        .clientRegistrationRepository(providers)
                        .authorizedClientRepository(new HttpSessionOAuth2AuthorizedClientRepository())
                        .authorizationEndpoint(e -> e.authorizationRequestResolver(resolver))
                        .userInfoEndpoint(u -> u.userService(gitHubUsers))
                        .successHandler(handler)
                        .failureHandler(handler));
        return http.build();
    }

    @Bean
    @Order(2)
    SecurityFilterChain api(HttpSecurity http, JwtDecoder decoder) throws Exception {
        JwtGrantedAuthoritiesConverter roles = new JwtGrantedAuthoritiesConverter();
        roles.setAuthoritiesClaimName("role");
        roles.setAuthorityPrefix("ROLE_");
        JwtAuthenticationConverter converter = new JwtAuthenticationConverter();
        converter.setJwtGrantedAuthoritiesConverter(roles);

        http.csrf(c -> c.disable())
                .cors(Customizer.withDefaults())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(a -> a
                        .requestMatchers("/api/v1/admin/**").hasRole("ADMIN")
                        .requestMatchers(HttpMethod.GET,
                                "/api/v1/problems", "/api/v1/problems/**", "/api/v1/tags",
                                "/api/v1/languages", "/api/v1/limits", "/api/v1/auth/providers", "/api/v1/auth/email",
                                "/api/v1/health", "/api/v1/ready",
                                // Contests and profiles can be browsed signed out, like on Codeforces;
                                // /contests/mine and /contests/joined match here too and ask for a sign-in themselves.
                                "/api/v1/contests", "/api/v1/contests/*", "/api/v1/contests/*/problems/*",
                                "/api/v1/contests/*/standings", "/api/v1/contests/*/live",
                                "/api/v1/contests/*/editorial", "/api/v1/profiles", "/api/v1/profiles/**",
                                "/api/v1/billing/plans").permitAll()
                        .requestMatchers(HttpMethod.POST,
                                "/api/v1/auth/register", "/api/v1/auth/login", "/api/v1/auth/refresh",
                                "/api/v1/auth/logout", "/api/v1/auth/oauth/exchange",
                                "/api/v1/auth/email/code", "/api/v1/auth/email/login", "/api/v1/auth/password/reset",
                                // Razorpay calls this; the body's HMAC signature authenticates it.
                                "/api/v1/billing/webhook").permitAll()
                        .requestMatchers("/actuator/health", "/actuator/health/**", "/error").permitAll()
                        .anyRequest().authenticated())
                .oauth2ResourceServer(o -> o
                        .jwt(j -> j.decoder(decoder).jwtAuthenticationConverter(converter))
                        .authenticationEntryPoint((req, res, e) ->
                                error(res, HttpServletResponse.SC_UNAUTHORIZED, "UNAUTHORIZED", "sign in to continue"))
                        .accessDeniedHandler((req, res, e) ->
                                error(res, HttpServletResponse.SC_FORBIDDEN, "FORBIDDEN", "you do not have access to this")))
                .exceptionHandling(e -> e
                        .authenticationEntryPoint((req, res, ex) ->
                                error(res, HttpServletResponse.SC_UNAUTHORIZED, "UNAUTHORIZED", "sign in to continue"))
                        .accessDeniedHandler((req, res, ex) ->
                                error(res, HttpServletResponse.SC_FORBIDDEN, "FORBIDDEN", "you do not have access to this")));
        return http.build();
    }

    @Bean
    JwtDecoder jwtDecoder(JwtService jwt) {
        return jwt.decoder();
    }

    /** Only the web client's origin; in development the Vite proxy makes most calls same-origin anyway. */
    @Bean
    CorsConfigurationSource corsConfigurationSource(VoidRunProperties props) {
        CorsConfiguration cors = new CorsConfiguration();
        cors.setAllowedOrigins(List.of(props.frontendUrl()));
        cors.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
        cors.setAllowedHeaders(List.of("Authorization", "Content-Type", "X-Correlation-Id"));
        cors.setExposedHeaders(List.of("Retry-After", "X-Correlation-Id"));
        cors.setAllowCredentials(true);
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/api/**", cors);
        return source;
    }

    private static void error(HttpServletResponse res, int status, String code, String message) throws IOException {
        res.setStatus(status);
        res.setContentType(MediaType.APPLICATION_JSON_VALUE);
        res.getWriter().write("{\"error\":{\"code\":\"" + code + "\",\"message\":\"" + message + "\"}}");
    }
}
