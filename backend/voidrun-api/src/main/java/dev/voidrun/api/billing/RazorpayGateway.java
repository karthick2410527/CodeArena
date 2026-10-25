package dev.voidrun.api.billing;

import java.util.Map;

/** The one Razorpay call the server makes: creating an order the browser's checkout then pays. */
public interface RazorpayGateway {

    record Order(String id, int amountPaise, String currency) {}

    /**
     * @param receipt our own reference (the payment row), shown in the Razorpay dashboard
     * @param notes   key-value pairs stored on the order, e.g. the user and plan
     */
    Order createOrder(int amountPaise, String currency, String receipt, Map<String, String> notes);
}
