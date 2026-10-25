# Sandbox image for the execution recorder: a compiler, LLDB and its python
# bindings, and nothing else. Build from the backend/ directory (or `make
# recorder-image` from the repository root):
#
#   docker build -f docker/recorder.Dockerfile -t voidrun-recorder docker
#
# The recorder runs each compile and trace inside it with a launcher prefix
# such as:
#
#   docker run --rm -i --network none --read-only --tmpfs /tmp
#     --cap-drop ALL --security-opt no-new-privileges
#     --pids-limit 64 --memory 512m --cpus 1
#     -v {work}:/work -w /work voidrun-recorder
#
# LLDB traces its own child, which ptrace(2) allows without CAP_SYS_PTRACE
# under Docker's default seccomp profile. The tracer leaves ASLR on because
# turning it off needs personality(2), which that profile refuses.
FROM debian:trixie-slim

# Some networks put a caching proxy in front of plain-HTTP mirrors that serves
# stale indexes ("Hash Sum mismatch"); ask it not to, and retry flaky fetches.
RUN printf 'Acquire::Retries "5";\nAcquire::http::No-Cache "true";\nAcquire::http::Pipeline-Depth "0";\n' \
      > /etc/apt/apt.conf.d/80voidrun-network \
 && apt-get update \
 && apt-get install -y --no-install-recommends g++ lldb python3 python3-lldb \
 && rm -rf /var/lib/apt/lists/*

# Debian's python3-lldb links its native module to liblldb.so, which only the
# -dev package ships; point it at the runtime library instead.
RUN for d in /usr/lib/llvm-*/lib; do [ -e "$d/liblldb.so" ] || ln -s liblldb.so.1 "$d/liblldb.so"; done

# LLDB looks for lldb-server next to its own library, which Debian keeps in a
# different directory; tell it where the server is.
ENV LLDB_DEBUGSERVER_PATH=/usr/bin/lldb-server

# Fail the build unless lldb imports the way vr_trace.py finds it at run time.
RUN python3 -c "import subprocess, sys; sys.path.insert(0, subprocess.run(['lldb', '-P'], capture_output=True, text=True).stdout.strip()); import lldb; lldb.SBDebugger"

RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin runner
USER runner
WORKDIR /work
