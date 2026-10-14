//! Flux Kustomizations, HelmReleases and their sources.

use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use kube::api::{ApiResource, DynamicObject, GroupVersionKind, ListParams, Patch, PatchParams};
use kube::{Api, Client};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum FluxKind {
    Kustomization,
    HelmRelease,
}

impl FluxKind {
    pub fn parse(value: &str) -> Option<Self> {
        match value.to_ascii_lowercase().as_str() {
            "kustomization" => Some(Self::Kustomization),
            "helmrelease" => Some(Self::HelmRelease),
            _ => None,
        }
    }

    fn resource(self) -> ApiResource {
        match self {
            Self::Kustomization => resource(
                "kustomize.toolkit.fluxcd.io",
                "v1",
                "Kustomization",
                "kustomizations",
            ),
            Self::HelmRelease => resource(
                "helm.toolkit.fluxcd.io",
                "v2",
                "HelmRelease",
                "helmreleases",
            ),
        }
    }
}

fn resource(group: &str, version: &str, kind: &str, plural: &str) -> ApiResource {
    ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk(group, version, kind), plural)
}

fn source_resource(kind: &str) -> Option<ApiResource> {
    let (version, plural) = match kind {
        "GitRepository" => ("v1", "gitrepositories"),
        "OCIRepository" => ("v1", "ocirepositories"),
        "HelmRepository" => ("v1", "helmrepositories"),
        "Bucket" => ("v1", "buckets"),
        _ => return None,
    };
    Some(resource("source.toolkit.fluxcd.io", version, kind, plural))
}

/// Identifies the Flux object that applied a workload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FluxRef {
    pub kind: FluxKind,
    pub namespace: String,
    pub name: String,
}

