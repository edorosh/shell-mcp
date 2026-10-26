# v3 spike results: creating a sandbox with the microsandbox SDK

Plan Task 1, spec §7. Script: `spike/v3-create.mjs`. microsandbox SDK 0.7.11.

## Windows (2026-10-26)

Host: Windows x64, Node 24.20.0, SDK 0.7.11, image `ubuntu:24.04`, mount `C:\temp\v3-ws` at `/workspace`.

### 7.1 Create and lifetime

- `createWithPullProgress()` with `.detached(true)` creates the sandbox. The result has
  `ownsLifecycle: false`.
- The process exits without `stop` or `dispose`, and `msb ls` still shows the sandbox as
  `running`. The sandbox outlives the server, as the design needs.
- Progress events arrive in this order: `resolving`, `resolved` (with `totalDownloadBytes`),
  `layerDownloadProgress` (`layerIndex`, `downloadedBytes`, `totalBytes`), `layerDownloadComplete`,
  `layerMaterializeStarted`, `layerMaterializeProgress`, `layerMaterializeWriting`,
  `layerMaterializeComplete`, `stitch*`, then `complete`. With a cached image only `resolving`,
  `resolved` and `complete` arrive. Create then takes about 0.7 s.

### 7.2 Stored config vs `.build()`

- `handle.configJson` is snake_case. `handle.config()` is camelCase and has the same shape as
  `.build()`.
- Owned fields have the same paths and values on both sides:
  - `image.Oci.reference` (kept as typed, `ubuntu:24.04`, not normalized);
  - `mounts[].{guest, host, options.readonly}`. The host path is stored exactly as passed
    (`C:\temp\v3-ws`): no case change and no slash change;
  - `network.policy`;
  - `resources.{cpus, memoryMib}`, with defaults of 1 and 1024 when unset.
- The stored config has some extra fields that shell-mcp ignores:
  - `image.Oci.rootDisk`
  - `runtime.cmd`
  - `env` (PATH)
  - image `labels`
  - `manifestDigest`
  - `network.maxConnections`, where `.build()` has `maxTcpConnections` instead.
- Both sides hold the policy in wire form: destinations look like `{group: "host"}` and
  `{domain: "example.com"}`, with no `kind`. `.policyJson()` rejects the typed `{kind: ...}` shape
  (`unknown variant 'kind'`), so shell-mcp uses `.policy(typed)`.
- **Fix from this run:** the mismatch message read domains only from the typed form, so a real
  domain change would have said only "network policy changed". The message now reads the wire form
  as well. Tests use fixtures taken from this run.

### 7.4 Network policy (deny by default, DNS, `example.com` allowed)

Probe: a TCP connect only (`exec 3<>/dev/tcp/host/port`).

| Target | Policy | Default (no `.network()`) |
| --- | --- | --- |
| example.com:443 | connects | connects |
| www.iana.org:443 | refused | connects |
| 192.168.1.1:80 | **connects (4 to 15 ms)** | connects |

- When no policy is set, the stored `network` has no `policy` key and every probe connects.
  shell-mcp must therefore always set a policy, and it does.
- Under the deny policy, 192.168.1.1:80 also connected (in 4 to 15 ms). A second run with a
  reply probe settled it: the HTTP request goes out on port 80 and the first bytes of the reply are
  read back.

  | Target (port 80) | Reply |
  | --- | --- |
  | example.com (allowed) | `HTTP/1.1 200 OK` from the real server |
  | www.iana.org (denied) | `HTTP/1.1 403 Forbidden`, `Content-Type: ap...` |
  | 192.168.1.1, the LAN router (denied) | the same 403 |
  | 10.0.0.1, which does not exist (denied) | the same 403 |

  The 403 replies are microsandbox's own deny response (`network.http.denyResponse: true`,
  format `json`). A host that does not exist gets it too, so the request never reached the
  router: the sandbox's network stack accepts the connection, then answers with the deny response.
  The earlier connect-only probe could not tell these apart. On a non-HTTP port (443), a denied
  host is refused outright. **Private addresses are blocked.**

### 7.5 Stop, start, remove

- `stop` takes about 70 ms, and the status afterwards is `stopped`. `config()` can still be read
  while the sandbox is stopped.
- `Sandbox.startDetached` takes about 0.6 s and returns `ownsLifecycle: false`. The policy
  survives the restart: the second `net` run gives the same results.
- `Sandbox.remove` takes about 13 ms. A `get` afterwards throws `SandboxNotFoundError` with code
  `sandboxNotFound`.

### 7.6 Reuse cost

`Sandbox.get` plus `connectWithTimeout` on a running sandbox takes about 15 ms (get 11 to 12 ms,
connect 3 to 4 ms).

## Mac (2026-10-26)

Host: Mac mini, Apple Silicon (arm64), Node 25.9.0, SDK 0.7.11, image `ubuntu:24.04` (arm64 digest),
mount `/Volumes/ext-ssd-256/dev/tmp-proj` at `/workspace` (the resolved `pwd -P` path).

Results match Windows on every point:

- **Lifetime:** the sandbox survives the process exit and stays `running`, with `ownsLifecycle: false`.
- **Config:** the stored `config()` has the same shape and owned values as `.build()`. The host
  path is stored exactly as passed, and the policy is held in wire form. `.policyJson()` rejects
  the typed shape.
- **Network:** the results are the same as on Windows. Under the deny policy:
  - example.com connects;
  - www.iana.org is refused;
  - 192.168.1.1:80 connects, in 1 to 2 ms.

  With no policy set, all three connect. The LAN reply probe was run only on Windows (see above).
- **Stop, start, remove:**
  - `stop` takes about 55 ms, then the status is `stopped`;
  - `startDetached` takes about 0.14 s, and the policy survives the restart;
  - `remove` takes about 4 ms, and a `get` afterwards throws `sandboxNotFound`.
- **Reuse cost:** `get` plus `connect` takes about 5 ms. A create with the image already cached
  takes about 0.2 s.

## Integration suite (`test/integration.create.test.ts`)

- Windows: 6/6 pass, in 3.8 s.
- Mac: not run yet.
