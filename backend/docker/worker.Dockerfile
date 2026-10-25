# VoidRun worker. Build from backend/:
#
#   docker build -f docker/worker.Dockerfile -t voidrun-worker .
#
# The worker runs no user code itself: it starts a throwaway, locked-down
# container per job, of the runner image to judge and of the recorder image to
# record a replay. It does that through
# the host's Docker daemon, so docker-compose.yml mounts the daemon socket,
# and it runs as root to be able to use it. Access to that socket is
# root-equivalent on the host, which is the price of Docker-out-of-Docker;
# on a real deployment run workers on dedicated hosts.

FROM eclipse-temurin:21-jdk AS build
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/root/.m2 \
    ./mvnw -B -ntp -q -pl voidrun-worker -am package -DskipTests \
 && cp voidrun-worker/target/voidrun-worker-*.jar /worker.jar

FROM docker:27-cli AS docker-cli

FROM eclipse-temurin:21-jre
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=build /worker.jar /app/worker.jar
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75", "-jar", "/app/worker.jar"]
