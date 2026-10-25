package dev.voidrun.api.config;

import static org.assertj.core.api.Assertions.assertThat;

import dev.voidrun.api.config.VoidRunProperties.Billing;
import dev.voidrun.api.config.VoidRunProperties.Billing.Mode;
import dev.voidrun.api.config.VoidRunProperties.Razorpay;
import org.junit.jupiter.api.Test;

class BillingModeTest {

    private static final Razorpay NONE = new Razorpay(null, null, null, null);
    private static final Razorpay KEYS = new Razorpay("rzp_test_x", "secret", null, null);

    @Test
    void razorpayKeysWinThenTestPaymentsThenOff() {
        assertThat(new Billing(true, true, KEYS, null).mode()).isEqualTo(Mode.RAZORPAY);
        assertThat(new Billing(true, false, KEYS, null).mode()).isEqualTo(Mode.RAZORPAY);
        assertThat(new Billing(true, true, NONE, null).mode()).isEqualTo(Mode.TEST);
        assertThat(new Billing(true, false, NONE, null).mode()).isEqualTo(Mode.OFF);
        assertThat(new Billing(true, false, NONE, null).enabled()).isFalse();
    }

    @Test
    void defaultsRequireAPlanAndAllowTestPayments() {
        Billing b = new Billing(null, null, null, null);
        assertThat(b.required()).isTrue();
        assertThat(b.mode()).isEqualTo(Mode.TEST);
        assertThat(b.plans()).containsKeys("host-monthly", "host-yearly");
    }
}
