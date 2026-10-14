//! Usage history from Prometheus (cAdvisor series as scraped by kube-prometheus-stack).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};

use crate::k8s::Kind;

#[derive(Debug, Serialize)]
pub struct History {
    /// Seconds between points.
    pub step: u64,
    /// `[unix seconds, cores]`
    pub cpu: Vec<[f64; 2]>,
    /// `[unix seconds, bytes]`
    pub memory: Vec<[f64; 2]>,
}

#[derive(Deserialize)]
struct ApiResponse {
    status: String,
    data: Option<ApiData>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct ApiData {
    result: Vec<Sample>,
}

#[derive(Deserialize)]
struct Sample {
    values: Option<Vec<(f64, String)>>,
}

impl Sample {
    fn series(&self) -> Vec<[f64; 2]> {
        self.values
            .iter()
            .flatten()
            .filter_map(|(t, v)| {
                v.parse::<f64>()
                    .ok()
                    .filter(|v| v.is_finite())
                    .map(|v| [*t, v])
            })
            .collect()
    }
}

/// Container-level cAdvisor series, excluding the pod-level cgroup and pause containers.
const CONTAINERS: &str = r#"container!="",image!="""#;

#[derive(Clone)]
pub struct Prometheus {
    client: reqwest::Client,
    base: String,
}

impl Prometheus {
    pub fn new(base: &str) -> anyhow::Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()?;
        Ok(Self {
            client,
            base: base.trim_end_matches('/').to_string(),
        })
    }

    async fn request(&self, path: &str, params: &[(&str, String)]) -> anyhow::Result<Vec<Sample>> {
        let response: ApiResponse = self
            .client
            .get(format!("{}/api/v1/{path}", self.base))
            .query(params)
            .send()
            .await
            .context("prometheus request failed")?
            .json()
            .await
            .context("invalid prometheus response")?;
        if response.status != "success" {
            bail!(
                "prometheus query failed: {}",
                response.error.unwrap_or_default()
            );
        }
        Ok(response.data.map(|d| d.result).unwrap_or_default())
    }

    /// Summed CPU and memory of a workload's pods over the last `range`.
    pub async fn history(
        &self,
        kind: Kind,
        namespace: &str,
        name: &str,
        range: Duration,
    ) -> anyhow::Result<History> {
        let end = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        // Roughly 120 points per chart, never finer than the 30s scrape interval.
        let step = (range.as_secs() / 120).max(30);
        let window = (step * 2).max(120);
        let selector = format!(
            r#"{CONTAINERS},namespace="{}",pod=~"{}""#,
            escape_label(namespace),
            pod_pattern(kind, name)
        );
        let params = |query: String| {
            vec![
                ("query", query),
                ("start", (end - range.as_secs()).to_string()),
                ("end", end.to_string()),
                ("step", step.to_string()),
            ]
        };
        let cpu_params = params(format!(
            "sum(rate(container_cpu_usage_seconds_total{{{selector}}}[{window}s]))"
        ));
        let memory_params = params(format!(
            "sum(container_memory_working_set_bytes{{{selector}}})"
        ));
        let (cpu, memory) = tokio::try_join!(
            self.request("query_range", &cpu_params),
            self.request("query_range", &memory_params),
        )?;
        let first = |samples: Vec<Sample>| samples.first().map(Sample::series).unwrap_or_default();
        Ok(History {
            step,
            cpu: first(cpu),
            memory: first(memory),
        })
    }
}

fn escape_label(value: &str) -> String {
    value.replace('\\', r"\\").replace('"', "\\\"")
}

/// Regex matching the names of pods a controller creates, including past rollouts,
/// tight enough that `app` does not also match pods of `app-worker`.
pub fn pod_pattern(kind: Kind, name: &str) -> String {
    // Kubernetes names never contain quotes or backslashes; dots must be regex-escaped
    // (written as `\\.` inside the PromQL string literal).
    let name = escape_label(name).replace('.', r"\\.");
    match kind {
        // <name>-<replicaset hash>-<suffix>
        Kind::Deployment => format!("{name}-[a-z0-9]{{6,10}}-[a-z0-9]{{5}}"),
        Kind::StatefulSet => format!("{name}-[0-9]+"),
        Kind::DaemonSet => format!("{name}-[a-z0-9]{{5}}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pod_patterns() {
        assert_eq!(
            pod_pattern(Kind::Deployment, "homectl"),
            "homectl-[a-z0-9]{6,10}-[a-z0-9]{5}"
        );
        assert_eq!(
            pod_pattern(Kind::StatefulSet, "influxdb"),
            "influxdb-[0-9]+"
        );
        assert_eq!(
            pod_pattern(Kind::DaemonSet, "fruitiex.org"),
            r"fruitiex\\.org-[a-z0-9]{5}"
        );
    }
}
