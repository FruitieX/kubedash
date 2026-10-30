# kubedash

A small, mobile-first dashboard for the homelab Kubernetes cluster. Use it to
check workload health, follow logs, rollout-restart services and delete stuck
pods from your phone.

- **Frontend:** React 19, TypeScript, Tailwind CSS v4, Radix UI primitives, Vite
- **Backend:** Rust, axum, tokio, kube-rs

## Features

- Overview of every Deployment, StatefulSet and DaemonSet, with health
  (healthy / rolling out / degraded / failing / scaled to zero), ready
  replicas, image tag, uptime and pod restart count
- Problem detection (CrashLoopBackOff, image pull errors, unschedulable pods,
  stalled rollouts) and a "Needs attention" section
- Search, namespace filters and pinned favourites (stored in the browser)
- App links resolved from Gateway API `HTTPRoute`s
- Flux status per workload: the owning Kustomization or HelmRelease with its
  state, applied revision and errors. Failed applies count as issues. A Flux
  sheet lists every Kustomization and HelmRelease, and **Reconcile** does the
  same as `flux reconcile … --with-source`
- CPU and memory per workload, pod (against requests and limits) and node, from
  the Metrics API (metrics-server). Usage history charts (1h–7d) come from
  Prometheus when `KUBEDASH_PROMETHEUS_URL` is set
- Detail page with pods, containers, last termination reasons and recent events
- Live log streaming over SSE: pod and container picker, previous-container
  logs, pause, filter, wrap, timestamps and download
- `rollout restart` (the same annotation patch `kubectl` uses) and pod deletion,
  each behind a confirmation dialog
- Installable as a PWA, with light and dark themes

## Development

```sh
nix develop
npm ci
# Optional, for usage history charts:
kubectl port-forward -n kube-prometheus-stack svc/kube-prometheus-stack-prometheus 9090 &
# API on :3001
KUBECONFIG=/path/to/kubeconfig KUBEDASH_PROMETHEUS_URL=http://127.0.0.1:9090 \
  cargo run --manifest-path backend/Cargo.toml
# UI on :3100, proxies /api
npm run dev
```

Checks: `npm run typecheck && npm test && npm run format:check` and
`cargo clippy --all-targets -- -D warnings && cargo test` in `backend/`.
`npm run smoke` (after `npm run build` and `cargo build`) runs the backend
against a fake Kubernetes API and loads the UI in Chromium; CI runs it on every
pull request so dependency updates cannot merge with a broken app.

## Configuration

| Variable                  | Default          | Purpose                                             |
| ------------------------- | ---------------- | --------------------------------------------------- |
| `KUBEDASH_BIND`           | `127.0.0.1:3001` | Listen address (`0.0.0.0:8080` in the image)        |
| `KUBEDASH_STATIC_DIR`     | unset            | Built UI to serve; set in the container image       |
| `KUBEDASH_NAMESPACES`     | all              | Comma-separated allow-list of namespaces            |
| `KUBEDASH_READ_ONLY`      | `false`          | `true` disables restart, pod deletion and reconcile |
| `KUBEDASH_PROMETHEUS_URL` | unset            | Prometheus base URL for usage history charts        |
| `RUST_LOG`                | `kubedash=info`  | Log filter                                          |

kubedash uses in-cluster service account credentials, or `KUBECONFIG` when it
runs locally.

## Security

kubedash has no login of its own. It must only be reachable through a
**private** gateway that the internet cannot reach. Mutating requests require an `x-kubedash` header.
Browsers can't send that header cross-origin without a CORS preflight, which
the server never approves, so it also guards against CSRF. RBAC
(`apps/kubedash` in the homelab repo) grants read access to
workloads, pods, logs, events, services, nodes, HTTPRoutes, the Metrics API and
Flux objects. The only write permissions are `patch` on Deployments,
StatefulSets and DaemonSets (restart), `delete` on pods, and `patch` on Flux
Kustomizations, HelmReleases and sources (the reconcile request annotation).

## Deployment

On every push to `main`, CI checks, builds and publishes
`ghcr.io/fruitiex/kubedash`, then sends an `image-update` dispatch to
`FruitieX/homelab`. That pins the new digest in `apps/kubedash`, and Flux rolls
it out. The dispatch needs a `HOMELAB_DISPATCH_TOKEN` repository secret.
