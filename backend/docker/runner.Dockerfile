# The sandbox image, used only by RUNNER_STRATEGY=docker.
#
# One throw-away container per compile and per execution. The worker supplies
# the exact argv (from the server-side language registry), so this image has no
# ENTRYPOINT and no CMD of its own — there is nothing here for a request to
# influence.
#
# The container is started with --network none, --read-only, --cap-drop ALL,
# --security-opt no-new-privileges, --user 65534:65534, --pids-limit, --memory
# and CPU/file-size ulimits. The Docker socket is never mounted into it.
FROM gcc:13.3.0-bookworm

# Submissions are linked statically (see the language registry), so the
# execution container needs no dynamic loader and no shared libraries beyond
# what the compiler itself uses.
#
# `nobody` (65534) already exists in Debian; the worker passes --user, so no
# USER directive is needed and the image stays usable for both the compile and
# the execute step.

# Mount point for the per-run sandbox directory.
WORKDIR /sandbox

# No ENTRYPOINT and no CMD: `docker run <image> g++ -std=c++17 …` and
# `docker run <image> ./program` are driven entirely by the worker.
