//! Current resource usage from the Kubernetes Metrics API (metrics-server).

use std::collections::HashMap;

use k8s_openapi::api::core::v1::PodSpec;
use kube::api::{ApiResource, DynamicObject, GroupVersionKind, ListParams};
use kube::{Api, Client};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
pub struct Usage {
    /// CPU cores.
    pub cpu: f64,
    /// Working-set memory in bytes.
    pub memory: f64,
}

impl std::ops::AddAssign for Usage {
    fn add_assign(&mut self, other: Self) {
        self.cpu += other.cpu;
        self.memory += other.memory;
    }
}

/// Summed container requests or limits; `None` when no container sets that resource.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
pub struct Resources {
    pub cpu: Option<f64>,
    pub memory: Option<f64>,
}

pub struct Snapshot {
    pub pods: HashMap<(String, String), Usage>,
    pub nodes: HashMap<String, Usage>,
}

fn api(client: &Client, kind: &str, plural: &str) -> Api<DynamicObject> {
    let gvk = GroupVersionKind::gvk("metrics.k8s.io", "v1beta1", kind);
    Api::all_with(
        client.clone(),
        &ApiResource::from_gvk_with_plural(&gvk, plural),
    )
}

fn usage(value: &Value) -> Usage {
    let get = |key: &str| value[key].as_str().and_then(parse_quantity).unwrap_or(0.0);
    Usage {
        cpu: get("cpu"),
        memory: get("memory"),
    }
}

/// Current pod and node usage. `None` when the Metrics API is unavailable.
pub async fn snapshot(client: &Client) -> Option<Snapshot> {
    let lp = ListParams::default();
    let (pods, nodes) = (
        api(client, "PodMetrics", "pods"),
        api(client, "NodeMetrics", "nodes"),
    );
    let (pods, nodes) = match tokio::try_join!(pods.list(&lp), nodes.list(&lp)) {
        Ok(result) => result,
        Err(err) => {
            tracing::debug!(%err, "metrics API unavailable");
            return None;
        }
    };
    let pods = pods
        .items
        .into_iter()
        .map(|pod| {
            let mut total = Usage::default();
            for container in pod.data["containers"].as_array().into_iter().flatten() {
                total += usage(&container["usage"]);
            }
            let key = (
                pod.metadata.namespace.unwrap_or_default(),
                pod.metadata.name.unwrap_or_default(),
            );
            (key, total)
        })
        .collect();
    let nodes = nodes
        .items
        .into_iter()
        .map(|node| {
            (
                node.metadata.name.unwrap_or_default(),
                usage(&node.data["usage"]),
            )
        })
        .collect();
    Some(Snapshot { pods, nodes })
}

/// Sums container requests and limits of a pod spec.
pub fn pod_resources(spec: Option<&PodSpec>) -> (Resources, Resources) {
    let mut requests = Resources::default();
    let mut limits = Resources::default();
    let add = |slot: &mut Option<f64>, value: Option<f64>| {
        if let Some(v) = value {
            *slot = Some(slot.unwrap_or(0.0) + v);
        }
    };
    for container in spec.map(|s| s.containers.as_slice()).unwrap_or_default() {
        let Some(resources) = &container.resources else {
            continue;
        };
        let get =
            |map: &Option<
                std::collections::BTreeMap<
                    String,
                    k8s_openapi::apimachinery::pkg::api::resource::Quantity,
                >,
            >,
             key: &str| { map.as_ref()?.get(key).and_then(|q| parse_quantity(&q.0)) };
        add(&mut requests.cpu, get(&resources.requests, "cpu"));
        add(&mut requests.memory, get(&resources.requests, "memory"));
        add(&mut limits.cpu, get(&resources.limits, "cpu"));
        add(&mut limits.memory, get(&resources.limits, "memory"));
    }
    (requests, limits)
}

/// Parses a Kubernetes quantity (`250m`, `1.5`, `512Mi`, `2G`, `1e3`) to a plain number.
pub fn parse_quantity(value: &str) -> Option<f64> {
    let value = value.trim();
    let split = value
        .find(|c: char| c.is_ascii_alphabetic() && c != 'e' && c != 'E')
        .unwrap_or(value.len());
    let (number, suffix) = value.split_at(split);
    let number: f64 = number.parse().ok()?;
    let multiplier = match suffix {
        "" => 1.0,
        "n" => 1e-9,
        "u" => 1e-6,
        "m" => 1e-3,
        "k" => 1e3,
        "M" => 1e6,
        "G" => 1e9,
        "T" => 1e12,
        "Ki" => 1024.0,
        "Mi" => 1024f64.powi(2),
        "Gi" => 1024f64.powi(3),
        "Ti" => 1024f64.powi(4),
        _ => return None,
    };
    Some(number * multiplier)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantities() {
        assert_eq!(parse_quantity("250m"), Some(0.25));
        assert_eq!(parse_quantity("2"), Some(2.0));
        assert_eq!(parse_quantity("512Mi"), Some(512.0 * 1024.0 * 1024.0));
        assert_eq!(parse_quantity("1G"), Some(1e9));
        assert_eq!(parse_quantity("1e3"), Some(1000.0));
        assert!((parse_quantity("123456789n").unwrap() - 0.123456789).abs() < 1e-12);
        assert_eq!(parse_quantity("9916560Ki"), Some(9916560.0 * 1024.0));
        assert_eq!(parse_quantity("lots"), None);
    }

    #[test]
    fn resources_sum_only_set_values() {
        let spec: PodSpec = serde_json::from_value(serde_json::json!({
            "containers": [
                {"name": "a", "resources": {"limits": {"memory": "256Mi"}, "requests": {"cpu": "100m"}}},
                {"name": "b", "resources": {"limits": {"memory": "256Mi"}}},
            ]
        }))
        .unwrap();
        let (requests, limits) = pod_resources(Some(&spec));
        assert_eq!(requests.cpu, Some(0.1));
        assert_eq!(requests.memory, None);
        assert_eq!(limits.memory, Some(512.0 * 1024.0 * 1024.0));
        assert_eq!(limits.cpu, None);
    }
}
