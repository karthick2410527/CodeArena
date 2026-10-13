//! Output comparison policy.
//!
//! Competitive-programming output is compared *token-wise after whitespace
//! normalisation*, because trailing newlines and line-ending differences are an
//! artefact of how a program prints, not a wrong answer:
//!
//! 1. `\r\n` and `\r` become `\n`.
//! 2. Trailing whitespace is removed from every line.
//! 3. Trailing blank lines are removed from the whole output.
//! 4. The remainder must match **exactly**, byte for byte.
//!
//! Step 4 is deliberate: once whitespace is normalised, `1 2` and `12` are
//! different answers, and so are `0.5` and `0.50`. Nothing is rounded and no
//! token is reordered, so the policy can never accept a wrong answer by being
//! generous. Problems needing tolerance-based checking would need a custom
//! checker, which this phase does not implement.

/// Applies the normalisation policy above.
pub fn normalize(raw: &str) -> String {
    let unified = raw.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines: Vec<&str> = unified
        .split('\n')
        .map(|l| l.trim_end_matches([' ', '\t']))
        .collect();
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    lines.join("\n")
}

/// True when `actual` is an acceptable answer for `expected`.
pub fn matches(actual: &str, expected: &str) -> bool {
    normalize(actual) == normalize(expected)
}

/// First line/column where normalised outputs diverge, as a 1-based
/// `(line, column)`. Used for the diff hint on a user's own submission; it
/// describes *their* output, so it leaks nothing about hidden expectations
/// beyond what the caller already decides to show.
pub fn first_difference(actual: &str, expected: &str) -> Option<(usize, usize)> {
    let a = normalize(actual);
    let b = normalize(expected);
    if a == b {
        return None;
    }
    let mut line = 1usize;
    let mut col = 1usize;
    let mut ai = a.chars();
    let mut bi = b.chars();
    loop {
        match (ai.next(), bi.next()) {
            (Some(x), Some(y)) if x == y => {
                if x == '\n' {
                    line += 1;
                    col = 1;
                } else {
                    col += 1;
                }
            }
            (None, None) => return None,
            _ => return Some((line, col)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trailing_newline_is_ignored() {
        assert!(matches("8\n", "8"));
        assert!(matches("8", "8\n"));
        assert!(matches("8\n\n\n", "8"));
    }

    #[test]
    fn windows_line_endings_are_accepted() {
        assert!(matches("1\r\n2\r\n", "1\n2\n"));
        assert!(matches("1\r2\r", "1\n2"));
    }

    #[test]
    fn trailing_spaces_per_line_are_ignored() {
        assert!(matches("1 2   \n3\t\n", "1 2\n3"));
    }

    #[test]
    fn leading_whitespace_is_significant() {
        assert!(!matches("  8", "8"));
    }

    #[test]
    fn internal_spacing_is_significant() {
        assert!(!matches("1 2", "12"));
        assert!(!matches("1  2", "1 2"));
    }

    #[test]
    fn numeric_formatting_is_significant() {
        assert!(!matches("0.50", "0.5"));
        assert!(!matches("+1", "1"));
    }

    #[test]
    fn case_is_significant() {
        assert!(!matches("yes", "YES"));
    }

    #[test]
    fn blank_lines_in_the_middle_are_significant() {
        assert!(!matches("1\n\n2", "1\n2"));
    }

    #[test]
    fn empty_outputs_match() {
        assert!(matches("", ""));
        assert!(matches("\n\n", ""));
        assert!(!matches("0", ""));
    }

    #[test]
    fn normalize_is_idempotent() {
        let s = "a \r\n b\n\n\n";
        assert_eq!(normalize(&normalize(s)), normalize(s));
    }

    #[test]
    fn first_difference_points_at_the_divergence() {
        assert_eq!(first_difference("8", "8"), None);
        assert_eq!(first_difference("9", "8"), Some((1, 1)));
        assert_eq!(first_difference("12\n34", "12\n35"), Some((2, 2)));
        // Shorter output than expected.
        assert_eq!(first_difference("1", "1\n2"), Some((1, 2)));
    }
}
