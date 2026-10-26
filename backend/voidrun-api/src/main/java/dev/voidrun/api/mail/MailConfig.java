package dev.voidrun.api.mail;

import dev.voidrun.api.config.VoidRunProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import jakarta.mail.MessagingException;
import jakarta.mail.internet.MimeMessage;
import org.springframework.mail.MailPreparationException;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.MimeMessageHelper;

/**
 * Picks how mail goes out: through SMTP when {@code spring.mail.host}
 * (MAIL_HOST) is set, else into the log when {@code voidrun.mail.log-codes}
 * allows it (development), else not at all.
 */
@Configuration(proxyBeanMethods = false)
public class MailConfig {

    private static final Logger log = LoggerFactory.getLogger(MailConfig.class);

    @Bean
    Mailer mailer(ObjectProvider<JavaMailSender> smtp, VoidRunProperties props, Environment env) {
        VoidRunProperties.Mail mail = props.mail();
        // An empty MAIL_HOST still makes Spring Boot create a sender; it would only fail on use.
        boolean hostSet = !env.getProperty("spring.mail.host", "").isBlank();
        JavaMailSender sender = hostSet ? smtp.getIfAvailable() : null;
        if (sender != null) {
            log.info("email sign-in: sending through SMTP as {}", mail.from());
            return new Mailer() {
                @Override
                public boolean enabled() {
                    return true;
                }

                @Override
                public void send(String to, String subject, String text, String html) {
                    MimeMessage m = sender.createMimeMessage();
                    try {
                        MimeMessageHelper h = new MimeMessageHelper(m, true, "UTF-8");
                        h.setFrom(mail.from());
                        h.setTo(to);
                        h.setSubject(subject);
                        h.setText(text, html);
                    } catch (MessagingException e) {
                        throw new MailPreparationException(e);
                    }
                    sender.send(m);
                }
            };
        }
        if (mail.logCodes()) {
            log.warn("email sign-in: no MAIL_HOST, so codes are written to this log instead of being sent");
            return new Mailer() {
                @Override
                public boolean enabled() {
                    return true;
                }

                @Override
                public void send(String to, String subject, String text, String html) {
                    log.info("mail to {}: {}\n{}", to, subject, text);
                }
            };
        }
        log.info("email sign-in: off (no MAIL_HOST)");
        return new Mailer() {
            @Override
            public boolean enabled() {
                return false;
            }

            @Override
            public void send(String to, String subject, String text, String html) {
                throw new IllegalStateException("mail is not configured");
            }
        };
    }
}
