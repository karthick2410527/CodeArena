# VoidRun API. Build from backend/:
#
#   docker build -f docker/api.Dockerfile -t voidrun-api .

FROM eclipse-temurin:21-jdk AS build
WORKDIR /src
COPY . .
# The cache mount keeps downloaded dependencies between builds, so editing
# code does not re-download the world.
RUN --mount=type=cache,target=/root/.m2 \
    ./mvnw -B -ntp -q -pl voidrun-api -am package -DskipTests \
 && cp voidrun-api/target/voidrun-api-*.jar /api.jar

FROM eclipse-temurin:21-jre
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin voidrun
COPY --from=build /api.jar /app/api.jar
USER voidrun
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD curl -fsS http://localhost:8080/actuator/health || exit 1
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75", "-jar", "/app/api.jar"]
