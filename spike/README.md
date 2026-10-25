# microsandbox SDK spike

Run this on the Windows host. It probes the SDK behaviours the backend assumes and
prints labeled JSON. It does not modify anything except short-lived `sleep`/`echo`
jobs inside the spike sandbox.

All commands are PowerShell, from the repo root.

```powershell
# 1. Create a scratch dir and the sandbox (pick any image the project uses, e.g. debian or alpine+bash)
mkdir C:\temp\spike-ws -Force
msb create <image> --name spike --mount-dir C:\temp\spike-ws:/workspace
msb start spike          # skip if create already starts it
msb --version

# 2. Install and run
cd spike
npm install
node sdk-check.mjs spike *>&1 | Tee-Object -FilePath spike-output.txt

# Optional: probe a stopped sandbox too
msb create <image> --name spike-stopped
msb stop spike-stopped
$env:SPIKE_STOPPED = "spike-stopped"
node sdk-check.mjs spike *>&1 | Tee-Object -FilePath spike-output.txt
```

Note: the `pgrep` check on the host side only works where `pgrep` exists; the script
also runs `pgrep` inside the guest, which is the one that counts. In the guest output,
`rc=1` with no pid line means no leftover process.

## Paste back

1. The full contents of `spike\spike-output.txt` (or the console output).
2. `msb --version` and the SDK version (printed under `### 7 versions`).
3. Whether `import("microsandbox")` loaded on Windows (`### 0 load` line), or the load error.
4. Any check that printed `UNCAUGHT`.

The results are then recorded in `docs/superpowers/specs/spike-results.md`.
