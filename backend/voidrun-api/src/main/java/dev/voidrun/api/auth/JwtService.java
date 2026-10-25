package dev.voidrun.api.auth;

import com.nimbusds.jose.jwk.source.ImmutableSecret;
import dev.voidrun.api.config.VoidRunProperties;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder;
import org.springframework.stereotype.Service;

/**
 * Issues and verifies the short-lived HS256 access token. Claims: {@code sub}
 * (user id) and {@code role}, the same shape the Rust API issued. The token is
 * never stored; revocation happens by letting it expire and refusing to
 * refresh.
 */
@Service
public class JwtService {

    private final SecretKey key;
    private final JwtEncoder encoder;
    private final long ttlSeconds;

    public JwtService(VoidRunProperties props) {
        this.key = new SecretKeySpec(props.jwt().secret().getBytes(StandardCharsets.UTF_8), "HmacSHA256");
        this.encoder = new NimbusJwtEncoder(new ImmutableSecret<>(key));
        this.ttlSeconds = props.jwt().accessTokenTtl().toSeconds();
    }

    public String issue(UserRow user) {
        Instant now = Instant.now();
        JwtClaimsSet claims = JwtClaimsSet.builder()
                .subject(user.id().toString())
                .claim("role", user.role())
                .issuedAt(now)
                .expiresAt(now.plusSeconds(ttlSeconds))
                .build();
        JwsHeader header = JwsHeader.with(MacAlgorithm.HS256).build();
        return encoder.encode(JwtEncoderParameters.from(header, claims)).getTokenValue();
    }

    public long ttlSeconds() {
        return ttlSeconds;
    }

    public JwtDecoder decoder() {
        return NimbusJwtDecoder.withSecretKey(key).macAlgorithm(MacAlgorithm.HS256).build();
    }
}
