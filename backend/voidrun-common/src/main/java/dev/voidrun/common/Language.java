package dev.voidrun.common;

import java.util.Arrays;
import java.util.List;
import java.util.Optional;

/**
 * The languages a submission may be written in. {@code id} is the stable wire
 * value stored with every run and submission; never rename one.
 */
public enum Language {

    CPP17("cpp17", "C++17 (GCC)", "cpp", """
            #include <bits/stdc++.h>
            using namespace std;

            int main() {
                ios::sync_with_stdio(false);
                cin.tie(nullptr);

                return 0;
            }
            """),

    JAVA21("java21", "Java 21", "java", """
            import java.io.*;
            import java.util.*;

            public class Main {
                public static void main(String[] args) throws IOException {
                    BufferedReader in = new BufferedReader(new InputStreamReader(System.in));

                }
            }
            """),

    NODE22("node22", "JavaScript (Node.js 22)", "javascript", """
            const input = require("fs").readFileSync(0, "utf8").split(/\\s+/).filter(Boolean);
            let pos = 0;
            const next = () => input[pos++];

            """);

    private final String id;
    private final String displayName;
    private final String monacoId;
    private final String starterCode;

    Language(String id, String displayName, String monacoId, String starterCode) {
        this.id = id;
        this.displayName = displayName;
        this.monacoId = monacoId;
        this.starterCode = starterCode;
    }

    public String id() {
        return id;
    }

    public String displayName() {
        return displayName;
    }

    public String monacoId() {
        return monacoId;
    }

    public String starterCode() {
        return starterCode;
    }

    public static Optional<Language> find(String id) {
        if (id == null) {
            return Optional.empty();
        }
        String wanted = id.trim();
        return Arrays.stream(values()).filter(l -> l.id.equals(wanted)).findFirst();
    }

    public static List<String> ids() {
        return Arrays.stream(values()).map(Language::id).toList();
    }
}
