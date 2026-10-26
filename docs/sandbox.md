# Sandbox and runtime

shell-mcp never creates, starts or stops a sandbox. You create one, with your
project folder mounted, and give shell-mcp its name.

## Runtime version

shell-mcp talks to the sandbox through the `microsandbox` npm SDK, which drives
the `msb` runtime. The SDK and `msb` must be the same version.
`@edorosh/shell-mcp` 1.0.2 pins `microsandbox` at exactly **0.7.11**; the
tested pair is SDK 0.7.11 with `msb` 0.7.11 on Windows (see
[spike-results.md](superpowers/specs/spike-results.md)).
[CHANGELOG.md](../CHANGELOG.md) lists the `msb` version each release expects.

shell-mcp uses the `msb` in your microsandbox home if you have one, and the
runtime packaged with the SDK otherwise (`MSB_HOME` overrides the home). A
version mismatch is logged to stderr at startup and reported by `--check`; it
never stops the server.

## Creating a sandbox

A sandbox belongs to the `msb` runtime home that created it, so create it with
the same `msb` that shell-mcp will use. Use an image that contains `bash`, for
example `ubuntu:24.04`. The configured shell (default `bash`) is the only shell
used, with no `sh` fallback.

**You already have a separate `msb` install** (the `msb` in your microsandbox
home; shell-mcp uses it). Create the sandbox as usual. Its version must match
the SDK (0.7.11 for shell-mcp 1.0.2); `--check` verifies this.

```powershell
msb create ubuntu:24.04 --name myproj --mount-dir C:\Users\<you>\dev\myproj:/workspace
```

**You have no `msb` installed.** Use the runtime packaged with the SDK:

```powershell
npx -y -p microsandbox@0.7.11 msb create ubuntu:24.04 --name myproj --mount-dir C:\Users\<you>\dev\myproj:/workspace
```

`create` also starts the sandbox. If it is stopped later, start it with
`msb start myproj` (or the same `npx -y -p microsandbox@0.7.11 msb start myproj`);
until then `shell` returns a tool error, and the next call works once it runs.

The values to give shell-mcp are the sandbox name (`myproj`), the host folder
(`C:\Users\<you>\dev\myproj`, where `<you>` is your Windows user name) and the
guest path (`/workspace`).

## Upgrading

Change the version in the client config (for example `@edorosh/shell-mcp@1.0.2`)
and run `--check` with the new version. If the expected `msb` version changed
(see [CHANGELOG.md](../CHANGELOG.md)), recreate or update `msb` to match. Close
running clients first (see
[Troubleshooting](troubleshooting.md#access-denied-when-clearing-the-npx-cache-or-upgrading)).
