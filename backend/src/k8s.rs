//! Reads cluster state and condenses it into the shapes the dashboard renders.

use std::collections::{BTreeMap, HashMap};

use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::core::v1::{ContainerStatus, Event, Node, Pod, PodSpec, Service};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{LabelSelector, ObjectMeta, Time};
use kube::api::{ApiResource, DynamicObject, GroupVersionKind, ListParams};
use kube::{Api, Client};
use serde::{Deserialize, Serialize};

use crate::flux::{self, FluxObject, FluxRef, FluxSource};
use crate::metrics::{self, Resources, Usage, parse_quantity, pod_resources};
use crate::prom::Prometheus;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Deployment,
    StatefulSet,
    DaemonSet,
}

impl Kind {
    pub fn parse(value: &str) -> Option<Self> {
        match value.to_ascii_lowercase().as_str() {
            "deployment" => Some(Self::Deployment),
            "statefulset" => Some(Self::StatefulSet),
            "daemonset" => Some(Self::DaemonSet),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Health {
    Healthy,
    Progressing,
    Degraded,
    Failing,
    Idle,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workload {
    pub kind: Kind,
    pub namespace: String,
    pub name: String,
    pub health: Health,
    pub desired: i32,
    pub ready: i32,
    pub updated: i32,
    pub images: Vec<String>,
    pub created_at: Option<String>,
    pub restarted_at: Option<String>,
    pub pod_restarts: i32,
    /// Creation time of the newest live pod, i.e. how long the current rollout has been up.
    pub running_since: Option<String>,
    /// Most relevant problem reported by a pod or the controller, if any.
    pub problem: Option<String>,
    pub urls: Vec<String>,
    pub flux: Option<FluxRef>,
    /// Summed current usage of the workload's pods (Metrics API).
    pub usage: Option<Usage>,
    /// Requests and limits of a single pod, from the pod template.
    pub pod_requests: Resources,
    pub pod_limits: Resources,
    #[serde(skip)]
    pub pod_names: Vec<String>,
    #[serde(skip)]
    pub selector: Option<LabelSelector>,
    #[serde(skip)]
    pub template_labels: BTreeMap<String, String>,
    #[serde(skip)]
    pub rollout_pending: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeSummary {
    pub name: String,
    pub ready: bool,
    pub roles: Vec<String>,
    pub version: Option<String>,
    /// Allocatable CPU cores and memory bytes.
    pub cpu: Option<f64>,
    pub memory: Option<f64>,
    pub usage: Option<Usage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub workloads: Vec<Workload>,
    pub nodes: Vec<NodeSummary>,
    pub flux: Vec<FluxObject>,
    pub sources: Vec<FluxSource>,
    /// Whether current usage (Metrics API) is available.
    pub metrics: bool,
    /// Whether usage history (Prometheus) is available.
    pub history: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerSummary {
    pub name: String,
    pub image: String,
    pub ready: bool,
    pub restarts: i32,
    /// running | waiting | terminated | unknown
    pub state: &'static str,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub started_at: Option<String>,
    pub last_termination: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodSummary {
    pub name: String,
    pub phase: String,
    pub ready: bool,
    pub terminating: bool,
    pub restarts: i32,
    pub node: Option<String>,
    pub ip: Option<String>,
    pub created_at: Option<String>,
    pub containers: Vec<ContainerSummary>,
    pub init_containers: Vec<ContainerSummary>,
    pub usage: Option<Usage>,
    pub requests: Resources,
    pub limits: Resources,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventSummary {
    #[serde(rename = "type")]
    pub kind: String,
    pub reason: String,
    pub message: String,
    pub object: String,
    pub count: i32,
    pub last_seen: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadDetail {
    pub workload: Workload,
    pub pods: Vec<PodSummary>,
    pub events: Vec<EventSummary>,
    pub flux: Option<FluxObject>,
    pub history: bool,
}

fn time(t: &Option<Time>) -> Option<String> {
    t.as_ref().map(|t| t.0.to_string())
}

fn images(spec: Option<&PodSpec>) -> Vec<String> {
    spec.map(|s| {
        s.containers
            .iter()
            .filter_map(|c| c.image.clone())
            .collect()
    })
    .unwrap_or_default()
}

fn restarted_at(template_meta: Option<&ObjectMeta>) -> Option<String> {
    template_meta?
        .annotations
        .as_ref()?
        .get("kubectl.kubernetes.io/restartedAt")
        .cloned()
}

#[allow(clippy::too_many_arguments)]
fn base(
    kind: Kind,
    meta: &ObjectMeta,
    template_meta: Option<&ObjectMeta>,
    spec: Option<&PodSpec>,
    selector: Option<LabelSelector>,
    desired: i32,
    ready: i32,
    updated: i32,
    rollout_pending: bool,
) -> Workload {
    Workload {
        kind,
        namespace: meta.namespace.clone().unwrap_or_default(),
        name: meta.name.clone().unwrap_or_default(),
        health: Health::Healthy,
        desired,
        ready,
        updated,
        images: images(spec),
        created_at: time(&meta.creation_timestamp),
        restarted_at: restarted_at(template_meta),
        pod_restarts: 0,
        running_since: None,
        problem: None,
        urls: Vec::new(),
        flux: FluxRef::from_labels(meta),
        usage: None,
        pod_requests: pod_resources(spec).0,
        pod_limits: pod_resources(spec).1,
        pod_names: Vec::new(),
        selector,
        template_labels: template_meta
            .and_then(|m| m.labels.clone())
            .unwrap_or_default(),
        rollout_pending,
    }
}

fn from_deployment(d: &Deployment) -> Workload {
    let spec = d.spec.as_ref();
    let status = d.status.clone().unwrap_or_default();
    let desired = spec.and_then(|s| s.replicas).unwrap_or(1);
    let generation_pending = match (d.metadata.generation, status.observed_generation) {
        (Some(g), Some(o)) => o < g,
        _ => false,
    };
    let updated = status.updated_replicas.unwrap_or(0);
    let total = status.replicas.unwrap_or(0);
    let mut w = base(
        Kind::Deployment,
        &d.metadata,
        spec.and_then(|s| s.template.metadata.as_ref()),
        spec.and_then(|s| s.template.spec.as_ref()),
        spec.map(|s| s.selector.clone()),
        desired,
        status.ready_replicas.unwrap_or(0),
        updated,
        generation_pending || updated < desired || total > updated,
    );
    let stalled = status.conditions.iter().flatten().find(|c| {
        c.type_ == "Progressing" && c.reason.as_deref() == Some("ProgressDeadlineExceeded")
    });
    if let Some(c) = stalled {
        w.problem = c.message.clone();
    }
    w
}

fn from_statefulset(s: &StatefulSet) -> Workload {
    let spec = s.spec.as_ref();
    let status = s.status.clone().unwrap_or_default();
    let desired = spec.and_then(|s| s.replicas).unwrap_or(1);
    let generation_pending = match (s.metadata.generation, status.observed_generation) {
        (Some(g), Some(o)) => o < g,
        _ => false,
    };
    let updated = status.updated_replicas.unwrap_or(0);
    let revision_pending =
        status.update_revision.is_some() && status.update_revision != status.current_revision;
    base(
        Kind::StatefulSet,
        &s.metadata,
        spec.and_then(|s| s.template.metadata.as_ref()),
        spec.and_then(|s| s.template.spec.as_ref()),
        spec.map(|s| s.selector.clone()),
        desired,
        status.ready_replicas.unwrap_or(0),
        updated,
        generation_pending || revision_pending,
    )
}

fn from_daemonset(d: &DaemonSet) -> Workload {
    let spec = d.spec.as_ref();
    let status = d.status.clone().unwrap_or_default();
    let desired = status.desired_number_scheduled;
    let updated = status.updated_number_scheduled.unwrap_or(0);
    let generation_pending = match (d.metadata.generation, status.observed_generation) {
        (Some(g), Some(o)) => o < g,
        _ => false,
    };
    base(
        Kind::DaemonSet,
        &d.metadata,
        spec.and_then(|s| s.template.metadata.as_ref()),
        spec.and_then(|s| s.template.spec.as_ref()),
        spec.map(|s| s.selector.clone()),
        desired,
        status.number_ready,
        updated,
        generation_pending || updated < desired,
    )
}

pub fn selector_matches(
    selector: Option<&LabelSelector>,
    labels: &BTreeMap<String, String>,
) -> bool {
    let Some(selector) = selector else {
        return false;
    };
    let match_labels = selector.match_labels.iter().flatten();
    let mut any = false;
    for (key, value) in match_labels {
        any = true;
        if labels.get(key) != Some(value) {
            return false;
        }
    }
    for expr in selector.match_expressions.iter().flatten() {
        any = true;
        let current = labels.get(&expr.key);
        let values = expr.values.as_deref().unwrap_or_default();
        let ok = match expr.operator.as_str() {
            "In" => current.is_some_and(|v| values.contains(v)),
            "NotIn" => current.is_none_or(|v| !values.contains(v)),
            "Exists" => current.is_some(),
            "DoesNotExist" => current.is_none(),
            _ => false,
        };
        if !ok {
            return false;
        }
    }
    // An empty selector would match everything, which is never what we want here.
    any
}

/// Waiting/terminated reasons that mean a container is broken rather than starting up.
const BAD_REASONS: &[&str] = &[
    "CrashLoopBackOff",
    "ImagePullBackOff",
    "ErrImagePull",
    "InvalidImageName",
    "CreateContainerConfigError",
    "CreateContainerError",
    "RunContainerError",
    "OOMKilled",
    "Error",
];

fn container_problem(status: &ContainerStatus) -> Option<String> {
    let state = status.state.as_ref()?;
    if let Some(waiting) = &state.waiting {
        let reason = waiting.reason.clone()?;
        if BAD_REASONS.contains(&reason.as_str()) {
            return Some(format!("{}: {}", status.name, reason));
        }
    }
    if let Some(terminated) = &state.terminated
        && terminated.exit_code != 0
    {
        let reason = terminated.reason.clone().unwrap_or_else(|| "Error".into());
        return Some(format!(
            "{}: {} (exit {})",
            status.name, reason, terminated.exit_code
        ));
    }
    None
}

fn pod_problem(pod: &Pod) -> Option<String> {
    let status = pod.status.as_ref()?;
    let containers = status
        .init_container_statuses
        .iter()
        .flatten()
        .chain(status.container_statuses.iter().flatten());
    for c in containers {
        if let Some(p) = container_problem(c) {
            return Some(p);
        }
    }
    if status.phase.as_deref() == Some("Pending") {
        let unschedulable = status.conditions.iter().flatten().find(|c| {
            c.type_ == "PodScheduled"
                && c.status == "False"
                && c.reason.as_deref() == Some("Unschedulable")
        });
        if let Some(c) = unschedulable {
            return Some(c.message.clone().unwrap_or_else(|| "Unschedulable".into()));
        }
    }
    None
}

fn pod_restarts(pod: &Pod) -> i32 {
    pod.status
        .as_ref()
        .and_then(|s| s.container_statuses.as_ref())
        .map(|cs| cs.iter().map(|c| c.restart_count).sum())
        .unwrap_or(0)
}

fn pod_labels(pod: &Pod) -> BTreeMap<String, String> {
    pod.metadata.labels.clone().unwrap_or_default()
}

fn finalize_health(w: &mut Workload, pods: &[&Pod]) {
    w.pod_names = pods
        .iter()
        .filter_map(|p| p.metadata.name.clone())
        .collect();
    w.pod_restarts = pods.iter().map(|p| pod_restarts(p)).sum();
    w.running_since = pods
        .iter()
        .filter(|p| p.metadata.deletion_timestamp.is_none())
        .filter_map(|p| p.metadata.creation_timestamp.as_ref())
        .max()
        .map(|t| t.0.to_string());
    if w.problem.is_none() {
        w.problem = pods
            .iter()
            .filter(|p| p.metadata.deletion_timestamp.is_none())
            .find_map(|p| pod_problem(p));
    }
    w.health = if w.desired == 0 {
        Health::Idle
    } else if w.ready == 0 || (w.problem.is_some() && w.ready < w.desired) {
        if w.rollout_pending && w.problem.is_none() {
            Health::Progressing
        } else {
            Health::Failing
        }
    } else if w.problem.is_some() {
        Health::Degraded
    } else if w.rollout_pending {
        Health::Progressing
    } else if w.ready < w.desired {
        Health::Degraded
    } else {
        Health::Healthy
    };
}

/// HTTPRoute hostnames keyed by (namespace, backend service name).
async fn route_hosts(client: &Client) -> HashMap<(String, String), Vec<String>> {
    let gvk = GroupVersionKind::gvk("gateway.networking.k8s.io", "v1", "HTTPRoute");
    let api: Api<DynamicObject> = Api::all_with(client.clone(), &ApiResource::from_gvk(&gvk));
    let mut out: HashMap<(String, String), Vec<String>> = HashMap::new();
    let routes = match api.list(&ListParams::default()).await {
        Ok(list) => list.items,
        Err(err) => {
            tracing::debug!(%err, "could not list HTTPRoutes");
            return out;
        }
    };
    for route in routes {
        let ns = route.metadata.namespace.clone().unwrap_or_default();
        let spec = &route.data["spec"];
        let hosts: Vec<String> = spec["hostnames"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|h| h.as_str().map(|h| format!("https://{h}")))
            .collect();
        for rule in spec["rules"].as_array().into_iter().flatten() {
            for backend in rule["backendRefs"].as_array().into_iter().flatten() {
                let Some(name) = backend["name"].as_str() else {
                    continue;
                };
                let backend_ns = backend["namespace"].as_str().unwrap_or(&ns).to_string();
                let entry = out.entry((backend_ns, name.to_string())).or_default();
                for host in &hosts {
                    if !entry.contains(host) {
                        entry.push(host.clone());
                    }
                }
            }
        }
    }
    out
}

fn attach_urls(
    workloads: &mut [Workload],
    services: &[Service],
    hosts: &HashMap<(String, String), Vec<String>>,
) {
    for svc in services {
        let ns = svc.metadata.namespace.clone().unwrap_or_default();
        let name = svc.metadata.name.clone().unwrap_or_default();
        let Some(urls) = hosts.get(&(ns.clone(), name)) else {
            continue;
        };
        let Some(selector) = svc.spec.as_ref().and_then(|s| s.selector.as_ref()) else {
            continue;
        };
        if selector.is_empty() {
            continue;
        }
        for w in workloads.iter_mut().filter(|w| w.namespace == ns) {
            if selector
                .iter()
                .all(|(k, v)| w.template_labels.get(k) == Some(v))
            {
                for url in urls {
                    if !w.urls.contains(url) {
                        w.urls.push(url.clone());
                    }
                }
            }
        }
    }
}

#[derive(Clone)]
pub struct Cluster {
    pub client: Client,
    /// When non-empty, only these namespaces are visible.
    pub namespaces: Vec<String>,
    pub prometheus: Option<Prometheus>,
}

impl Cluster {
    pub fn allows(&self, namespace: &str) -> bool {
        self.namespaces.is_empty() || self.namespaces.iter().any(|n| n == namespace)
    }

    fn visible<T: kube::Resource>(&self, items: Vec<T>) -> Vec<T> {
        items
            .into_iter()
            .filter(|i| self.allows(i.meta().namespace.as_deref().unwrap_or_default()))
            .collect()
    }

    async fn workloads_and_pods(&self) -> kube::Result<(Vec<Workload>, Vec<Pod>)> {
        let lp = ListParams::default();
        let c = &self.client;
        let (deps, stss, dss, pods) = (
            Api::<Deployment>::all(c.clone()),
            Api::<StatefulSet>::all(c.clone()),
            Api::<DaemonSet>::all(c.clone()),
            Api::<Pod>::all(c.clone()),
        );
        let (deps, stss, dss, pods) = tokio::try_join!(
            deps.list(&lp),
            stss.list(&lp),
            dss.list(&lp),
            pods.list(&lp)
        )?;
        let mut workloads: Vec<Workload> = self
            .visible(deps.items)
            .iter()
            .map(from_deployment)
            .chain(self.visible(stss.items).iter().map(from_statefulset))
            .chain(self.visible(dss.items).iter().map(from_daemonset))
            .collect();
        let pods = self.visible(pods.items);
        for w in &mut workloads {
            let owned: Vec<&Pod> = pods
                .iter()
                .filter(|p| p.metadata.namespace.as_deref() == Some(&w.namespace))
                .filter(|p| selector_matches(w.selector.as_ref(), &pod_labels(p)))
                .collect();
            finalize_health(w, &owned);
        }
        workloads.sort_by(|a, b| (&a.namespace, &a.name).cmp(&(&b.namespace, &b.name)));
        Ok((workloads, pods))
    }

    pub async fn overview(&self) -> kube::Result<Overview> {
        let c = &self.client;
        let lp = ListParams::default();
        let (services, nodes) = (Api::<Service>::all(c.clone()), Api::<Node>::all(c.clone()));
        let ((mut workloads, _), services, nodes, hosts, flux, sources, usage) = tokio::try_join!(
            self.workloads_and_pods(),
            services.list(&lp),
            nodes.list(&lp),
            async { Ok(route_hosts(c).await) },
            async { Ok(flux::list(c).await) },
            async { Ok(flux::git_sources(c).await) },
            async { Ok(metrics::snapshot(c).await) },
        )?;
        attach_urls(&mut workloads, &services.items, &hosts);
        if let Some(usage) = &usage {
            for w in &mut workloads {
                w.usage = Some(sum_usage(&usage.pods, &w.namespace, &w.pod_names));
            }
        }
        let nodes = nodes
            .items
            .iter()
            .map(|n| {
                let mut summary = node_summary(n);
                summary.usage = usage
                    .as_ref()
                    .and_then(|u| u.nodes.get(&summary.name).copied());
                summary
            })
            .collect();
        let flux = flux
            .into_iter()
            .filter(|f| self.allows(&f.namespace))
            .collect();
        let sources = sources
            .into_iter()
            .filter(|s| self.allows(&s.namespace))
            .collect();
        Ok(Overview {
            workloads,
            nodes,
            flux,
            sources,
            metrics: usage.is_some(),
            history: self.prometheus.is_some(),
        })
    }

    pub async fn detail(
        &self,
        kind: Kind,
        namespace: &str,
        name: &str,
    ) -> kube::Result<Option<WorkloadDetail>> {
        let c = &self.client;
        let lp = ListParams::default();
        let (pods, events, services) = (
            Api::<Pod>::namespaced(c.clone(), namespace),
            Api::<Event>::namespaced(c.clone(), namespace),
            Api::<Service>::namespaced(c.clone(), namespace),
        );
        let (mut workload, pods, events, services, usage) = tokio::try_join!(
            async {
                Ok(match kind {
                    Kind::Deployment => Api::<Deployment>::namespaced(c.clone(), namespace)
                        .get_opt(name)
                        .await?
                        .map(|d| from_deployment(&d)),
                    Kind::StatefulSet => Api::<StatefulSet>::namespaced(c.clone(), namespace)
                        .get_opt(name)
                        .await?
                        .map(|s| from_statefulset(&s)),
                    Kind::DaemonSet => Api::<DaemonSet>::namespaced(c.clone(), namespace)
                        .get_opt(name)
                        .await?
                        .map(|d| from_daemonset(&d)),
                })
            },
            pods.list(&lp),
            events.list(&lp),
            services.list(&lp),
            async { Ok(metrics::snapshot(c).await) },
        )?;
        let Some(w) = workload.as_mut() else {
            return Ok(None);
        };
        let mut owned: Vec<&Pod> = pods
            .items
            .iter()
            .filter(|p| selector_matches(w.selector.as_ref(), &pod_labels(p)))
            .collect();
        owned.sort_by(|a, b| {
            b.metadata
                .creation_timestamp
                .cmp(&a.metadata.creation_timestamp)
        });
        finalize_health(w, &owned);
        attach_urls(
            std::slice::from_mut(w),
            &services.items,
            &route_hosts(c).await,
        );

        let pod_names: Vec<&str> = owned
            .iter()
            .filter_map(|p| p.metadata.name.as_deref())
            .collect();
        let is_related = |e: &Event| {
            let obj = &e.involved_object;
            let obj_name = obj.name.as_deref().unwrap_or_default();
            match obj.kind.as_deref() {
                Some("Pod") => pod_names.contains(&obj_name),
                Some("ReplicaSet") => obj_name
                    .strip_prefix(name)
                    .and_then(|rest| rest.strip_prefix('-'))
                    .is_some_and(|hash| !hash.contains('-')),
                Some(k) => k.eq_ignore_ascii_case(&format!("{kind:?}")) && obj_name == name,
                None => false,
            }
        };
        let mut events: Vec<&Event> = events.items.iter().filter(|e| is_related(e)).collect();
        events.sort_by_key(|e| std::cmp::Reverse(event_time(e)));
        let events = events.into_iter().take(40).map(event_summary).collect();
        let pod_usage = |pod: &Pod| {
            let key = (
                namespace.to_string(),
                pod.metadata.name.clone().unwrap_or_default(),
            );
            usage.as_ref().and_then(|u| u.pods.get(&key).copied())
        };
        let pods = owned
            .into_iter()
            .map(|p| PodSummary {
                usage: pod_usage(p),
                ..pod_summary(p)
            })
            .collect();
        if let Some(usage) = &usage {
            w.usage = Some(sum_usage(&usage.pods, &w.namespace, &w.pod_names));
        }
        let flux = match w.flux.clone() {
            Some(r) if self.allows(&r.namespace) => flux::get(c, &r).await,
            _ => None,
        };
        Ok(workload.map(|workload| WorkloadDetail {
            workload,
            pods,
            events,
            flux,
            history: self.prometheus.is_some(),
        }))
    }
}

fn sum_usage(pods: &HashMap<(String, String), Usage>, namespace: &str, names: &[String]) -> Usage {
    let mut total = Usage::default();
    for name in names {
        if let Some(u) = pods.get(&(namespace.to_string(), name.clone())) {
            total += *u;
        }
    }
    total
}

fn event_time(e: &Event) -> Option<String> {
    time(&e.last_timestamp)
        .or_else(|| e.event_time.as_ref().map(|t| t.0.to_string()))
        .or_else(|| time(&e.first_timestamp))
        .or_else(|| time(&e.metadata.creation_timestamp))
}

fn event_summary(e: &Event) -> EventSummary {
    let obj = &e.involved_object;
    EventSummary {
        kind: e.type_.clone().unwrap_or_else(|| "Normal".into()),
        reason: e.reason.clone().unwrap_or_default(),
        message: e.message.clone().unwrap_or_default().trim().to_string(),
        object: format!(
            "{}/{}",
            obj.kind.as_deref().unwrap_or("?").to_ascii_lowercase(),
            obj.name.as_deref().unwrap_or("?")
        ),
        count: e.count.unwrap_or(1),
        last_seen: event_time(e),
    }
}

fn container_summary(
    image: String,
    status: Option<&ContainerStatus>,
    name: &str,
) -> ContainerSummary {
    let mut summary = ContainerSummary {
        name: name.to_string(),
        image,
        ready: false,
        restarts: 0,
        state: "unknown",
        reason: None,
        message: None,
        started_at: None,
        last_termination: None,
    };
    let Some(status) = status else {
        return summary;
    };
    summary.ready = status.ready;
    summary.restarts = status.restart_count;
    if let Some(state) = &status.state {
        if let Some(running) = &state.running {
            summary.state = "running";
            summary.started_at = time(&running.started_at);
        } else if let Some(waiting) = &state.waiting {
            summary.state = "waiting";
            summary.reason = waiting.reason.clone();
            summary.message = waiting.message.clone();
        } else if let Some(terminated) = &state.terminated {
            summary.state = "terminated";
            summary.reason = terminated.reason.clone();
            summary.message = terminated.message.clone();
        }
    }
    summary.last_termination = status
        .last_state
        .as_ref()
        .and_then(|s| s.terminated.as_ref())
        .map(|t| {
            let reason = t.reason.clone().unwrap_or_else(|| "Terminated".into());
            match time(&t.finished_at) {
                Some(at) => format!("{reason} (exit {}) at {at}", t.exit_code),
                None => format!("{reason} (exit {})", t.exit_code),
            }
        });
    summary
}

fn pod_summary(pod: &Pod) -> PodSummary {
    let spec = pod.spec.as_ref();
    let status = pod.status.as_ref();
    let find = |statuses: Option<&Vec<ContainerStatus>>, name: &str| {
        statuses.and_then(|s| s.iter().find(|c| c.name == name).cloned())
    };
    let containers = spec
        .map(|s| {
            s.containers
                .iter()
                .map(|c| {
                    let st = find(status.and_then(|s| s.container_statuses.as_ref()), &c.name);
                    container_summary(c.image.clone().unwrap_or_default(), st.as_ref(), &c.name)
                })
                .collect()
        })
        .unwrap_or_default();
    let init_containers = spec
        .and_then(|s| s.init_containers.as_ref())
        .map(|ics| {
            ics.iter()
                .map(|c| {
                    let st = find(
                        status.and_then(|s| s.init_container_statuses.as_ref()),
                        &c.name,
                    );
                    container_summary(c.image.clone().unwrap_or_default(), st.as_ref(), &c.name)
                })
                .collect()
        })
        .unwrap_or_default();
    let ready = status
        .and_then(|s| s.conditions.as_ref())
        .is_some_and(|cs| cs.iter().any(|c| c.type_ == "Ready" && c.status == "True"));
    PodSummary {
        name: pod.metadata.name.clone().unwrap_or_default(),
        phase: status
            .and_then(|s| s.phase.clone())
            .unwrap_or_else(|| "Unknown".into()),
        ready,
        terminating: pod.metadata.deletion_timestamp.is_some(),
        restarts: pod_restarts(pod),
        node: spec.and_then(|s| s.node_name.clone()),
        ip: status.and_then(|s| s.pod_ip.clone()),
        created_at: time(&pod.metadata.creation_timestamp),
        containers,
        init_containers,
        usage: None,
        requests: pod_resources(spec).0,
        limits: pod_resources(spec).1,
    }
}

fn node_summary(node: &Node) -> NodeSummary {
    let status = node.status.as_ref();
    let ready = status
        .and_then(|s| s.conditions.as_ref())
        .is_some_and(|cs| cs.iter().any(|c| c.type_ == "Ready" && c.status == "True"));
    let roles = node
        .metadata
        .labels
        .iter()
        .flatten()
        .filter_map(|(k, _)| k.strip_prefix("node-role.kubernetes.io/"))
        .map(str::to_string)
        .collect();
    let allocatable = status.and_then(|s| s.allocatable.as_ref());
    let quantity = |key: &str| {
        allocatable
            .and_then(|a| a.get(key))
            .and_then(|q| parse_quantity(&q.0))
    };
    NodeSummary {
        name: node.metadata.name.clone().unwrap_or_default(),
        ready,
        roles,
        version: status
            .and_then(|s| s.node_info.as_ref())
            .map(|i| i.kubelet_version.clone()),
        cpu: quantity("cpu"),
        memory: quantity("memory"),
        usage: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::LabelSelectorRequirement;

    fn labels(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn selector_matching() {
        let sel = LabelSelector {
            match_labels: Some(labels(&[("app", "web")])),
            match_expressions: Some(vec![LabelSelectorRequirement {
                key: "tier".into(),
                operator: "NotIn".into(),
                values: Some(vec!["db".into()]),
            }]),
        };
        assert!(selector_matches(Some(&sel), &labels(&[("app", "web")])));
        assert!(!selector_matches(
            Some(&sel),
            &labels(&[("app", "web"), ("tier", "db")])
        ));
        assert!(!selector_matches(Some(&sel), &labels(&[("app", "api")])));
        assert!(!selector_matches(
            Some(&LabelSelector::default()),
            &labels(&[("app", "web")])
        ));
        assert!(!selector_matches(None, &labels(&[("app", "web")])));
    }

    fn workload(desired: i32, ready: i32, pending: bool) -> Workload {
        let mut w = base(
            Kind::Deployment,
            &ObjectMeta::default(),
            None,
            None,
            None,
            desired,
            ready,
            ready,
            pending,
        );
        finalize_health(&mut w, &[]);
        w
    }

    #[test]
    fn health_classification() {
        assert_eq!(workload(0, 0, false).health, Health::Idle);
        assert_eq!(workload(2, 2, false).health, Health::Healthy);
        assert_eq!(workload(2, 1, false).health, Health::Degraded);
        assert_eq!(workload(2, 1, true).health, Health::Progressing);
        assert_eq!(workload(1, 0, true).health, Health::Progressing);
        assert_eq!(workload(1, 0, false).health, Health::Failing);
    }

    #[test]
    fn crashlooping_pod_is_reported() {
        let pod: Pod = serde_json::from_value(serde_json::json!({
            "metadata": {"name": "web-1"},
            "status": {"phase": "Running", "containerStatuses": [{
                "name": "web", "image": "x", "imageID": "", "ready": false, "restartCount": 7,
                "state": {"waiting": {"reason": "CrashLoopBackOff"}}
            }]}
        }))
        .unwrap();
        let mut w = base(
            Kind::Deployment,
            &ObjectMeta::default(),
            None,
            None,
            None,
            1,
            0,
            1,
            false,
        );
        finalize_health(&mut w, &[&pod]);
        assert_eq!(w.health, Health::Failing);
        assert_eq!(w.pod_restarts, 7);
        assert_eq!(w.problem.as_deref(), Some("web: CrashLoopBackOff"));
    }
}