impl FluxRef {
    /// Prefers the HelmRelease (the direct owner) over the Kustomization that created it.
    pub fn from_labels(meta: &ObjectMeta) -> Option<Self> {
        let labels = meta.labels.as_ref()?;
        let pick = |kind, prefix: &str| {
            let name = labels.get(&format!("{prefix}/name"))?;
            let namespace = labels
                .get(&format!("{prefix}/namespace"))
                .cloned()
                .unwrap_or_else(|| "flux-system".into());
            Some(FluxRef {
                kind,
                namespace,
                name: name.clone(),
            })
        };
        pick(FluxKind::HelmRelease, "helm.toolkit.fluxcd.io")
            .or_else(|| pick(FluxKind::Kustomization, "kustomize.toolkit.fluxcd.io"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FluxState {
    Ready,
    Reconciling,
    Failed,
    Suspended,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FluxObject {
    pub kind: FluxKind,
    pub namespace: String,
    pub name: String,
    pub state: FluxState,
    pub reason: Option<String>,
    pub message: Option<String>,
    /// Applied Git revision (Kustomization) or chart version (HelmRelease).
    pub revision: Option<String>,
    /// When the Ready condition last changed.
    pub since: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FluxSource {
    pub kind: String,
    pub namespace: String,
    pub name: String,
    pub ready: bool,
    pub revision: Option<String>,
    pub message: Option<String>,
    pub url: Option<String>,
}

fn condition<'a>(status: &'a Value, kind: &str) -> Option<&'a Value> {
    status["conditions"]
        .as_array()?
        .iter()
        .find(|c| c["type"] == kind)
}

fn text(value: &Value) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

fn summarize(kind: FluxKind, obj: &DynamicObject) -> FluxObject {
    let spec = &obj.data["spec"];
    let status = &obj.data["status"];
    let ready = condition(status, "Ready");
    let reconciling = condition(status, "Reconciling").is_some_and(|c| c["status"] == "True");
    let state = if spec["suspend"].as_bool() == Some(true) {
        FluxState::Suspended
    } else {
        match ready.and_then(|c| c["status"].as_str()) {
            Some("True") if !reconciling => FluxState::Ready,
            Some("False") if !reconciling => FluxState::Failed,
            Some(_) => FluxState::Reconciling,
            None => FluxState::Unknown,
        }
    };
    let namespace = obj.metadata.namespace.clone().unwrap_or_default();
    let revision = match kind {
        FluxKind::Kustomization => text(&status["lastAppliedRevision"]),
        FluxKind::HelmRelease => {
            let latest = &status["history"][0];
            match (text(&latest["chartName"]), text(&latest["chartVersion"])) {
                (Some(chart), Some(version)) => Some(format!("{chart}@{version}")),
                _ => text(&status["lastAttemptedRevision"]),
            }
        }
    };
    let source_ref = match kind {
        FluxKind::Kustomization => &spec["sourceRef"],
        FluxKind::HelmRelease => &spec["chart"]["spec"]["sourceRef"],
    };
    let source = text(&source_ref["name"]).map(|name| {
        format!(
            "{}/{}",
            source_ref["kind"].as_str().unwrap_or("Source"),
            name
        )
    });
    FluxObject {
        kind,
        name: obj.metadata.name.clone().unwrap_or_default(),
        namespace,
        state,
        reason: ready.and_then(|c| text(&c["reason"])),
        message: ready.and_then(|c| text(&c["message"])),
        revision,
        since: ready.and_then(|c| text(&c["lastTransitionTime"])),
        source,
    }
}

async fn list_kind(client: &Client, kind: FluxKind) -> Vec<FluxObject> {
    let api: Api<DynamicObject> = Api::all_with(client.clone(), &kind.resource());
    match api.list(&ListParams::default()).await {
        Ok(list) => list.items.iter().map(|o| summarize(kind, o)).collect(),
        Err(err) => {
            tracing::debug!(%err, ?kind, "could not list Flux objects");
            Vec::new()
        }
    }
}

/// All Kustomizations and HelmReleases; empty when Flux is not installed.
pub async fn list(client: &Client) -> Vec<FluxObject> {
    let (mut kustomizations, helm_releases) = tokio::join!(
        list_kind(client, FluxKind::Kustomization),
        list_kind(client, FluxKind::HelmRelease)
    );
    kustomizations.extend(helm_releases);
    kustomizations.sort_by(|a, b| (&a.namespace, &a.name).cmp(&(&b.namespace, &b.name)));
    kustomizations
}

pub async fn get(client: &Client, r: &FluxRef) -> Option<FluxObject> {
    let api: Api<DynamicObject> =
        Api::namespaced_with(client.clone(), &r.namespace, &r.kind.resource());
    match api.get_opt(&r.name).await {
        Ok(obj) => obj.map(|o| summarize(r.kind, &o)),
        Err(err) => {
            tracing::debug!(%err, "could not get Flux object");
            None
        }
    }
}

/// Git repositories that Kustomizations apply from.
pub async fn git_sources(client: &Client) -> Vec<FluxSource> {
    let Some(resource) = source_resource("GitRepository") else {
        return Vec::new();
    };
    let api: Api<DynamicObject> = Api::all_with(client.clone(), &resource);
    let Ok(list) = api.list(&ListParams::default()).await else {
        return Vec::new();
    };
    list.items
        .iter()
        .map(|o| {
            let status = &o.data["status"];
            let ready = condition(status, "Ready");
            FluxSource {
                kind: "GitRepository".into(),
                namespace: o.metadata.namespace.clone().unwrap_or_default(),
                name: o.metadata.name.clone().unwrap_or_default(),
                ready: ready.is_some_and(|c| c["status"] == "True"),
                revision: text(&status["artifact"]["revision"]),
                message: ready.and_then(|c| text(&c["message"])),
                url: text(&o.data["spec"]["url"]),
            }
        })
        .collect()
}

fn request_patch() -> Patch<Value> {
    let now = k8s_openapi::jiff::Timestamp::now().to_string();
    Patch::Merge(json!({
        "metadata": { "annotations": { "reconcile.fluxcd.io/requestedAt": now } }
    }))
}

/// Same as `flux reconcile <kind> --with-source`: asks the source to fetch first, then the object.
pub async fn reconcile(client: &Client, r: &FluxRef) -> kube::Result<()> {
    let api: Api<DynamicObject> =
        Api::namespaced_with(client.clone(), &r.namespace, &r.kind.resource());
    let obj = api.get(&r.name).await?;
    let source_ref = match r.kind {
        FluxKind::Kustomization => &obj.data["spec"]["sourceRef"],
        FluxKind::HelmRelease => &obj.data["spec"]["chart"]["spec"]["sourceRef"],
    };
    let params = PatchParams::default();
    if let (Some(kind), Some(name)) = (source_ref["kind"].as_str(), source_ref["name"].as_str())
        && let Some(resource) = source_resource(kind)
    {
        let namespace = source_ref["namespace"].as_str().unwrap_or(&r.namespace);
        let sources: Api<DynamicObject> =
            Api::namespaced_with(client.clone(), namespace, &resource);
        sources.patch(name, &params, &request_patch()).await?;
    }
    api.patch(&r.name, &params, &request_patch()).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(data: Value) -> DynamicObject {
        serde_json::from_value(json!({
            "apiVersion": "kustomize.toolkit.fluxcd.io/v1",
            "kind": "Kustomization",
            "metadata": {"name": "homectl", "namespace": "flux-system"},
            "spec": data["spec"],
            "status": data["status"],
        }))
        .unwrap()
    }

    #[test]
    fn states() {
        let ready = object(json!({
            "spec": {"sourceRef": {"kind": "GitRepository", "name": "flux-system"}},
            "status": {"lastAppliedRevision": "main@sha1:abc", "conditions": [
                {"type": "Ready", "status": "True", "reason": "ReconciliationSucceeded", "message": "Applied"}
            ]}
        }));
        let s = summarize(FluxKind::Kustomization, &ready);
        assert_eq!(s.state, FluxState::Ready);
        assert_eq!(s.revision.as_deref(), Some("main@sha1:abc"));
        assert_eq!(s.source.as_deref(), Some("GitRepository/flux-system"));

        let reconciling = object(json!({"spec": {}, "status": {"conditions": [
            {"type": "Reconciling", "status": "True"}, {"type": "Ready", "status": "Unknown"}
        ]}}));
        assert_eq!(
            summarize(FluxKind::Kustomization, &reconciling).state,
            FluxState::Reconciling
        );

        let failed = object(json!({"spec": {}, "status": {"conditions": [
            {"type": "Ready", "status": "False", "reason": "HealthCheckFailed"}
        ]}}));
        assert_eq!(
            summarize(FluxKind::Kustomization, &failed).state,
            FluxState::Failed
        );

        let suspended = object(json!({"spec": {"suspend": true}, "status": {}}));
        assert_eq!(
            summarize(FluxKind::Kustomization, &suspended).state,
            FluxState::Suspended
        );
    }

    #[test]
    fn helm_labels_win() {
        let meta: ObjectMeta = serde_json::from_value(json!({"labels": {
            "helm.toolkit.fluxcd.io/name": "immich",
            "helm.toolkit.fluxcd.io/namespace": "default",
            "kustomize.toolkit.fluxcd.io/name": "immich",
        }}))
        .unwrap();
        assert_eq!(
            FluxRef::from_labels(&meta),
            Some(FluxRef {
                kind: FluxKind::HelmRelease,
                namespace: "default".into(),
                name: "immich".into()
            })
        );
    }
}
