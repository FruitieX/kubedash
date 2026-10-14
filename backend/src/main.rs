mod flux;
mod k8s;
mod metrics;
mod prom;

use std::convert::Infallible;
use std::net::SocketAddr;
use std::time::Duration;

use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use futures::stream;
use futures::{AsyncBufReadExt, StreamExt};
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{DeleteParams, LogParams};
use kube::{Api, Client};
use serde::Deserialize;
use serde_json::json;
use tower_http::services::{ServeDir, ServeFile};

use crate::flux::{FluxKind, FluxRef};
use crate::k8s::{Cluster, Kind};
use crate::prom::Prometheus;

#[derive(Clone)]
struct AppState {
    cluster: Cluster,
    read_only: bool,
}

/// Mutations require this header. Browsers cannot attach it cross-origin without a
/// CORS preflight, which this server never approves, so it doubles as CSRF protection.
const MUTATION_HEADER: &str = "x-kubedash";

enum AppError {
    Kube(kube::Error),
    Status(StatusCode, String),
}

impl From<kube::Error> for AppError {
    fn from(err: kube::Error) -> Self {
        Self::Kube(err)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            AppError::Status(status, message) => (status, message),
            AppError::Kube(kube::Error::Api(status)) => (
                StatusCode::from_u16(status.code).unwrap_or(StatusCode::BAD_GATEWAY),
                status.message,
            ),
            AppError::Kube(err) => {
                tracing::warn!(%err, "kubernetes request failed");
                (StatusCode::BAD_GATEWAY, err.to_string())
            }
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}

type ApiResult<T> = Result<T, AppError>;

fn not_found(what: &str) -> AppError {
    AppError::Status(StatusCode::NOT_FOUND, format!("{what} not found"))
}

fn check_namespace(state: &AppState, namespace: &str) -> ApiResult<()> {
    if state.cluster.allows(namespace) {
        Ok(())
    } else {
        Err(not_found("namespace"))
    }
}

fn parse_kind(kind: &str) -> ApiResult<Kind> {
    Kind::parse(kind).ok_or_else(|| not_found("workload kind"))
}

async fn health() -> &'static str {
    "ok"
}

async fn config(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({ "readOnly": state.read_only }))
}

async fn overview(State(state): State<AppState>) -> ApiResult<Json<k8s::Overview>> {
    Ok(Json(state.cluster.overview().await?))
}

async fn workload(
    State(state): State<AppState>,
    Path((kind, namespace, name)): Path<(String, String, String)>,
) -> ApiResult<Json<k8s::WorkloadDetail>> {
    check_namespace(&state, &namespace)?;
    let kind = parse_kind(&kind)?;
    state
        .cluster
        .detail(kind, &namespace, &name)
        .await?
        .map(Json)
        .ok_or_else(|| not_found("workload"))
}

