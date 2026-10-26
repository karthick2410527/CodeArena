package dev.voidrun.api.mail;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

class CodeEmailTest {

    @Test
    void carriesTheCodeInSubjectTextAndHtml() throws Exception {
        CodeEmail m = CodeEmail.of(CodeEmail.Kind.SIGN_IN, "042917", "Ada", "ada@example.com", 10,
                "https://voidrun.example/login");
        assertThat(m.subject()).isEqualTo("042917 is your VoidRun sign-in code");
        assertThat(m.text()).contains("042917").contains("10 minutes").contains("https://voidrun.example/login");
        assertThat(m.html()).contains(">042917<").contains("href=\"https://voidrun.example/login\"")
                .contains("Hi Ada,").contains("Sent to ada@example.com").doesNotContain("{{");
        // Kept for a look in a browser: target/code-email.html
        Files.writeString(Path.of("target", "code-email.html"), m.html());
    }

    @Test
    void escapesWhatPeopleTypedAndNeverTreatsItAsAPlaceholder() {
        CodeEmail m = CodeEmail.of(CodeEmail.Kind.RESET, "123456", "<b>Eve</b> {{code}}", "eve@example.com", 10,
                "https://voidrun.example/forgot-password");
        assertThat(m.subject()).contains("password reset");
        assertThat(m.html()).contains("Hi &lt;b&gt;Eve&lt;/b&gt; {{code}},").doesNotContain("<b>Eve</b>")
                .contains("Choose a new password");
    }
}
