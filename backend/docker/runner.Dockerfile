# Sandbox image that runs and submissions are judged in: g++ with a
# precompiled <bits/stdc++.h>, Java 21, Node.js 22, and vr-run, which runs one
# test under limits and measures it from inside. Build from backend/ (or
# `make runner-image` from the repository root):
#
#   docker build -f docker/runner.Dockerfile -t voidrun-runner docker
#
# The worker starts one container of it per job, compiles once and runs every
# test with `docker exec`:
#
#   docker run -d --network none --read-only --tmpfs /tmp --cap-drop ALL
#     --security-opt no-new-privileges --user 65534:65534 --pids-limit 256
#     --memory ... --cpus 1 -v {work}:/work -w /work voidrun-runner sleep infinity
FROM eclipse-temurin:21-jdk AS java
FROM node:22-bookworm-slim AS node

FROM debian:trixie-slim

# Some networks put a caching proxy in front of plain-HTTP mirrors that serves
# stale indexes ("Hash Sum mismatch"); ask it not to, and retry flaky fetches.
RUN printf 'Acquire::Retries "5";\nAcquire::http::No-Cache "true";\nAcquire::http::Pipeline-Depth "0";\n' \
      > /etc/apt/apt.conf.d/80voidrun-network \
 && apt-get update \
 && apt-get install -y --no-install-recommends g++ \
 && rm -rf /var/lib/apt/lists/*

COPY --from=java /opt/java/openjdk /opt/java/openjdk
COPY --from=node /usr/local/bin/node /usr/local/bin/node
ENV JAVA_HOME=/opt/java/openjdk PATH=/opt/java/openjdk/bin:$PATH LANG=C.UTF-8

COPY runner/vr-run.c /tmp/vr-run.c
RUN gcc -O2 -static -o /usr/local/bin/vr-run /tmp/vr-run.c && rm /tmp/vr-run.c

# Precompile <bits/stdc++.h> with exactly the judge's flags (a PCH is only used
# when they match). Compiling with -I/opt/voidrun/pch finds the .gch before
# the real header, which turns a typical two-second compile into a fraction of
# that. The build fails unless g++ really picks it up ("!" in -H output).
RUN mkdir -p /opt/voidrun/pch/bits \
 && cp "$(find /usr/include -path '*/bits/stdc++.h' | head -n 1)" /opt/voidrun/pch/bits/stdc++.h \
 && g++ -std=c++17 -O2 -pipe -x c++-header /opt/voidrun/pch/bits/stdc++.h -o /opt/voidrun/pch/bits/stdc++.h.gch \
 && printf '#include <bits/stdc++.h>\nint main(){}\n' > /tmp/p.cpp \
 && g++ -std=c++17 -O2 -pipe -I/opt/voidrun/pch -H -o /tmp/p /tmp/p.cpp 2>&1 | grep -q '^! /opt/voidrun/pch/bits/stdc++.h.gch' \
 && rm -f /tmp/p /tmp/p.cpp \
 && java -version && node --version

WORKDIR /work
USER 65534:65534
