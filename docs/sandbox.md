# Sandbox and runtime

shell-mcp can create its sandbox itself (create mode, the default way to use
it) or attach to one you created by hand (attach mode, see
[Using a sandbox you created yourself](#using-a-sandbox-you-created-yourself)).

## Runtime version

shell-mcp talks to the sandbox through the `microsandbox` npm SDK, which drives
the `msb` runtime. The SDK and `msb` must be the same version.
`@edorosh/shell-mcp` 1.2.0 pins `microsandbox` at exactly **0.7.11**; the
tested pair is SDK 0.7.11 with `msb` 0.7.11 on Windows and macOS (Apple Silicon) (see
[spike-results.md](superpowers/specs/spike-results.md)).
[CHANGELOG.md](../CHANGELOG.md) lists the `msb` version each release expects.

shell-mcp uses the `msb` in your microsandbox home if you have one, and the
runtime packaged with the SDK otherwise (`MSB_HOME` overrides the home). A
version mismatch is logged to stderr at startup and reported by `--check`; it
never stops the server.

## Create mode

Pass `--image` and shell-mcp creates the sandbox on first start and reuses it
by name afterwards. `--sandbox` is its name, and each `--mount HOST:GUEST[:ro]`
bind-mounts a host folder; the first mount is the project mount that file
paths are translated against. Use an image that contains `bash`, for example
`ubuntu:24.04`; the configured shell (default `bash`) is the only shell used,
with no `sh` fallback. The full flag list is in
[Configuration](configuration.md).

Claude Code, `.mcp.json` on Windows:

```json
{
  "mcpServers": {
    "sandbox": {
      "command": "cmd",
      "args": [
        "/c", "npx", "-y", "@edorosh/shell-mcp@1.2.0",
        "--sandbox", "myproj",
        "--image", "ubuntu:24.04",
        "--mount", "C:\\Users\\<you>\\dev\\myproj:/workspace"
      ]
    }
  }
}
```

On a Mac the entry is `"command": "npx"` with `"-y", "@edorosh/shell-mcp@1.2.0",
...` and `"--mount", "/Users/<you>/dev/myproj:/workspace"`. GitHub Copilot
(`.vscode/mcp.json`) takes the same arguments; see [Client setup](clients.md).

**First start.** The first start pulls the image, which can take minutes. The
server answers the MCP handshake at once and prepares the sandbox in the
background; a `shell` call made before it is ready returns "still being
prepared" with the progress, and works when you retry. To do the first pull in a
terminal instead, run the same flags with `--prepare`; it prints progress and
exits once the sandbox runs:

```powershell
npx -y @edorosh/shell-mcp@1.2.0 --sandbox myproj --image ubuntu:24.04 --mount C:\Users\<you>\dev\myproj:/workspace --prepare
```

```zsh
npx -y @edorosh/shell-mcp@1.2.0 --sandbox myproj --image ubuntu:24.04 --mount /Users/<you>/dev/myproj:/workspace --prepare
```

`--check` with the same flags stays read-only: it reports "not created yet" for
a sandbox that does not exist, and never creates, starts or recreates one.

**Network.** The sandbox has no network access by default, and private
addresses (LAN, loopback) stay blocked whatever you allow. `--allow-domain
HOST` (repeatable, a host or a suffix such as `*.example.com`) opens single
hosts; `--allow-network` opens all public hosts. Add mounts, `--cpus` and
`--memory` the same way:

```text
--allow-domain registry.npmjs.org --allow-domain "*.github.com"
--mount /Users/<you>/dev/myproj:/workspace --mount /Users/<you>/.cache:/cache:ro
```

**The sandbox is persistent.** It is created once, reused by name on every
later start, and never stopped when the client exits, so it keeps running in
the background and the next start is fast. Stop or remove it yourself with the
same `msb` version as the SDK:

```powershell
npx -y -p microsandbox@0.7.11 msb stop myproj
npx -y -p microsandbox@0.7.11 msb remove myproj
```

(`rm` is an alias of `remove`.) Files in the mounts are on your host and stay
when the sandbox is removed; everything else in the sandbox is lost.

**Changing the settings.** If the sandbox exists but differs from the flags
(image, mounts, network policy, CPUs or memory), shell-mcp refuses and lists
the differences ("was created with different settings"). `--recreate` removes
the sandbox and creates it again. It **deletes everything in the sandbox
outside the mounts** (installed packages, files under `/home`, `/tmp` and so
on), so use it deliberately. Run it once with `--prepare --recreate`, or add it
to the client config and remove it afterwards.

## macOS

The host must be an Apple Silicon Mac running an arm64 Node (`node -p
process.arch` prints `arm64`). The sandbox is a Linux guest on the same
microsandbox runtime as on Windows.

- **Mount paths are resolved for you.** In create mode shell-mcp resolves
  symlinks in each `--mount` host path itself before it gives the path to the
  runtime, so a folder that goes through a link, such as `~/dev` pointing at
  another volume, works. The path must still be absolute and exist:
  `/Users/<you>/dev/myproj`, not `~/dev/myproj` inside a JSON file where
  nothing expands the `~`. Tool output keeps the path as you wrote it.
- **Images need an arm64 variant.** The guest is aarch64, so an image such as
  `ubuntu:24.04` works only if it is published for arm64 (the common ones are).
- **The guest sees the Mac's file system.** The default macOS volume is
  case-insensitive, so `Foo.txt` and `foo.txt` are the same file in the
  sandbox too, unlike on a normal Linux file system.

## Using a sandbox you created yourself

Without `--image`, shell-mcp never creates, starts or stops a sandbox (attach
mode, the only mode before 1.2.0). You create one with your project folder
mounted and give shell-mcp its name, `--host-root` and `--guest-root`.

A sandbox belongs to the `msb` runtime home that created it, so create it with
the same `msb` that shell-mcp will use. Use an image that contains `bash`, for
example `ubuntu:24.04`.

**You already have a separate `msb` install** (the `msb` in your microsandbox
home; shell-mcp uses it). Create the sandbox as usual. Its version must match
the SDK (0.7.11 for shell-mcp 1.2.0); `--check` verifies this.

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

On a Mac the bundled `msb` is not on `PATH`, so run it through npx as above.
`msb create` refuses a host path that goes through a symlink, for example when
`~/dev` is a link to another volume:

```text
error: invalid config: bind mount host path /Users/<you>/dev/myproj goes through symlink /Users/<you>/dev; use the resolved path /Volumes/<disk>/dev/myproj or add follow-root-symlinks
```

Mount the resolved path, which `pwd -P` prints:

```zsh
npx -y -p microsandbox@0.7.11 msb create ubuntu:24.04 --name myproj --mount-dir "$(cd ~/dev/myproj && pwd -P):/workspace"
```

Only `msb create --mount-dir` needs the resolved path. For `--host-root` either
the symlinked or the resolved path works; the resolved path is simplest
because it matches the mount. The arm64 image and case-insensitivity notes
under [macOS](#macos) apply here too.

## Upgrading

Change the version in the client config (for example `@edorosh/shell-mcp@1.2.0`)
and run `--check` with the new version. If the expected `msb` version changed
(see [CHANGELOG.md](../CHANGELOG.md)), update `msb` to match (in create mode, `--recreate` if the settings changed). Close
running clients first (see
[Troubleshooting](troubleshooting.md#access-denied-when-clearing-the-npx-cache-or-upgrading)).
