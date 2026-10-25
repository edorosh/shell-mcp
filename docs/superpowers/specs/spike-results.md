# Task 1 spike results

Run on 2026-10-25 against a sandbox named `spike` (mount `C:\temp\spike-ws:/workspace`) with `spike/sdk-check.mjs`.

| Item | Value |
|------|-------|
| Host | Windows, x64, Node v24.20.0 |
| SDK | `microsandbox` 0.7.11 (exact pin) |
| Runtime | `msb 0.7.11` (matches the SDK) |
| Guest | Linux 6.12.113 x86_64 |

**Decision:** the SDK loads and works on Windows (10 + 136 exports), so the CLI fallback in design §2 is not needed.

## Findings

1. **Connect.** `Sandbox.get(name)` returns a handle with `status: "running"`; `connectWithTimeout` works; `sb.shell("uname -a")` returns `code 0`.
2. **Exec stream events** (`execStreamWith`, `recv()`): `started {pid}`, `stdout {data: Buffer}`, `stderr {data: Buffer}`, `exited {code}`, then `null` ends the stream. `stdout` and `stderr` arrive as separate events in arrival order.
3. **Deadline kill (S5).** With `.timeout(1000)` the stream delivers the output produced so far (`a`, `b`), then `exited` with `code: -1` after about 1007 ms, then end of stream. Partial output survives. The kill takes the process group down: `pgrep -f "sleep [5]"` in the guest returned rc=1 (no match), also when `sleep` was a child of `bash -c`. `collect()` rejects with `ExecTimeoutError` (`code: "execTimeout"`), as expected, which is why the backend iterates events.
4. **Normal exit.** `exit 3` gives `exited {code: 3}`.
5. **Spawn failure (bad shell).** The stream yields one `undefined` event (the SDK's `normalizeExecEvent` maps `failed` to undefined) and then ends, with no `exited`. The backend's "unknown event, no `started`, no output → `not_started`" rule matches.
6. **Detached jobs.** `execDetachedWith` returns a `Job` with `id` like `job_<32 hex>`. `job.logs()` returns entries `{timestamp, source: "stdout"|"stderr", cursor: "<jobId>:<seq>", data: Buffer}`. `logs({fromCursor})` is exclusive (the first entry after the cursor differs from it). A cursor that is not in the `<jobId>:<seq>` form (`"0"`, `"999999999"`, `"garbage"`) throws `JobError` with `code: "invalid_cursor"`.
7. **Gaps.** `JobLogEntry` has no gap field, and `logs()` offers no way to probe for one on the first read. The README limitation stands. Whether `output_gap` is raised for an expired cursor was not exercised.
8. **Kill.** `job.kill()` then `wait()` gives `{code: -1, success: false, timedOut: false}`; `inspect()` then shows `state: "exited"`, `exitCode: -1` (there is no `killed` state, so the service's `killedByUs` bookkeeping is needed). A child `sleep 100` is gone after the kill (guest `pgrep` rc=1, K1). A second `kill()` on the exited job throws `JobError` `job_not_running`, matching the backend's race handling.
9. **Natural exit.** `exit 7` as a job gives `state: "exited"`, `exitCode: 7`.
10. **Launch failure of a job.** `execDetached("no-such-binary")` throws `JobError` `exec_failed` at launch, so no job exists.
11. **Sandbox errors.** `Sandbox.get("does-not-exist")` throws `SandboxNotFoundError` with `code: "sandboxNotFound"`.
12. **JobState values seen:** `running`, `exited`.

## Not exercised (still unverified)

- **Stopped sandbox.** `SPIKE_STOPPED` was not set, so the error for a stopped sandbox, and the criterion-10 flow with a cached connection, still need the integration run.
- **`job_not_found`.** The probe used a malformed id and got `invalid_id`. A well-formed id that doesn't exist was not tried. Real ids from the registry are always well formed.
- **`output_gap`, `launch_unconfirmed`, `sandboxReplaced`.** Not triggered; the backend handles them from the SDK source only.
- **Client timeouts (design §2 risk 5).** Part of the manual client check, Task 10 step 2.

## Integration run (`test/integration.test.ts`, same sandbox)

10 passed, 1 skipped (criterion 10, needs `SHELL_MCP_IT_ALLOW_STOP=1`), **1 failed**.

- Passed: criteria 1–9 and 11, including 5 (`sleep 30`, `timeout_ms` 1000, process gone) and 8 (background loop, kill).
- **Failed: criterion 12.** After the host deleted the current directory (`fs.rmSync` on `C:\temp\spike-ws\<scratch>\gone`), the next `pwd` printed `/workspace/<scratch>/gone`: the wrapper's `cd -- '<cwd>'` still succeeded in the guest, so no reset happened and no note was printed. The wrapper itself is not at fault; the guest still resolves the directory after the host deleted it, which points at the host-mount caching in the guest (to be confirmed).

### Criterion 12: host-mount delay (measured by hand)

`mkdir C:\temp\spike-ws\gone`, `ls -d /workspace/gone` in the guest (visible), `Remove-Item` on the host, then in the guest: the directory was **still visible immediately** (`rc=0`) and **gone after 5 s** (`rc=1`). The guest's view of host-side deletes lags, so `cd` into a just-deleted directory can still succeed. The integration test for criterion 12 now waits (up to 20 s) until the guest no longer sees the directory before running `pwd`. The window length is not yet measured.
