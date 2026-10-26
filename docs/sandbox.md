# Sandbox and runtime

shell-mcp never creates, starts or stops a sandbox. You create one, with your
project folder mounted, and give shell-mcp its name.

## Runtime version

shell-mcp talks to the sandbox through the `microsandbox` npm SDK, which drives
the `msb` runtime. The SDK and `msb` must be the same version.
`@edorosh/shell-mcp` 1.1.0 pins `microsandbox` at exactly **0.7.11**; the
tested pair is SDK 0.7.11 with `msb` 0.7.11 on Windows and macOS (Apple Silicon) (see
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
the SDK (0.7.11 for shell-mcp 1.1.0); `--check` verifies this.

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

## macOS

The host must be an Apple Silicon Mac running an arm64 Node (`node -p
process.arch` prints `arm64`). The sandbox is a Linux guest on the same
microsandbox runtime as on Windows.

- **The bundled `msb` is not on `PATH`.** The runtime packaged with the SDK
  lives inside the npm package, so run it through npx, as in the Windows
  commands above:

  ```zsh
  npx -y -p microsandbox@0.7.11 msb create ubuntu:24.04 --name myproj --mount-dir "$(cd ~/dev/myproj && pwd -P):/workspace"
  ```

  The same form works for `msb start myproj`, `msb stop myproj` and
  `msb --version`.
- **Mount the resolved path.** `msb create` refuses a host path that goes
  through a symlink, for example when `~/dev` is a link to another volume:

  ```text
  error: invalid config: bind mount host path /Users/<you>/dev/myproj goes through symlink /Users/<you>/dev; use the resolved path /Volumes/<disk>/dev/myproj or add follow-root-symlinks
  ```

  `pwd -P` prints the resolved path, which is why the commands above use
  `"$(cd ~/dev/myproj && pwd -P)"`. Only `msb create --mount-dir` needs the
  resolved path. For `--host-root` either the symlinked or the resolved path
  works; the resolved path is simplest because it matches the mount.
- **Images need an arm64 variant.** The guest is aarch64, so an image such as
  `ubuntu:24.04` works only if it is published for arm64 (the common ones are).
- **The guest sees the Mac's file system.** The default macOS volume is
  case-insensitive, so `Foo.txt` and `foo.txt` are the same file in the
  sandbox too, unlike on a normal Linux file system.

## Upgrading

Change the version in the client config (for example `@edorosh/shell-mcp@1.1.0`)
and run `--check` with the new version. If the expected `msb` version changed
(see [CHANGELOG.md](../CHANGELOG.md)), recreate or update `msb` to match. Close
running clients first (see
[Troubleshooting](troubleshooting.md#access-denied-when-clearing-the-npx-cache-or-upgrading)).
