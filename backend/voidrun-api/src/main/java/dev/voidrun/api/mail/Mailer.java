package dev.voidrun.api.mail;

/** Sends the few emails VoidRun sends: sign-in and password-reset codes. */
public interface Mailer {

    /** False when there is no way to deliver mail; the client then hides email sign-in. */
    boolean enabled();

    /** @param html the rich version; {@code text} is shown by clients that do not render HTML */
    void send(String to, String subject, String text, String html);
}
