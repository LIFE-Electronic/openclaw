# Wolper OpenClaw 2026.5.28 fork

This branch carries Wolper's reviewed native runtime fixes on upstream tag
`v2026.5.28` (`e93216080aa1f425d3ab127014603eba8e365b2d`).
The patches originate in `LIFE-Electronic/wolper` at
`openclaw-patches/2026.5.28/`; `test/wolper/provenance.json` records their input
checksums and source commit. The fork applies their behavior directly to source.

The fixes cover copied-media receipts, Webchat completion routing, prompt-lock
disposal, heartbeat identity, durable BlueHouse background delivery, transcript
retry identity, cron validation, and cron job-name snapshots.
`bluehouse` cron/heartbeat delivery and `wolper.deliveries.pending`, `.ack`, and
`.status` require the matching Wolper backend. The package version stays
`2026.5.28`; use the full Git commit to identify a fork build.

## Verify source changes

With Node 24.22.1, run the native contracts without installing dependencies:

```bash
node test/wolper/run.mjs
```

The runner sets the source root explicitly, so source-dependent contracts do not
skip. These tests exercise actual source functions with synthetic providers and
temporary files. Historical Wolper transcript-repair tests remain in Wolper.
The fork also retains upstream tests; use the commands in `AGENTS.md` for focused
Vitest, type, lint and build checks.

The imported code has upstream formatting/lint corrections. The media helper is
kept byte-identical to the copy shipped by the matching Wolper overlay so its
compiled-runtime probe can verify the source used for the build.

## Build and activate a candidate

Use Wolper's `build-image.sh` with `OPENCLAW_SOURCE_MODE=fork`,
`OPENCLAW_SOURCE_DIR` pointing at this checkout, and `OPENCLAW_SOURCE_REF` set to
the full current commit SHA. The checkout must be clean. Select unique candidate
image tags. The build archives only committed files, runs the native contracts
and TypeScript checker, and records the SHA in `/app/dist/build-info.json`.

Follow Wolper's `migration-scripts/109/README.md` for explicit-target dry-run,
guarded activation, fresh-provisioning verification and rollback. Fork builds are
opt-in; publishing this branch does not change any runtime or image default.
