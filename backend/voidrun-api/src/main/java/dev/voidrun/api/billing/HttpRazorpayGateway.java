package dev.voidrun.api.billing;

import dev.voidrun.api.config.VoidRunProperties;
import dev.voidrun.api.web.ApiException;
import java.time.Duration;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

/** Razorpay's Orders API over HTTPS, authenticated with the key id and secret. */
@Component
class HttpRazorpayGateway implements RazorpayGateway {

    private static final Logger log = LoggerFactory.getLogger(HttpRazorpayGateway.class);

    private final RestClient api;

    HttpRazorpayGateway(VoidRunProperties props) {
        VoidRunProperties.Razorpay rp = props.billing().razorpay();
        SimpleClientHttpRequestFactory http = new SimpleClientHttpRequestFactory();
        http.setConnectTimeout(Duration.ofSeconds(5));
        http.setReadTimeout(Duration.ofSeconds(10));
        RestClient.Builder b = RestClient.builder().baseUrl(rp.apiUrl()).requestFactory(http);
        if (rp.configured()) {
            b.defaultHeaders(h -> h.setBasicAuth(rp.keyId(), rp.keySecret()));
        }
        this.api = b.build();
    }

    @Override
    public Order createOrder(int amountPaise, String currency, String receipt, Map<String, String> notes) {
        try {
            Map<?, ?> body = api.post()
                    .uri("/v1/orders")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(Map.of("amount", amountPaise, "currency", currency, "receipt", receipt, "notes", notes))
                    .retrieve()
                    .body(Map.class);
            if (body == null || !(body.get("id") instanceof String id)) {
                throw new RestClientException("no order id in Razorpay's response");
            }
            return new Order(id, ((Number) body.get("amount")).intValue(), (String) body.get("currency"));
        } catch (RestClientException e) {
            log.warn("razorpay order failed: {}", e.getMessage());
            throw ApiException.badGateway("the payment provider is not responding; please try again in a minute");
        }
    }
}