async fn restart(
    State(state): State<AppState>,
    Path((kind, namespace, name)): Path<(String, String, String)>,
) -> ApiResult<StatusCode> {
    check_namespace(&state, &namespace)?;
    let client = state.cluster.client.clone();
    match parse_kind(&kind)? {
        Kind::Deployment => {
            Api::<Deployment>::namespaced(client, &namespace)
                .restart(&name)
                .await?;
        }
        Kind::StatefulSet => {
            Api::<StatefulSet>::namespaced(client, &namespace)
                .restart(&name)
                .await?;
        }
        Kind::DaemonSet => {
            Api::<DaemonSet>::namespaced(client, &namespace)
                .restart(&name)
                .await?;
        }
    }
    tracing::info!(%kind, %namespace, %name, "rollout restart requested");
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct HistoryQuery {
    range: Option<String>,
}

async fn history(
    State(state): State<AppState>,
    Path((kind, namespace, name)): Path<(String, String, String)>,
    Query(query): Query<HistoryQuery>,
) -> ApiResult<Json<prom::History>> {
    check_namespace(&state, &namespace)?;
    let kind = parse_kind(&kind)?;
    let Some(prometheus) = &state.cluster.prometheus else {
        return Err(not_found("usage history"));
    };
    let hours = match query.range.as_deref().unwrap_or("6h") {
        "1h" => 1,
        "6h" => 6,
        "24h" => 24,
        "7d" => 24 * 7,
        _ => {
            return Err(AppError::Status(
                StatusCode::BAD_REQUEST,
                "range must be 1h, 6h, 24h or 7d".into(),
            ));
        }
    };
    let history = prometheus
        .history(kind, &namespace, &name, Duration::from_secs(hours * 3600))
        .await
        .map_err(|err| {
            tracing::warn!(%err, "prometheus history query failed");
            AppError::Status(StatusCode::BAD_GATEWAY, err.to_string())
        })?;
    Ok(Json(history))
}

async fn reconcile(
    State(state): State<AppState>,
    Path((kind, namespace, name)): Path<(String, String, String)>,
) -> ApiResult<StatusCode> {
    check_namespace(&state, &namespace)?;
    let kind = FluxKind::parse(&kind).ok_or_else(|| not_found("Flux kind"))?;
    let target = FluxRef {
        kind,
        namespace: namespace.clone(),
        name: name.clone(),
    };
    flux::reconcile(&state.cluster.client, &target).await?;
    tracing::info!(?kind, %namespace, %name, "flux reconcile requested");
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_pod(
    State(state): State<AppState>,
    Path((namespace, name)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    check_namespace(&state, &namespace)?;
    Api::<Pod>::namespaced(state.cluster.client.clone(), &namespace)
        .delete(&name, &DeleteParams::default())
        .await?;
    tracing::info!(%namespace, %name, "pod deletion requested");
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct LogQuery {
    container: Option<String>,
    tail: Option<i64>,
    #[serde(default)]
    previous: bool,
    #[serde(default = "default_true")]
    follow: bool,
}

fn default_true() -> bool {
    true
}

/// Streams pod logs as server-sent events: one `line` event per log line, then `end`.
/// Failures arrive in-band as a `failure` event, because EventSource cannot read error bodies.
async fn logs(
    State(state): State<AppState>,
    Path((namespace, pod)): Path<(String, String)>,
    Query(query): Query<LogQuery>,
) -> ApiResult<impl IntoResponse> {
    check_namespace(&state, &namespace)?;
    let params = LogParams {
        container: query.container,
        tail_lines: Some(query.tail.unwrap_or(500).clamp(1, 10_000)),
        previous: query.previous,
        follow: query.follow && !query.previous,
        timestamps: true,
        ..LogParams::default()
    };
    let failure =
        |message: String| Ok::<_, Infallible>(Event::default().event("failure").data(message));
    let api = Api::<Pod>::namespaced(state.cluster.client.clone(), &namespace);
    let events = match api.log_stream(&pod, &params).await {
        Ok(reader) => reader
            .lines()
            .map(move |line| match line {
                Ok(line) => Ok(Event::default().event("line").data(line)),
                Err(err) => failure(err.to_string()),
            })
            .chain(stream::once(async {
                Ok(Event::default().event("end").data(""))
            }))
            .boxed(),
        Err(kube::Error::Api(status)) => {
            stream::once(async move { failure(status.message) }).boxed()
        }
        Err(err) => stream::once(async move { failure(err.to_string()) }).boxed(),
    };
    Ok(Sse::new(events).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}

async fn guard_mutations(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if request.method() == Method::GET || request.method() == Method::HEAD {
        return next.run(request).await;
    }
    if state.read_only {
        return AppError::Status(StatusCode::FORBIDDEN, "kubedash is read-only".into())
            .into_response();
    }
    if !request.headers().contains_key(MUTATION_HEADER) {
        return AppError::Status(StatusCode::FORBIDDEN, "missing request header".into())
            .into_response();
    }
    next.run(request).await
}

async fn cache_headers(mut request: Request, next: Next) -> Response {
    let hashed = request.uri().path().starts_with("/assets/");
    if !hashed {
        // Nix store files all share mtime 0, so ServeDir's mtime+size validators could
        // wrongly answer 304 for a changed index.html. Always send unhashed files in full.
        request.headers_mut().remove(header::IF_NONE_MATCH);
        request.headers_mut().remove(header::IF_MODIFIED_SINCE);
    }
    let mut response = next.run(request).await;
    if !hashed {
        response.headers_mut().remove(header::ETAG);
        response.headers_mut().remove(header::LAST_MODIFIED);
    }
    let policy = if hashed {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(policy));
    response
}

fn app(state: AppState, static_dir: Option<String>) -> Router {
    let api = Router::new()
        .route("/health", get(health))
        .route("/config", get(config))
        .route("/overview", get(overview))
        .route("/workloads/{kind}/{namespace}/{name}", get(workload))
        .route(
            "/workloads/{kind}/{namespace}/{name}/restart",
            post(restart),
        )
        .route("/workloads/{kind}/{namespace}/{name}/history", get(history))
        .route("/flux/{kind}/{namespace}/{name}/reconcile", post(reconcile))
        .route("/pods/{namespace}/{name}", delete(delete_pod))
        .route("/pods/{namespace}/{name}/logs", get(logs))
        .fallback(|| async { not_found("endpoint") })
        .layer(middleware::from_fn_with_state(
            state.clone(),
            guard_mutations,
        ))
        .layer(middleware::map_response(|mut response: Response| async {
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }))
        .with_state(state);

    let mut router = Router::new().nest("/api", api);
    if let Some(dir) = static_dir {
        let index = format!("{dir}/index.html");
        router = router.fallback_service(
            Router::new()
                .fallback_service(ServeDir::new(&dir).fallback(ServeFile::new(index)))
                .layer(middleware::from_fn(cache_headers)),
        );
    }
    router
        .layer(middleware::map_response(|mut response: Response| async {
            let headers = response.headers_mut();
            headers.insert(
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            );
            headers.insert(
                header::REFERRER_POLICY,
                HeaderValue::from_static("same-origin"),
            );
            headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
            response
        }))
        .layer(tower_http::trace::TraceLayer::new_for_http())
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

async fn shutdown() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "kubedash=info,tower_http=warn".into()),
        )
        .init();

    let bind: SocketAddr = env("KUBEDASH_BIND")
        .unwrap_or_else(|| "127.0.0.1:3001".into())
        .parse()?;
    let namespaces = env("KUBEDASH_NAMESPACES")
        .map(|v| {
            v.split(',')
                .map(|n| n.trim().to_string())
                .filter(|n| !n.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let read_only = env("KUBEDASH_READ_ONLY").is_some_and(|v| v == "1" || v == "true");

    let prometheus = env("KUBEDASH_PROMETHEUS_URL")
        .map(|url| Prometheus::new(&url))
        .transpose()?;
    let client = Client::try_default().await?;
    let state = AppState {
        cluster: Cluster {
            client,
            namespaces,
            prometheus,
        },
        read_only,
    };
    let router = app(state, env("KUBEDASH_STATIC_DIR"));

    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!(%bind, read_only, "kubedash listening");
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}
