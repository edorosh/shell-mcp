# Typical setups

Ready-to-copy configurations for common cases. You do not need to know
microsandbox to use them.

## What you need to know first

- **microsandbox** runs a small Linux virtual machine (a "sandbox") on your
  Windows PC or Apple Silicon Mac. Its command-line tool is called `msb`.
  shell-mcp ships with it, so there is nothing else to install. You only need
  Node.js 22 or newer.
- **shell-mcp creates the sandbox for you** the first time your AI client
  starts it. The sandbox is created from an **image**, a ready-made Linux
  system such as `ubuntu:24.04`, which is downloaded once. The sandbox then
  keeps running in the background and is reused every time.
- **A mount** makes a folder on your computer visible inside the sandbox. Your
  project folder is mounted at `/workspace`. Files there are the same files on
  both sides, so the agent's edits show up in your editor.
- **The sandbox starts with no internet access.** You open exactly what the
  agent needs, as shown below. Your home network (router, NAS, other PCs)
  stays blocked in every setup.
- **Anything outside the mounts lives only in the sandbox**: installed
  packages, caches, and files under `/root` or `/tmp`. It survives restarts,
  but it is lost when the sandbox is recreated or removed.

All examples use the sandbox name `myproj` and the folder
`C:\Users\<you>\dev\myproj` on Windows (`/Users/<you>/dev/myproj` on a Mac).
Replace them with your own.

## Setup 1: start here (one project, no internet)

Claude Code on Windows, `.mcp.json` in the project folder:

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

Then turn off the client's own shell in `.claude/settings.json`, so every
command goes through the sandbox:

```json
{ "permissions": { "deny": ["Bash"] } }
```

The same server entry on other clients and systems:

| Client and system | What changes |
| --- | --- |
| Claude Code, Mac | `"command": "npx"`, and `args` start with `"-y"` (no `"/c", "npx"`). The mount is `"/Users/<you>/dev/myproj:/workspace"`. |
| Copilot in VS Code, Windows | The file is `.vscode/mcp.json`, the top key is `"servers"` instead of `"mcpServers"`, and the entry adds `"type": "stdio"`. It uses `"command": "npx"` with `args` starting at `"-y"`. |
| Copilot in VS Code, Mac | Same as Copilot on Windows, with the Mac mount. |

Copilot also needs a hook to turn off its built-in shell; see
[Client setup](clients.md#turning-off-copilots-built-in-shell). Ready-made
files are in [examples/](../examples/).

**On a Mac,** if your project folder sits behind a symlink (for example
`~/dev` on an external disk), use the real path that `cd ~/dev/myproj && pwd -P`
prints.

In every setup below, only the `--...` arguments change. Keep the rest of the
entry as in Setup 1.

## Setup 2: let the agent install packages

The agent usually needs a few package registries. Open only those hosts with
`--allow-domain`; everything else stays blocked.

```json
"--sandbox", "myproj",
"--image", "ubuntu:24.04",
"--mount", "C:\\Users\\<you>\\dev\\myproj:/workspace",
"--allow-domain", "archive.ubuntu.com",
"--allow-domain", "security.ubuntu.com",
"--allow-domain", "registry.npmjs.org",
"--allow-domain", "pypi.org",
"--allow-domain", "files.pythonhosted.org",
"--allow-domain", "github.com",
"--allow-domain", "*.githubusercontent.com"
```

| To use | Allow |
| --- | --- |
| `apt-get` in `ubuntu` images, Windows (x64) | `archive.ubuntu.com`, `security.ubuntu.com` |
| `apt-get` in `ubuntu` images, Apple Silicon Mac (arm64) | `ports.ubuntu.com` |
| `npm`, `npx` | `registry.npmjs.org` |
| `pip` | `pypi.org`, `files.pythonhosted.org` |
| `git clone` from GitHub, raw files | `github.com`, `*.githubusercontent.com` |

These lists are starting points. When a download is blocked, a plain HTTP
request gets `403 Forbidden` with a JSON body from the sandbox itself, and an
HTTPS request fails to connect. Add the host named in the error and restart
the client (see [Changing a setup later](#changing-a-setup-later)).

**Tip:** an image that already has your language saves most of the
installing. For example, `node:22` or `python:3.12` (both Debian-based, with
`bash`) work as `--image`. Alpine images lack `bash` and do not work.

## Setup 3: full internet access

When the agent should reach any public website, use `--allow-network` instead
of a list of domains. Home-network addresses stay blocked.

```json
"--sandbox", "myproj",
"--image", "ubuntu:24.04",
"--mount", "C:\\Users\\<you>\\dev\\myproj:/workspace",
"--allow-network"
```

This is the easiest setup, but anything the agent runs can also send data
out to the internet. Prefer Setup 2 when you can.

## Setup 4: project plus a read-only reference folder

Add more `--mount` arguments. `:ro` makes a mount read-only, so the agent can
read it but not change it. The first mount is always the project.

```json
"--sandbox", "myproj",
"--image", "ubuntu:24.04",
"--mount", "C:\\Users\\<you>\\dev\\myproj:/workspace",
"--mount", "C:\\Users\\<you>\\dev\\shared-docs:/ref:ro"
```

## Setup 5: a bigger machine for builds

By default the sandbox gets 1 CPU and 1 GiB of memory. Raise them for
compilers, test suites or large installs:

```json
"--sandbox", "myproj",
"--image", "ubuntu:24.04",
"--mount", "C:\\Users\\<you>\\dev\\myproj:/workspace",
"--cpus", "4",
"--memory", "4g"
```

## Setup 6: several projects

Give each project its own `.mcp.json` with its own `--sandbox` name and mount,
for example `myproj` and `otherproj`. Each project then gets a separate
sandbox, with its own installed packages and network rules.

## First start

The first start downloads the image, which can take a few minutes. The client
starts at once; a command sent before the sandbox is ready answers "still
being prepared" and works on retry. To do the download in a terminal instead
and watch the progress, run the same arguments once with `--prepare`:

```powershell
npx -y @edorosh/shell-mcp@1.2.0 --sandbox myproj --image ubuntu:24.04 --mount C:\Users\<you>\dev\myproj:/workspace --prepare
```

Then ask the agent to run `uname -a`. It should answer with `Linux`.
`--check` with the same arguments tests the whole setup without changing
anything.

## Changing a setup later

shell-mcp remembers how the sandbox was created. When you change the image,
mounts, network rules, CPUs or memory, the next start refuses and lists the
differences, so nothing is lost by surprise. To apply the change, recreate the
sandbox once in a terminal, with the new arguments plus `--prepare --recreate`:

```powershell
npx -y @edorosh/shell-mcp@1.2.0 --sandbox myproj --image ubuntu:24.04 --mount C:\Users\<you>\dev\myproj:/workspace --allow-network --prepare --recreate
```

This keeps your mounted folders but **deletes everything else in the
sandbox**, such as installed packages, which the agent has to install again.
Then restart the client.

## Stopping and removing

The sandbox keeps running after you close the client, so the next start is
fast. To stop it, or to delete it completely:

```powershell
npx -y -p microsandbox@0.7.11 msb ls
npx -y -p microsandbox@0.7.11 msb stop myproj
npx -y -p microsandbox@0.7.11 msb remove myproj
```

A stopped sandbox starts again by itself the next time the client uses it. A
removed one is created again from scratch. Your mounted folders are never
touched.

More detail: [Sandbox and runtime](sandbox.md), all flags in
[Configuration](configuration.md), and problems in
[Troubleshooting](troubleshooting.md).
