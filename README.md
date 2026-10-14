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
KUBECONFIG=~/homelab/kubeconfig cargo run --manifest-path backend/Cargo.toml   # API on :3001
npm run dev                                                                    # UI on :3100, proxies /api
```

Checks: `npm run typecheck && npm test && npm run format:check` and
`cargo clippy --all-targets -- -D warnings && cargo test` in `backend/`.

## Configuration

| Variable              | Default          | Purpose                                       |
| --------------------- | ---------------- | --------------------------------------------- |
| `KUBEDASH_BIND`       | `127.0.0.1:3001` | Listen address (`0.0.0.0:8080` in the image)  |
| `KUBEDASH_STATIC_DIR` | unset            | Built UI to serve; set in the container image |
| `KUBEDASH_NAMESPACES` | all              | Comma-separated allow-list of namespaces      |
| `KUBEDASH_READ_ONLY`  | `false`          | `true` disables restart and pod deletion      |
| `RUST_LOG`            | `kubedash=info`  | Log filter                                    |

kubedash uses in-cluster service account credentials, or `KUBECONFIG` when it
runs locally.

## Security

kubedash has no login of its own. It must only be reachable through the
**private** LAN/VPN gateway. Mutating requests require an `x-kubedash` header.
Browsers can't send that header cross-origin without a CORS preflight, which
the server never approves, so it also guards against CSRF. RBAC
(`apps/kubedash` in the homelab repo) grants read access to
workloads, pods, logs, events, services, nodes and HTTPRoutes. The only write
permissions are `patch` on Deployments, StatefulSets and DaemonSets, and
`delete` on pods.

## Deployment

On every push to `main`, CI checks, builds and publishes
`ghcr.io/fruitiex/kubedash`, then sends an `image-update` dispatch to
`FruitieX/homelab`. That pins the new digest in `apps/kubedash`, and Flux rolls
it out. The dispatch needs a `HOMELAB_DISPATCH_TOKEN` repository secret.
