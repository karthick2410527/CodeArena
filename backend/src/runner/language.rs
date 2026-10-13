//! Server-defined language registry.
//!
//! Clients send a language *id* and nothing else. Compiler binaries, flags and
//! the executed command are fixed here, in the server, so a request can never
//! influence what is run. Adding a language means adding an entry to `ALL` —
//! there is deliberately no way to inject a command from the outside.

/// A language CodeArena can compile and execute.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Language {
    /// Stable identifier used in the API (`"cpp17"`).
    pub id: &'static str,
    pub display_name: &'static str,
    /// File name the submitted source is written to inside the sandbox.
    pub source_file: &'static str,
    /// File name of the produced executable inside the sandbox.
    pub artifact_file: &'static str,
    /// Compiler program and arguments. Fixed; never built from user input.
    pub compile_argv: &'static [&'static str],
    /// Program and arguments used to execute the artifact, relative to the
    /// sandbox working directory.
    pub run_argv: &'static [&'static str],
    /// Monaco's language id for syntax highlighting.
    pub monaco_id: &'static str,
    /// Starter code shown in a fresh editor.
    pub starter_code: &'static str,
}

const CPP17_STARTER: &str = r#"#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    // Read from stdin, write the answer to stdout.

    return 0;
}
"#;

pub const CPP17: Language = Language {
    id: "cpp17",
    display_name: "C++17 (GCC)",
    source_file: "main.cpp",
    artifact_file: "program",
    compile_argv: &[
        "g++",
        "-std=c++17",
        "-O2",
        "-pipe",
        // Static linking keeps the execution image minimal: the sandbox needs
        // no dynamic loader, no shared libraries and no /lib mount.
        "-static",
        "-s",
        "-o",
        "program",
        "main.cpp",
    ],
    run_argv: &["./program"],
    monaco_id: "cpp",
    starter_code: CPP17_STARTER,
};

/// Every language the judge accepts. Order is the order shown in the UI.
pub const ALL: &[Language] = &[CPP17];

/// Resolves an API language id. Unknown ids are rejected, never guessed.
pub fn find(id: &str) -> Option<&'static Language> {
    ALL.iter().find(|l| l.id == id)
}

/// Comma-separated list of accepted ids, for error messages.
pub fn supported_ids() -> String {
    ALL.iter().map(|l| l.id).collect::<Vec<_>>().join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_known_language_only() {
        assert_eq!(find("cpp17").unwrap().id, "cpp17");
        assert!(find("CPP17").is_none(), "ids are case sensitive and exact");
        assert!(find("python3").is_none());
        assert!(find("cpp17; rm -rf /").is_none());
    }

    #[test]
    fn compile_argv_is_a_fixed_allowlist() {
        // The first element must be a bare program name, never a shell.
        for l in ALL {
            assert!(!l.compile_argv.is_empty());
            let prog = l.compile_argv[0];
            assert!(
                !prog.contains('/'),
                "{prog} must be resolved via PATH, not a path"
            );
            assert!(!["sh", "bash", "env", "eval"].contains(&prog));
        }
    }

    #[test]
    fn supported_ids_lists_cpp17() {
        assert!(supported_ids().contains("cpp17"));
    }
}
