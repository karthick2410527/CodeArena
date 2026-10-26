package dev.voidrun.api.mail;

import java.time.Year;

/**
 * The sign-in and password-reset email, as HTML with a plain-text twin.
 *
 * <p>Email clients are not browsers: the layout is tables with inline styles,
 * no web fonts, no images (often blocked) and no script. The code sits in its
 * own box as one unbroken run of digits, so a double-click copies it whole,
 * and it is also in the subject and the preview line, so most people never
 * need to open the email at all.
 */
public record CodeEmail(String subject, String text, String html) {

    public enum Kind { SIGN_IN, RESET }

    private static final String INK = "#15171c";
    private static final String MUTED = "#4b5260";
    private static final String FAINT = "#8a8f99";
    private static final String LINE = "#e3e1d8";
    private static final String PAPER = "#f6f5f1";
    private static final String ACCENT = "#3a2bea";
    private static final String ACCENT_SOFT = "#efedff";

    /**
     * @param name       how to greet the person (display name or username)
     * @param to         the address it goes to, named in the footer
     * @param actionUrl  where the button leads: the sign-in or reset page
     */
    public static CodeEmail of(Kind kind, String code, String name, String to, long minutes, String actionUrl) {
        boolean signIn = kind == Kind.SIGN_IN;
        String subject = code + (signIn ? " is your VoidRun sign-in code" : " is your VoidRun password reset code");
        String eyebrow = signIn ? "Sign-in code" : "Password reset";
        String title = signIn ? "Here’s your sign-in code" : "Reset your password";
        String lead = signIn
                ? "Enter this code on VoidRun to finish signing in. No password needed."
                : "Enter this code on VoidRun, then choose a new password. You’ll be signed in right after.";
        String button = signIn ? "Open VoidRun" : "Choose a new password";
        String hello = name == null || name.isBlank() ? "Hi," : "Hi " + name.strip() + ",";

        String text = """
                %s

                %s

                    %s

                It works once and expires in %d minutes.
                %s

                Didn't ask for this? You can ignore this email: nobody can get into your account without the code.
                Never share it. VoidRun will never ask you for it.

                VoidRun · practise, compete, and watch your code run
                Sent to %s
                """.formatted(hello, lead, code, minutes, actionUrl, to);

        String html = """
                <!doctype html>
                <html lang="en">
                <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <meta name="color-scheme" content="light only">
                <meta name="supported-color-schemes" content="light only">
                <title>{{subject}}</title>
                </head>
                <body style="margin:0;padding:0;background:{{paper}};-webkit-text-size-adjust:100%;">
                <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">{{preheader}}&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;</div>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{{paper}};">
                  <tr>
                    <td align="center" style="padding:40px 16px;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
                        <tr>
                          <td style="padding:0 4px 20px;">
                            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                              <tr>
                                <td width="32" height="32" align="center" valign="middle" style="width:32px;height:32px;background:{{accent}};border-radius:9px;">
                                  <div style="width:12px;height:12px;border:3px solid #ffffff;border-radius:50%;margin:0 auto;"></div>
                                </td>
                                <td style="padding-left:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:19px;font-weight:700;letter-spacing:-0.3px;color:{{ink}};">VoidRun</td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                        <tr>
                          <td style="background:#ffffff;border:1px solid {{line}};border-radius:18px;overflow:hidden;">
                            <div style="height:4px;background:{{accent}};background-image:linear-gradient(90deg,{{accent}},#7b6cff);font-size:0;line-height:0;">&nbsp;</div>
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                              <tr>
                                <td style="padding:32px 32px 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                                  <p style="margin:0 0 10px;font-size:12px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:{{accent}};">{{eyebrow}}</p>
                                  <h1 style="margin:0 0 14px;font-size:24px;line-height:1.25;font-weight:700;letter-spacing:-0.4px;color:{{ink}};">{{title}}</h1>
                                  <p style="margin:0 0 6px;font-size:15px;line-height:1.6;color:{{muted}};">{{hello}}</p>
                                  <p style="margin:0;font-size:15px;line-height:1.6;color:{{muted}};">{{lead}}</p>
                                </td>
                              </tr>
                              <tr>
                                <td style="padding:22px 32px 6px;">
                                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                                    <tr>
                                      <td align="center" style="background:{{accentSoft}};border:1px dashed #b9b2ff;border-radius:14px;padding:22px 12px;">
                                        <div style="font-family:'SF Mono',SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace;font-size:38px;line-height:1;font-weight:700;letter-spacing:12px;padding-left:12px;color:{{ink}};">{{code}}</div>
                                        <p style="margin:12px 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:{{muted}};">Expires in <strong style="color:{{ink}};">{{minutes}} minutes</strong> &nbsp;·&nbsp; works once</p>
                                      </td>
                                    </tr>
                                  </table>
                                </td>
                              </tr>
                              <tr>
                                <td align="center" style="padding:22px 32px 8px;">
                                  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                                    <tr>
                                      <td align="center" style="background:{{accent}};border-radius:10px;">
                                        <a href="{{actionUrl}}" style="display:inline-block;padding:12px 22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">{{button}} &rarr;</a>
                                      </td>
                                    </tr>
                                  </table>
                                </td>
                              </tr>
                              <tr>
                                <td style="padding:22px 32px 30px;">
                                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                                    <tr>
                                      <td style="border-top:1px solid {{line}};padding-top:18px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:{{muted}};">
                                        <strong style="color:{{ink}};">Didn’t ask for this?</strong> You can ignore this email: nobody can get into your account without the code. Never share it. VoidRun will never ask you for it.
                                      </td>
                                    </tr>
                                  </table>
                                </td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                        <tr>
                          <td align="center" style="padding:22px 12px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:{{faint}};">
                            VoidRun &middot; practise, compete, and watch your code run<br>
                            Sent to {{to}} &middot; &copy; {{year}}
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
                </body>
                </html>
                """
                .replace("{{subject}}", escape(subject))
                .replace("{{preheader}}", escape("Your code is " + code + ". It expires in " + minutes + " minutes."))
                .replace("{{eyebrow}}", escape(eyebrow))
                .replace("{{title}}", escape(title))
                .replace("{{lead}}", escape(lead))
                .replace("{{code}}", escape(code))
                .replace("{{minutes}}", Long.toString(minutes))
                .replace("{{actionUrl}}", escape(actionUrl))
                .replace("{{button}}", escape(button))
                .replace("{{year}}", Integer.toString(Year.now().getValue()))
                .replace("{{paper}}", PAPER)
                .replace("{{ink}}", INK)
                .replace("{{muted}}", MUTED)
                .replace("{{faint}}", FAINT)
                .replace("{{line}}", LINE)
                .replace("{{accentSoft}}", ACCENT_SOFT)
                .replace("{{accent}}", ACCENT)
                // Last, so nothing a person typed into their name is taken for a placeholder.
                .replace("{{to}}", escape(to))
                .replace("{{hello}}", escape(hello));
        return new CodeEmail(subject, text, html);
    }

    static String escape(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")
                .replace("'", "&#39;");
    }
}
