//! A small Prometheus-text metrics registry.
//!
//! Hand-rolled on purpose: the service needs counters, gauges and a handful of
//! latency histograms, and that is cheap enough to own outright rather than
//! take a dependency whose feature flags then have to be managed. Everything
//! is lock-free on the read path of a counter increment (`fetch_add`), and the
//! only lock is taken when a new label combination appears for the first time.
//!
//! Exposed at `GET /api/v1/metrics` in Prometheus text format.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::Duration;

/// Latency buckets in seconds. Chosen to straddle both HTTP latency
/// (milliseconds) and judge duration (seconds).
const BUCKETS: &[f64] = &[
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0,
];

type Labels = Vec<(&'static str, String)>;

#[derive(Default)]
struct CounterFamily {
    help: &'static str,
    series: RwLock<BTreeMap<String, Arc<CounterSeries>>>,
}

struct CounterSeries {
    labels: Labels,
    value: AtomicU64,
}

#[derive(Default)]
struct HistogramFamily {
    help: &'static str,
    series: RwLock<BTreeMap<String, Arc<HistogramSeries>>>,
}

struct HistogramSeries {
    labels: Labels,
    buckets: Vec<AtomicU64>,
    count: AtomicU64,
    /// Sum of observations in microseconds, to stay in integer arithmetic.
    sum_micros: AtomicU64,
}

struct GaugeFamily {
    help: &'static str,
    series: RwLock<BTreeMap<String, Arc<GaugeSeries>>>,
}

struct GaugeSeries {
    labels: Labels,
    value: AtomicI64,
}

/// The process-wide registry.
pub struct Registry {
    http_requests: CounterFamily,
    http_duration: HistogramFamily,
    verdicts: CounterFamily,
    runs: CounterFamily,
    run_duration: HistogramFamily,
    judge_duration: HistogramFamily,
    judge_retries: CounterFamily,
    dead_letters: CounterFamily,
    rate_limit_rejections: CounterFamily,
    cache_events: CounterFamily,
    queue_publish: CounterFamily,
    gauges: GaugeFamily,
}

fn key(labels: &Labels) -> String {
    labels
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join(",")
}

impl CounterFamily {
    fn new(help: &'static str) -> Self {
        Self {
            help,
            series: RwLock::new(BTreeMap::new()),
        }
    }

    fn inc_by(&self, labels: Labels, n: u64) {
        let k = key(&labels);
        if let Some(s) = self.series.read().ok().and_then(|m| m.get(&k).cloned()) {
            s.value.fetch_add(n, Ordering::Relaxed);
            return;
        }
        let Ok(mut map) = self.series.write() else {
            return;
        };
        map.entry(k)
            .or_insert_with(|| {
                Arc::new(CounterSeries {
                    labels,
                    value: AtomicU64::new(0),
                })
            })
            .value
            .fetch_add(n, Ordering::Relaxed);
    }

    fn render(&self, name: &str, out: &mut String) {
        let Ok(map) = self.series.read() else { return };
        if map.is_empty() {
            return;
        }
        out.push_str(&format!(
            "# HELP {name} {}\n# TYPE {name} counter\n",
            self.help
        ));
        for s in map.values() {
            out.push_str(&format!(
                "{name}{} {}\n",
                render_labels(&s.labels),
                s.value.load(Ordering::Relaxed)
            ));
        }
    }
}

impl HistogramFamily {
    fn new(help: &'static str) -> Self {
        Self {
            help,
            series: RwLock::new(BTreeMap::new()),
        }
    }

    fn observe(&self, labels: Labels, d: Duration) {
        let k = key(&labels);
        let series = match self.series.read().ok().and_then(|m| m.get(&k).cloned()) {
            Some(s) => s,
            None => {
                let Ok(mut map) = self.series.write() else {
                    return;
                };
                map.entry(k)
                    .or_insert_with(|| {
                        Arc::new(HistogramSeries {
                            labels,
                            buckets: BUCKETS.iter().map(|_| AtomicU64::new(0)).collect(),
                            count: AtomicU64::new(0),
                            sum_micros: AtomicU64::new(0),
                        })
                    })
                    .clone()
            }
        };
        let secs = d.as_secs_f64();
        for (i, b) in BUCKETS.iter().enumerate() {
            if secs <= *b {
                series.buckets[i].fetch_add(1, Ordering::Relaxed);
            }
        }
        series.count.fetch_add(1, Ordering::Relaxed);
        series
            .sum_micros
            .fetch_add(d.as_micros() as u64, Ordering::Relaxed);
    }

    fn render(&self, name: &str, out: &mut String) {
        let Ok(map) = self.series.read() else { return };
        if map.is_empty() {
            return;
        }
        out.push_str(&format!(
            "# HELP {name} {}\n# TYPE {name} histogram\n",
            self.help
        ));
        for s in map.values() {
            for (i, b) in BUCKETS.iter().enumerate() {
                out.push_str(&format!(
                    "{name}_bucket{} {}\n",
                    render_labels_with(&s.labels, Some(("le", &format_float(*b)))),
                    s.buckets[i].load(Ordering::Relaxed)
                ));
            }
            let count = s.count.load(Ordering::Relaxed);
            out.push_str(&format!(
                "{name}_bucket{} {count}\n",
                render_labels_with(&s.labels, Some(("le", "+Inf")))
            ));
            out.push_str(&format!(
                "{name}_sum{} {:.6}\n",
                render_labels(&s.labels),
                s.sum_micros.load(Ordering::Relaxed) as f64 / 1_000_000.0
            ));
            out.push_str(&format!(
                "{name}_count{} {count}\n",
                render_labels(&s.labels)
            ));
        }
    }
}

impl GaugeFamily {
    fn new(help: &'static str) -> Self {
        Self {
            help,
            series: RwLock::new(BTreeMap::new()),
        }
    }

    fn set(&self, labels: Labels, v: i64) {
        let k = key(&labels);
        if let Some(s) = self.series.read().ok().and_then(|m| m.get(&k).cloned()) {
            s.value.store(v, Ordering::Relaxed);
            return;
        }
        let Ok(mut map) = self.series.write() else {
            return;
        };
        map.entry(k)
            .or_insert_with(|| {
                Arc::new(GaugeSeries {
                    labels,
                    value: AtomicI64::new(0),
                })
            })
            .value
            .store(v, Ordering::Relaxed);
    }

    fn render(&self, out: &mut String) {
        let Ok(map) = self.series.read() else { return };
        for s in map.values() {
            let name = s
                .labels
                .iter()
                .find(|(k, _)| *k == "__name__")
                .map(|(_, v)| v.clone())
                .unwrap_or_else(|| "codearena_gauge".into());
            let rest: Labels = s
                .labels
                .iter()
                .filter(|(k, _)| *k != "__name__")
                .cloned()
                .collect();
            out.push_str(&format!(
                "# HELP {name} {}\n# TYPE {name} gauge\n",
                self.help
            ));
            out.push_str(&format!(
                "{name}{} {}\n",
                render_labels(&rest),
                s.value.load(Ordering::Relaxed)
            ));
        }
    }
}

fn format_float(f: f64) -> String {
    if f.fract() == 0.0 {
        format!("{f:.1}")
    } else {
        let s = format!("{f}");
        s
    }
}

fn escape(v: &str) -> String {
    v.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

fn render_labels(labels: &Labels) -> String {
    render_labels_with(labels, None)
}

fn render_labels_with(labels: &Labels, extra: Option<(&str, &str)>) -> String {
    let mut parts: Vec<String> = labels
        .iter()
        .map(|(k, v)| format!("{k}=\"{}\"", escape(v)))
        .collect();
    if let Some((k, v)) = extra {
        parts.push(format!("{k}=\"{}\"", escape(v)));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("{{{}}}", parts.join(","))
    }
}

impl Registry {
    fn new() -> Self {
        Self {
            http_requests: CounterFamily::new("Total HTTP requests handled."),
            http_duration: HistogramFamily::new("HTTP request latency in seconds."),
            verdicts: CounterFamily::new("Final submission verdicts."),
            runs: CounterFamily::new("Completed runs by outcome."),
            run_duration: HistogramFamily::new("Run compile+execute duration in seconds."),
            judge_duration: HistogramFamily::new("Submission judging duration in seconds."),
            judge_retries: CounterFamily::new("Judge attempts retried after a transient failure."),
            dead_letters: CounterFamily::new("Jobs sent to the dead-letter path."),
            rate_limit_rejections: CounterFamily::new("Requests rejected by a rate limit."),
            cache_events: CounterFamily::new("Problem cache hits and misses."),
            queue_publish: CounterFamily::new("Queue publish attempts by result."),
            gauges: GaugeFamily::new("Point-in-time judge and queue gauges."),
        }
    }

    pub fn render(&self) -> String {
        let mut out = String::with_capacity(4096);
        self.http_requests
            .render("codearena_http_requests_total", &mut out);
        self.http_duration
            .render("codearena_http_request_duration_seconds", &mut out);
        self.verdicts.render("codearena_verdicts_total", &mut out);
        self.runs.render("codearena_runs_total", &mut out);
        self.run_duration
            .render("codearena_run_duration_seconds", &mut out);
        self.judge_duration
            .render("codearena_judge_duration_seconds", &mut out);
        self.judge_retries
            .render("codearena_judge_retries_total", &mut out);
        self.dead_letters
            .render("codearena_dead_letters_total", &mut out);
        self.rate_limit_rejections
            .render("codearena_rate_limit_rejections_total", &mut out);
        self.cache_events
            .render("codearena_cache_events_total", &mut out);
        self.queue_publish
            .render("codearena_queue_publish_total", &mut out);
        self.gauges.render(&mut out);
        out
    }
}

pub fn registry() -> &'static Registry {
    static R: OnceLock<Registry> = OnceLock::new();
    R.get_or_init(Registry::new)
}

/// Prometheus text exposition of everything recorded so far.
pub fn render() -> String {
    registry().render()
}

// ----------------------------------------------------------- recording API

pub fn record_http(method: &str, route: &str, status: u16, d: Duration) {
    let labels: Labels = vec![
        ("method", method.to_string()),
        ("route", route.to_string()),
        ("status", status.to_string()),
    ];
    registry().http_requests.inc_by(labels.clone(), 1);
    registry().http_duration.observe(
        vec![("method", method.to_string()), ("route", route.to_string())],
        d,
    );
}

pub fn record_verdict(verdict: &str, d: Duration) {
    registry()
        .verdicts
        .inc_by(vec![("verdict", verdict.to_string())], 1);
    registry().judge_duration.observe(vec![], d);
}

pub fn record_run(outcome: &str, d: Duration) {
    registry()
        .runs
        .inc_by(vec![("outcome", outcome.to_string())], 1);
    if d > Duration::ZERO {
        registry().run_duration.observe(vec![], d);
    }
}

pub fn record_judge_retry(reason: &str) {
    registry()
        .judge_retries
        .inc_by(vec![("reason", reason.to_string())], 1);
}

pub fn record_dead_letter(reason: &str) {
    registry()
        .dead_letters
        .inc_by(vec![("reason", reason.to_string())], 1);
}

pub fn record_rate_limit_rejection(scope: &str) {
    registry()
        .rate_limit_rejections
        .inc_by(vec![("scope", scope.to_string())], 1);
}

pub fn record_cache(event: &str) {
    registry()
        .cache_events
        .inc_by(vec![("event", event.to_string())], 1);
}

pub fn record_queue_publish(driver: &str, result: &str) {
    registry().queue_publish.inc_by(
        vec![
            ("driver", driver.to_string()),
            ("result", result.to_string()),
        ],
        1,
    );
}

pub fn set_gauge(name: &'static str, value: i64) {
    registry()
        .gauges
        .set(vec![("__name__", name.to_string())], value);
}

pub fn set_labelled_gauge(name: &'static str, label: (&'static str, String), value: i64) {
    registry()
        .gauges
        .set(vec![("__name__", name.to_string()), label], value);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counters_and_histograms_render_prometheus_text() {
        record_http("GET", "/api/v1/problems", 200, Duration::from_millis(12));
        record_http("GET", "/api/v1/problems", 200, Duration::from_millis(30));
        record_verdict("ACCEPTED", Duration::from_millis(900));
        set_gauge("codearena_queue_backlog", 7);

        let text = render();
        assert!(text.contains("# TYPE codearena_http_requests_total counter"));
        assert!(text.contains(r#"route="/api/v1/problems""#));
        assert!(text.contains("codearena_http_request_duration_seconds_bucket"));
        assert!(text.contains(r#"le="+Inf""#));
        assert!(text.contains("codearena_verdicts_total"));
        assert!(text.contains("codearena_queue_backlog 7"));
        // Every exposed line must be name{labels} value or a comment.
        for line in text
            .lines()
            .filter(|l| !l.starts_with('#') && !l.is_empty())
        {
            assert!(
                line.split(' ').count() == 2,
                "malformed metric line: {line:?}"
            );
        }
    }

    #[test]
    fn label_values_are_escaped() {
        assert_eq!(escape(r#"a"b\c"#), r#"a\"b\\c"#);
        let rendered = render_labels(&vec![("route", "/x\"y".into())]);
        assert_eq!(rendered, r#"{route="/x\"y"}"#);
    }

    #[test]
    fn no_labels_renders_no_braces() {
        assert_eq!(render_labels(&vec![]), "");
    }

    #[test]
    fn bucket_bounds_are_formatted_for_prometheus() {
        assert_eq!(format_float(1.0), "1.0");
        assert_eq!(format_float(0.025), "0.025");
    }
}
