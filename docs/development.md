# Development

## Build and test

```powershell
git clone https://github.com/edorosh/shell-mcp
cd shell-mcp
npm ci
npm run typecheck
npm test
npm run build
```

`npm test` runs the unit tests and needs no sandbox. The server is then
`node <clone>\dist\index.js`, with the same flags as the published package
(see [Configuration](configuration.md)). `npm run check:pack` checks the
packed tarball the way CI does.

Run `npx @edorosh/shell-mcp@<version>` from outside the clone: inside it, npx
runs the local copy.

## Integration suite

The suite runs on Windows or on an Apple Silicon Mac, with a running sandbox.
In PowerShell:

```powershell
$env:SHELL_MCP_IT_SANDBOX="myproj"; $env:SHELL_MCP_IT_HOST_ROOT="C:\Users\<you>\dev\myproj"; $env:SHELL_MCP_IT_GUEST_ROOT="/workspace"; npx vitest run test/integration.test.ts
```

Expected: 12 pass, or 11 pass and 1 skipped. The skipped one stops the sandbox;
set `SHELL_MCP_IT_ALLOW_STOP=1` to run it.

On macOS, first put the SDK's bundled `msb` on `PATH`, from the repo root, and
use the resolved (`pwd -P`) project path:

```zsh
export PATH="$PWD/node_modules/@superradcompany/microsandbox-darwin-arm64/bin:$PATH"
SHELL_MCP_IT_SANDBOX=myproj SHELL_MCP_IT_HOST_ROOT="$(cd ~/dev/myproj && pwd -P)" SHELL_MCP_IT_GUEST_ROOT=/workspace npx vitest run test/integration.test.ts
```

CI runs typecheck, build and tests on Ubuntu, Windows and macOS, and the pack
check on Windows and macOS.

## SDK spike

See [spike/README.md](../spike/README.md):

```powershell
mkdir C:\temp\spike-ws -Force
msb create <image> --name spike --mount-dir C:\temp\spike-ws:/workspace
msb start spike          # skip if create already starts it
msb --version
cd spike
npm install
node sdk-check.mjs spike *>&1 | Tee-Object -FilePath spike-output.txt

# Optional: probe a stopped sandbox too
msb create <image> --name spike-stopped
msb stop spike-stopped
$env:SPIKE_STOPPED = "spike-stopped"
node sdk-check.mjs spike *>&1 | Tee-Object -FilePath spike-output.txt
```

## Releasing

See [releasing.md](releasing.md).

## Design documents

- [Product spec](product-spec.md): the normative requirements.
- [ROADMAP.md](../ROADMAP.md): milestones.
- [docs/superpowers/](superpowers/): design specs, implementation plans and
  spike results for each milestone.

## `Unable to resolve @typescript/typescript-win32-x64` on `npm run build` or `npm run typecheck`

The project builds with TypeScript 7, which runs a compiler from a per-platform package
(`@typescript/typescript-<os>-<cpu>`). The lockfile lists all of them, and npm installs only
the one matching the machine. This error means `node_modules` contains a different platform's
package, for example `@typescript/typescript-linux-x64`. Check with:

```powershell
dir node_modules\@typescript
```

Typical causes: `node_modules` was installed on another OS (for example by copying a folder,
or from a Linux sandbox sharing the folder), or npm detected the wrong platform on your
machine. Fix it by reinstalling with the platform stated explicitly:

```powershell
Remove-Item -Recurse -Force node_modules
npm ci --os=win32 --cpu=x64
dir node_modules\@typescript     # should now list typescript-win32-x64
npm run build
```

If a plain `npm ci` keeps installing the wrong package, find out why npm thinks it is on
another platform:

```powershell
node -p "process.platform + ' ' + process.arch"      # expect: win32 x64
where.exe node                                       # a Windows install, not a WSL or Git Bash shim
npm config get os
npm config get cpu
Get-ChildItem Env: | Where-Object Name -like 'npm_config*'
Get-Content $HOME\.npmrc -ErrorAction SilentlyContinue
```

An `os` or `cpu` setting, an `npm_config_os`/`npm_config_cpu` variable, or an `.npmrc` line that
names `linux` is the override: remove it. As a last resort, pin the platform in your **user**
npm config (not in the repository, because Linux CI needs the default):

```powershell
npm config set os win32
npm config set cpu x64
```

The same wrong-platform install would also break the native `microsandbox` package, so fix it
before running the spike or the integration suite. Do not install dependencies in a folder that
a Linux sandbox shares with your Windows checkout; use a separate clone for each.
