/*
 * vr-run: runs one command under limits and reports what it did.
 *
 *   vr-run WALL_MS CPU_MS AS_MB FSIZE_BYTES STDIN STDOUT STDERR -- CMD [ARG...]
 *
 * Measuring here, inside the sandbox, rather than around `docker exec` from
 * the worker keeps container and exec start-up out of the reported time. The
 * child gets a CPU-time limit, an address-space limit (0 = none, for runtimes
 * that manage their own heap), an output-size limit and no core dumps, in its
 * own process group so a timeout can kill everything it started.
 *
 * Prints one line on stdout:
 *   wall_ms=N cpu_ms=N maxrss_kb=N timed_out=0|1 exit=N     (or signal=N)
 * and exits 0; any other exit status means vr-run itself failed.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static long now_ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1000L + t.tv_nsec / 1000000L;
}

static void limit(int resource, rlim_t value) {
    struct rlimit r = {value, value};
    setrlimit(resource, &r); /* best effort: a lower hard limit stays in force */
}

int main(int argc, char **argv) {
    if (argc < 10 || strcmp(argv[8], "--") != 0) {
        fprintf(stderr, "usage: vr-run WALL_MS CPU_MS AS_MB FSIZE STDIN STDOUT STDERR -- CMD...\n");
        return 2;
    }
    long wall = atol(argv[1]);
    long cpu = atol(argv[2]);
    long as_mb = atol(argv[3]);
    long long fsize = atoll(argv[4]);

    long start = now_ms();
    pid_t pid = fork();
    if (pid < 0) {
        perror("vr-run: fork");
        return 2;
    }
    if (pid == 0) {
        setpgid(0, 0);
        int in = open(argv[5], O_RDONLY);
        int out = open(argv[6], O_WRONLY | O_CREAT | O_TRUNC, 0644);
        int err = open(argv[7], O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (in < 0 || out < 0 || err < 0) _exit(126);
        dup2(in, 0);
        dup2(out, 1);
        dup2(err, 2);
        close(in);
        close(out);
        close(err);
        limit(RLIMIT_CPU, (rlim_t)((cpu + 999) / 1000 + 1));
        limit(RLIMIT_FSIZE, (rlim_t)fsize);
        limit(RLIMIT_CORE, 0);
        limit(RLIMIT_STACK, RLIM_INFINITY); /* deep recursion is normal here */
        if (as_mb > 0) limit(RLIMIT_AS, (rlim_t)as_mb * 1024 * 1024);
        execvp(argv[9], argv + 9);
        _exit(127);
    }

    int status = 0;
    int timed_out = 0;
    struct rusage ru;
    memset(&ru, 0, sizeof ru);
    for (;;) {
        pid_t w = wait4(pid, &status, WNOHANG, &ru);
        if (w == pid) break;
        if (w < 0 && errno != EINTR) {
            perror("vr-run: wait4");
            return 2;
        }
        if (now_ms() - start > wall) {
            timed_out = 1;
            kill(-pid, SIGKILL);
            kill(pid, SIGKILL);
            wait4(pid, &status, 0, &ru);
            break;
        }
        struct timespec pause = {0, 1000000}; /* 1 ms */
        nanosleep(&pause, NULL);
    }
    long elapsed = now_ms() - start;
    kill(-pid, SIGKILL); /* anything it left running */

    long cpu_ms = ru.ru_utime.tv_sec * 1000L + ru.ru_utime.tv_usec / 1000L
                + ru.ru_stime.tv_sec * 1000L + ru.ru_stime.tv_usec / 1000L;
    printf("wall_ms=%ld cpu_ms=%ld maxrss_kb=%ld timed_out=%d ", elapsed, cpu_ms, ru.ru_maxrss, timed_out);
    if (WIFSIGNALED(status)) printf("signal=%d\n", WTERMSIG(status));
    else printf("exit=%d\n", WEXITSTATUS(status));
    return 0;
}
