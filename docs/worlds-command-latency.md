# Worlds command latency: new fixed observation

This is a **new** Node controller observation, not a historical comparison or whole-engine benchmark. Implementation/readiness and pure tests are not measured latency proof. Execution requires fresh review and separate authorization.

## Read-only readiness

From the canonical checkout:

```bash
REPO_ROOT="/absolute/path/to/modly"
NODE24="/absolute/path/to/node-v24.14.1"
cd "$REPO_ROOT"
"$NODE24" \
  ./scripts/worlds-command-latency.mjs --report-only
```

Report-only reads/hashes source files and the Node binary, resolves installed module paths without evaluating application modules, and prints a source manifest, seal and exact `proposedArgv`. It does not import application code, instantiate a controller/repository, create evidence/workspace directories, or run the scenario. Importing the script from pure tests is also inert. No mode is an error; `--help` prints usage.

The sole run interface is `--run --seal-sha256` followed by the independently reviewed seal printed by report-only. Use its **exact** proposed argv with the sealed Node24.14.1 binary, canonical cwd, and empty/unset `NODE_OPTIONS` and `NODE_PATH`. No workspace, sample-count, durability, provider or instrumentation overrides exist. Unknown flags and source/runtime drift fail closed before application import.

The seal follows literal runtime ESM imports, skips type-only imports, and includes the harness/tests/doc, root package metadata/lockfile, installed Three ESM files and its package metadata. The real empty-entity builder reaches Three through the behavior/entity graph; no renderer is created. Only `three` is accepted as a bare application dependency. Missing/ambiguous imports, unsupported syntax and symlink escapes are blockers. If extensionless imports exist, the **existing** `scripts/node-ts-extensionless-loader.mjs` is selected up front and included in the seal/argv. Never add a loader or repair the environment after failure. Readiness does not execute the TypeScript closure, so runtime import compatibility remains untested until an authorized run.

## Fixed workload and interpretation

- Real controller -> real normalizing service -> real repository, configured only with the exclusively owned workspace root. Default sync, clock, IDs and lock checks remain intact.
- Create/open through the service to retain durability warnings, then 32 **untimed** controller setup batches: add100 empty entities in batch1 and31 ordinary transforms of the first entity. Setup ends at revision32, undo32, redo0, direct receipts32, ledger32, backups8.
- Exactly20 sequential measured transforms, positions32 through51 and revisions33 through52. The clock starts immediately before unwrapped `dispatchCommands` and stops immediately after promise settlement. Only measured rows have durations. Builders, expected-value preparation, input logging, assertions, disk inspection and inter-sample I/O are outside the timer. Their cache impact is disclosed; no forced GC/cache manipulation, parallelism or extra warmup is used.
- Preserve decimal integer nanoseconds and every row, including failures. Nearest-rank p50=item10, p95=item19, max=item20. Strict success requires **all20 <50,000,000 ns** plus complete functional/source/cleanup gates. A passing p95 with one50ms outlier is a latency failure. No repository submetric or CPU/disk decomposition is claimed.
- Untimed postconditions cover recursive frozen/unchanged retained data; preview with no authoritative/disk change; controller-cache retry separately from actual fresh-service durable replay of the original base51 batch; changed-payload reuse rejection on both paths; real Undo53/Redo54 with full-document/disk equality; and a new repository/service/controller open at54 with empty volatile history/receipts. Every unexpected warning, including ordinary filesystem `durability-degraded`, fails the functional gate.

## Evidence and one-attempt envelope

After valid run admission, the harness creates a new0700 evidence directory under `docs/worlds-engine-evidence/2026-09-09/backup-semantic-bridge/latency-measurements/` and a new0700 `/tmp/modly-worlds-command-latency-new-*` workspace. It never uses a user/app workspace. Evidence includes scenario/actual batch inputs and hashes, metadata/runtime/filesystem identity, source manifests, raw rows, expected/observed snapshots, public receipts and settled ledger/backups, tree manifests, postcondition comparisons, partial/error summaries, ownership and cleanup records.

The external invocation envelope must be separately/exclusively allocated and retain actual argv/cwd, `git status --short` (including relevant untracked files), HEAD/branch, raw stdout/stderr, start/end and **actual** timeout exit/signal. No child process is needed inside the harness: its metadata reads HEAD/ref/index directly; dirty status belongs to the envelope, not inferred from HEAD. Redirect output from the exact proposed argv inside `/usr/bin/timeout --signal=TERM --kill-after=5s 180s`. The internal170-second deadline stops admitting operations after the current promise settles. Do not retry, extend the deadline, switch runtimes or patch source. The harness's `exit-code.txt` is the intended CLI exit; the external envelope is authoritative if the process is interrupted or killed.

| Exit | Meaning |
| --- | --- |
| 0 | Complete functional/source/cleanup PASS and every measured command under50ms |
| 2 | Complete functional/source/cleanup PASS, but strict latency target FAIL |
| 1 | Partial/invalid/source drift/functional/cleanup/error; no timing win |

Partial setup/import/helper failure is retained and cannot become a fast-sample success. The pending batch is persisted before dispatch so external termination leaves honest partial evidence even without a terminal row. Cleanup happens only after controllers settle and partial/final evidence is written, and only after matching the durable token plus exact path/realpath/device/inode/uid and directory identity. No sentinel is written inside the measured tree. If interrupted before safe cleanup, retain the owned root and use its ownership record for a separately reviewed cleanup; never glob-delete old roots.

Pre/post hashes cannot detect transient changed-and-restored code: the exact closure must remain frozen throughout the run. `/tmp` filesystem type is recorded (including tmpfs/overlay/unknown); do not assume physical disk. Fresh-instance reopen is same-process persistence proof, not power-loss/crash, native/Electron restart, UI/IPC, renderer or GPU proof. Twenty warm sequential samples are not independent replications or a confidence interval.

## Pure contract verification

The focused suite is `scripts/worlds-command-latency.test.mjs`, mechanically registered in the canonical Node runner. It can be invoked directly using the fixed Node binary with `--test --test-isolation=none --test-reporter=tap --test-concurrency=1`. It exercises contracts/source inventory and never dispatches a World command. Preserve the original nine-case RED evidence; direct named GREEN does not prove full-runner child output or the real observation.
