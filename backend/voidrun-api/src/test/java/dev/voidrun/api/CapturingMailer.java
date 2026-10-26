package dev.voidrun.api;

import dev.voidrun.api.mail.Mailer;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/** Keeps every email instead of sending it, so tests can read the codes. */
public class CapturingMailer implements Mailer {

    public record Mail(String to, String subject, String text, String html) {}

    private final List<Mail> sent = new CopyOnWriteArrayList<>();

    @Override
    public boolean enabled() {
        return true;
    }

    @Override
    public void send(String to, String subject, String text, String html) {
        sent.add(new Mail(to, subject, text, html));
    }

    public List<Mail> to(String address) {
        return sent.stream().filter(m -> m.to().equalsIgnoreCase(address)).toList();
    }
}
