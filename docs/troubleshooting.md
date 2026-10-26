# Troubleshooting

## The agent does not report Linux for `uname -a`

The agent may still be using its built-in shell; turn it off as described in
[Client setup](clients.md). If the call fails, run `--check` (see
[Configuration](configuration.md#--check)) and make sure the sandbox is running.

## Native module failure in `--check` on Windows

`npm config get os` must print nothing on Windows. An `os=linux` line in a
user or project `.npmrc` makes npm fetch the Linux binaries, and `--check`
reports it as a native-module failure. Fix it with:

```powershell
npm config delete os
```

Then re-run the `--check` command. If the Linux package is already cached,
clear the npx cache (see the next entry) before retrying.

## `msb create` says the mount goes through a symlink

On a Mac, `msb create` fails with `invalid config: bind mount host path ...
goes through symlink ...; use the resolved path ...` when part of the folder
path is a symlink (for example `~/dev` pointing at another volume). Mount the
resolved path instead, which `pwd -P` prints:

```zsh
npx -y -p microsandbox@0.7.11 msb create ubuntu:24.04 --name myproj --mount-dir "$(cd ~/dev/myproj && pwd -P):/workspace"
```

Use that same path as `--host-root`. See [Sandbox and runtime](sandbox.md#macos).

## `--check` says macOS needs Apple Silicon

The full message is `macOS needs Apple Silicon and an arm64 Node (this Node is
x64: an Intel Mac, or Node running under Rosetta)`. Check which Node runs:

```zsh
node -p process.arch
```

`x64` on an Apple Silicon Mac means an Intel build of Node, often started from
a Terminal or editor set to open with Rosetta. Install an arm64 Node (for
example from nodejs.org or a version manager run natively) and make sure the
client starts that one. On an Intel Mac shell-mcp does not run. On other
platforms the same check reports `reinstall shell-mcp without --omit=optional
on this OS and CPU` instead.

## Access denied when clearing the npx cache or upgrading

Deleting `%LOCALAPPDATA%\npm-cache\_npx`, or an upgrade that replaces it, fails with
"access denied" on `microsandbox.win32-x64-msvc.node` while a client is
running shell-mcp (Windows locks loaded DLLs). Close the clients first.

A sandbox created with the packaged runtime (`npx -y -p microsandbox@… msb create`)
keeps `msb.exe` running from inside that npx cache or `node_modules` folder, so
`msb.exe` and `libkrunfw.dll` stay locked too. Stop the sandbox first
(`msb stop <name>` with the same runtime and `MSB_HOME`), or find the process with
`Get-Process msb | Select-Object Id, Path` and stop it.

## `npx @edorosh/shell-mcp@<version>` runs a different version

Run inside a clone of this repository, `npx` runs the local project's copy
instead of the published one. Run it from another folder.
