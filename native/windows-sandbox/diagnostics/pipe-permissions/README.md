# Windows named-pipe permissions diagnostic

This is a minimal diagnostic and proof of the pipe ACL repair primitive. It is **not** a production helper, a Node/libuv patch, or an Agent runtime switch.

From the repository root on Windows, build the existing sandbox helper if unavailable, then run:

```powershell
cargo build --release --manifest-path native/windows-sandbox/Cargo.toml
cargo build --release --manifest-path native/windows-sandbox/diagnostics/pipe-permissions/Cargo.toml
node --import tsx --conditions=development native/windows-sandbox/diagnostics/pipe-permissions/run.ts
```

The diagnostic compares ordinary Windows execution, managed execution with the platform's default pipe ACL, an explicit private pipe ACL, and replacement of the new pipe's ACL through its server handle before opening the client. It checks `GENERIC_READ`, `GENERIC_WRITE`, both, `WRITE_DAC`, and their combination. Read/write handles must exchange `ping` and `pong`.

Managed cases must continue rejecting a write to a disposable file outside the writable workspace, even though that fixture explicitly grants the signed-in user full access. Only this temporary fixture gets an ACL change. Artifacts are retained in the printed temporary directory for inspection.

The expected default-pipe failure is a diagnostic success. Explicit and repaired pipe cases must succeed without changing file boundaries. The harness fails on a timeout, unexpected access result, communication failure, or outside-file modification.

The remaining integration requirement is ensuring every relevant pipe creator supplies the private ACL. A successful native API proof does not mean unmodified Node, npm, Chromium, or arbitrary grandchildren are repaired.
