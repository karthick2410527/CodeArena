package dev.voidrun.worker;

import dev.voidrun.recorder.Recorder;
import dev.voidrun.recorder.RecorderConfig;
import dev.voidrun.worker.judge.DockerSandbox;
import dev.voidrun.worker.judge.Sandbox;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
class RecorderConfiguration {

    private static final Logger log = LoggerFactory.getLogger(RecorderConfiguration.class);

    /**
     * Compiles and traces every recording in a throwaway container of the
     * sandbox image: no network, read-only root, no capabilities, bounded
     * memory, CPU and processes ({@link RecorderConfig#dockerLauncher}).
     */
    @Bean
    ReplayRecorder replayRecorder(WorkerProperties props) {
        WorkerProperties.Replay r = props.replay();
        RecorderConfig config = RecorderConfig.docker(r.image())
                .withMaxSteps(r.maxSteps())
                .withMaxTraceTime(r.maxTime());
        if (!r.launcher().isEmpty()) {
            config = config.withLauncher(r.launcher());
        }
        log.info("recording in {} (work dir {})", String.join(" ", config.launcher()),
                r.workPath() == null ? "system temp" : r.workPath());
        Recorder recorder = new Recorder(config, r.workPath());
        return recorder::record;
    }

    /** The judge's sandbox: one container of the runner image per job (see {@link DockerSandbox}). */
    @Bean
    Sandbox sandbox(WorkerProperties props) {
        WorkerProperties.Judge j = props.judge();
        log.info("judging in {} (work dir {}, compile cache {})", j.image(),
                j.workPath() == null ? "system temp" : j.workPath(),
                j.cachePath() == null ? "off" : j.cachePath() + ", " + j.cacheEntries() + " entries");
        return new DockerSandbox(j.image(), j.workPath(), j.keptOutputBytes(), j.cachePath(), j.cacheEntries());
    }
}
