package dev.voidrun.api.oauth;

import dev.voidrun.api.auth.Tokens;
import dev.voidrun.api.config.VoidRunProperties;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpSession;
import java.io.IOException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.client.authentication.OAuth2AuthenticationToken;
import org.springframework.security.oauth2.core.OAuth2AuthenticationException;
import org.springframework.security.web.authentication.AuthenticationFailureHandler;
import org.springframework.security.web.authentication.AuthenticationSuccessHandler;
import org.springframework.stereotype.Component;

/**
 * Finishes a provider redirect. The API itself stays stateless: the provider
 * session ends here, and the browser goes back to the web client with either
 * a one-time code to trade for tokens, a "linked" confirmation, or an error
 * code. Tokens never travel in a URL.
 */
@Component
public class OAuthLoginHandler implements AuthenticationSuccessHandler, AuthenticationFailureHandler {

    private static final Logger log = LoggerFactory.getLogger(OAuthLoginHandler.class);

    private final IdentityService identities;
    private final String callbackUrl;

    public OAuthLoginHandler(IdentityService identities, VoidRunProperties props) {
        this.identities = identities;
        this.callbackUrl = props.frontendUrl() + "/auth/callback";
    }

    @Override
    public void onAuthenticationSuccess(HttpServletRequest req, HttpServletResponse res, Authentication auth)
            throws IOException {
        OAuth2AuthenticationToken token = (OAuth2AuthenticationToken) auth;
        String provider = token.getAuthorizedClientRegistrationId();
        HttpSession session = req.getSession(false);
        String linkToken = session == null ? null : (String) session.getAttribute(
                LinkAwareAuthorizationRequestResolver.LINK_TOKEN_ATTRIBUTE);
        endProviderSession(req);

        try {
            ProviderAccount acct = ProviderAccount.from(provider, token.getPrincipal());
            if (linkToken != null) {
                identities.link(linkToken, OAuthCookies.read(req, OAuthCookies.LINK), acct);
                OAuthCookies.clear(req, res, OAuthCookies.LINK);
                redirect(res, "linked=" + provider);
                return;
            }
            String nonce = Tokens.random();
            String code = identities.issueLoginCode(identities.signIn(acct), nonce);
            OAuthCookies.set(req, res, OAuthCookies.LOGIN, nonce, IdentityService.LOGIN_CODE_TTL);
            redirect(res, "code=" + code);
        } catch (OAuthFlowException e) {
            log.info("{} sign-in refused ({}): {}", provider, e.code(), e.getMessage());
            redirect(res, "error=" + e.code() + "&provider=" + provider);
        }
    }

    @Override
    public void onAuthenticationFailure(HttpServletRequest req, HttpServletResponse res, AuthenticationException e)
            throws IOException {
        endProviderSession(req);
        String code = e instanceof OAuth2AuthenticationException o && "access_denied".equals(o.getError().getErrorCode())
                ? "access_denied"
                : "provider_error";
        log.info("provider sign-in failed: {}", e.getMessage());
        redirect(res, "error=" + code);
    }

    private void redirect(HttpServletResponse res, String query) throws IOException {
        res.sendRedirect(callbackUrl + "?" + query);
    }

    private static void endProviderSession(HttpServletRequest req) {
        SecurityContextHolder.clearContext();
        HttpSession session = req.getSession(false);
        if (session != null) {
            session.invalidate();
        }
    }
}
