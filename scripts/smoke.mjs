// Smoke test for dependency upgrades: runs the real backend against a fake
// Kubernetes API, checks the main API routes and loads the built UI in
// Chromium, failing on any page or console error. Never touches a cluster.
//
// Needs `npm run build` and `cargo build --manifest-path backend/Cargo.toml`.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

const binary = process.env.KUBEDASH_BIN ?? 'backend/target/debug/kubedash'
const now = new Date().toISOString()

const deployment = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: {
    name: 'smoke-web',
    namespace: 'smoke',
    uid: 'deploy-1',
    creationTimestamp: now,
    generation: 1,
  },
  spec: {
    replicas: 1,
    selector: { matchLabels: { app: 'smoke-web' } },
    template: {
      metadata: { labels: { app: 'smoke-web' } },
      spec: { containers: [{ name: 'web', image: 'example/web:1.0' }] },
    },
  },
  status: {
    observedGeneration: 1,
    replicas: 1,
    readyReplicas: 1,
    updatedReplicas: 1,
    availableReplicas: 1,
  },
}
const node = {
  apiVersion: 'v1',
  kind: 'Node',
  metadata: { name: 'smoke-node', uid: 'node-1', creationTimestamp: now },
  status: {
    allocatable: { cpu: '4', memory: '8Gi' },
    conditions: [{ type: 'Ready', status: 'True' }],
    nodeInfo: { kubeletVersion: 'v1.34.0' },
  },
}
const items = {
  '/apis/apps/v1/deployments': [deployment],
  '/api/v1/nodes': [node],
}

// Answers every list with fixtures or an empty list; anything else is a 404,
// like an API group (metrics, Flux, Gateway API) that is not installed.
const kube = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  res.setHeader('content-type', 'application/json')
  if (req.method === 'GET' && /^\/(api|apis)\/.+s$/.test(path)) {
    res.end(
      JSON.stringify({
        apiVersion: 'v1',
        kind: 'List',
        metadata: { resourceVersion: '1' },
        items: items[path] ?? [],
      }),
    )
    return
  }
  res.statusCode = 404
  res.end(
    JSON.stringify({
      kind: 'Status',
      apiVersion: 'v1',
      status: 'Failure',
      reason: 'NotFound',
      code: 404,
      message: `${path} not found`,
    }),
  )
})
await new Promise((resolve) => kube.listen(0, '127.0.0.1', resolve))

const free = createServer()
await new Promise((resolve) => free.listen(0, '127.0.0.1', resolve))
const port = free.address().port
await new Promise((resolve) => free.close(resolve))
const origin = `http://127.0.0.1:${port}`

const dir = await mkdtemp(join(tmpdir(), 'kubedash-smoke-'))
const kubeconfig = join(dir, 'kubeconfig')
await writeFile(
  kubeconfig,
  JSON.stringify({
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [
      {
        name: 'smoke',
        cluster: { server: `http://127.0.0.1:${kube.address().port}` },
      },
    ],
    users: [{ name: 'smoke', user: { token: 'smoke' } }],
    contexts: [{ name: 'smoke', context: { cluster: 'smoke', user: 'smoke' } }],
    'current-context': 'smoke',
  }),
)

let logs = ''
const server = spawn(binary, [], {
  env: {
    ...process.env,
    KUBECONFIG: kubeconfig,
    KUBEDASH_BIND: `127.0.0.1:${port}`,
    KUBEDASH_STATIC_DIR: 'dist',
    KUBEDASH_READ_ONLY: 'true',
    RUST_LOG: 'kubedash=debug',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', (d) => (logs += d))
server.stderr.on('data', (d) => (logs += d))

let browser
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) break
    } catch {}
    if (i > 100 || server.exitCode !== null)
      throw new Error('kubedash did not start')
    await delay(100)
  }

  const config = await (await fetch(`${origin}/api/config`)).json()
  assert.deepEqual(config, { readOnly: true })

  const response = await fetch(`${origin}/api/overview`)
  assert.equal(response.status, 200, await response.clone().text())
  const overview = await response.json()
  const web = overview.workloads.find((w) => w.name === 'smoke-web')
  assert.ok(web, 'the fake deployment is listed')
  assert.equal(web.health, 'healthy')
  assert.equal(overview.nodes[0]?.name, 'smoke-node')

  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    args: ['--no-sandbox'],
  })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(`page error: ${e}`))
  page.on(
    'console',
    (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`),
  )
  await page.goto(origin)
  await page.getByText('smoke-web').first().waitFor({ timeout: 15_000 })
  assert.deepEqual(errors, [], 'no errors on the dashboard')
  console.log('Smoke test passed')
} catch (e) {
  console.error(logs)
  throw e
} finally {
  await browser?.close()
  server.kill()
  kube.close()
  await rm(dir, { recursive: true, force: true })
}
