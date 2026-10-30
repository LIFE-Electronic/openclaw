# Wolper OpenClaw 2026.5.28 fork

This branch carries Wolper's reviewed native runtime fixes on upstream tag
`v2026.5.28` (`e93216080aa1f425d3ab127014603eba8e365b2d`).
The patches originate in `LIFE-Electronic/wolper` at
`openclaw-patches/2026.5.28/`; `test/wolper/provenance.json` records their input
checksums and source commit. The fork applies their behavior directly to source.

The fixes cover copied-media receipts, Webchat completion routing, prompt-lock
disposal, heartbeat identity, durable BlueHouse background delivery, transcript
retry identity, cron validation, cron job-name snapshots, and native session
copies for opted-in managed channels.
`bluehouse` cron/heartbeat delivery and `wolper.deliveries.pending`, `.ack`, and
`.status` require the matching Wolper backend. The package version stays
`2026.5.28`; use the full Git commit to identify a fork build.

## Canonical Wolper branch

[`wolper-base/2026.5.28`](https://github.com/LIFE-Electronic/openclaw/tree/wolper-base/2026.5.28)
is the master/integration branch for Wolper's OpenClaw 2026.5.28 runtime.

| Branch                  | Role                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `wolper-base/2026.5.28` | Canonical Wolper branch; base new native feature branches and PRs on it.                                                       |
| `wolper/2026.5.28`      | Previous feature branch, merged into the canonical branch through [PR #1](https://github.com/LIFE-Electronic/openclaw/pull/1). |
| `main`                  | Separate upstream history; not the Wolper integration target.                                                                  |

Set the PR base explicitly, regardless of GitHub's default branch:

```sh
gh pr create --repo LIFE-Electronic/openclaw --base wolper-base/2026.5.28
```

Wolper image builds must still pin a reviewed full commit SHA. A merge into the
canonical branch does not update the backend's fork revision or deploy an image
automatically. The backend's [branch and build guidance](https://github.com/LIFE-Electronic/wolper/blob/feat/postgresql-backend/openclaw-patches/README.md)
describes `OPENCLAW_SOURCE_MODE`, `OPENCLAW_SOURCE_DIR`, and `OPENCLAW_SOURCE_REF`.

## Background channel copies

Actionable results handed to Wolper always include BlueHouse Main
(`agent:main:main`). Wolper can additionally select an opted-in iMessage or
WhatsApp binding for that agent. Consent, channel linking, provider transport,
and transport receipts belong to the Wolper backend. This fork provides the
channel-independent native session append; the change is source code in this
checkout and is part of [OpenClaw PR #1](https://github.com/LIFE-Electronic/openclaw/pull/1),
without a new patch artifact.

`wolper.messages.copy` requires an administrator-scoped backend client. Its
request carries `copyId` (UUID), original `executionId`,
`destinationSessionKey`, cron/heartbeat `origin`, and an assistant `message`.
The method does not dispatch a model run or send to a channel. It uses
`appendExactAssistantMessageToSessionTranscript` to preserve parent links,
normal content redaction, and the next model turn's conversation context.

The result is either `{status: "busy", copyId}` or a committed receipt containing
`copyId`, `executionId`, `destinationSessionKey`, `sessionId`, `messageId`, and
the actual stored `message`. Only a committed receipt emits
`wolper.message.copied`, with the same payload as the RPC response. Wolper uses
that content for its destination row before making transport parts eligible.
Native confirmation does not claim provider or device delivery.

`src/infra/wolper-message-copy.ts` stores request digests, session identities,
and receipts under `wolper-message-copies/` in the state directory. A per-copy
lock serializes concurrent retries. The transcript key `wolper-copy:<copyId>`
recovers an append if receipt publication was interrupted. Reusing an identity
with different content or a changed destination session is refused. The runtime
adapter in `src/infra/wolper-message-copy-runtime.ts` checks destination activity
and session identity before appending; a busy destination defers the copy.

Wolper keeps Main, selection, and provider delivery as distinct durable stages.
Opt-in defaults false, resets on relink/switch, and covers both cron and heartbeat.
Opt-out cancels unsent work; an in-progress append or provider send cannot be
recalled. Retained media points at already captured bytes and receives
destination-scoped URLs in Wolper. The backend rejects unrequested or retired
copies and does not fan out confirmation echoes. An older runtime lacking this
method leaves the copy waiting for an upgrade and cannot trigger a direct-send
fallback. See the [frontend/API contract](https://github.com/LIFE-Electronic/wolper/blob/feat/background-channel-copies/tech_notes/background-notifications.md).

Native tests are `src/infra/wolper-message-copy{,-runtime}.test.ts`,
`src/gateway/server-methods/wolper-message-copy.test.ts`, and
`src/agents/wolper-background-identity.test.ts`. They cover concurrent/restarted
retries, interrupted receipts, real transcript/context state, busy admission,
identity refusal, and backend-only RPC access. The Wolper
[PR 110 rollout](https://github.com/LIFE-Electronic/wolper/blob/feat/background-channel-copies/migration-scripts/110/README.md)
adds installed-copy verification to the guarded fork image workflow. Its
`scripts/openclaw/background-copy-probe.mjs` exercises installed code in isolated
temporary state; fresh provisioning and live transport acceptance remain
separate checks.

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

The imported code has upstream formatting/lint corrections. This fork owns the
media helper's only implementation. Its Dockerfile ships the committed source at
`/app/src/agents/generated-media-identity.ts` alongside the compiled runtime so
installed probes can verify it. Wolper's overlay supplies no helper copy, and
fork builds do not compare their helper against a second implementation.

Upstream regression coverage also checks direct-delivery replay identity:
scheduled executions have distinct IDs, and delivery retries reuse the original
ID. Gateway method order stays stable, and Control UI/macOS protocol models
recognize BlueHouse destinations. Core runtime and Control UI tests cover these
fork integration fixes; native macOS tests require a macOS runner.

## Fork CI policy

Automatic CI retains backend tests, types, lint, builds, runtime contracts,
secret detection, workflow security checks, and the production dependency audit.
CodeQL, CodeQL Critical Quality, and OpenGrep use GitHub-hosted Ubuntu runners
in forks because upstream's Blacksmith runners are unavailable here.

In `LIFE-Electronic/openclaw`, automatic CI skips upstream docs publishing checks.
The root npm shrinkwrap remains checked; plugin shrinkwrap checks run when their
dependency inputs change. Lockfile or workspace policy changes still select all
affected packages. Manual CI retains the full docs and shrinkwrap checks.
Dependency audit findings remain failures and can still produce notifications.

These workflows are disabled through the fork's GitHub Actions settings:

- `auto-response.yml`, `labeler.yml`, and `clawsweeper-dispatch.yml`: upstream
  administration that depends on upstream GitHub Apps.
- `docs-agent.yml`: upstream docs automation.
- `ci-build-artifacts-testbox.yml` and `ci-check-testbox.yml`: duplicate checks
  requiring unavailable Blacksmith runners. The regular CI build and check jobs
  stay enabled.

These are repository settings, independent of the branch. To reproduce a setting
or explicitly restore a workflow after configuring its infrastructure, use
`gh workflow disable <file> --repo LIFE-Electronic/openclaw` or the matching
`gh workflow enable` command. Disabling a workflow does not cancel an already
queued run; cancel that specific run separately.

## Build and activate a candidate

Use Wolper's `build-image.sh` with `OPENCLAW_SOURCE_MODE=fork`,
`OPENCLAW_SOURCE_DIR` pointing at this checkout, and `OPENCLAW_SOURCE_REF` set to
the full current commit SHA. The checkout must be clean. Select unique candidate
image tags. The build archives only committed files, runs the native contracts
and TypeScript checker, and records the SHA in `/app/dist/build-info.json`.

Follow Wolper's `migration-scripts/109/README.md` for explicit-target dry-run,
guarded activation, fresh-provisioning verification and rollback. Fork builds are
opt-in; publishing this branch does not change any runtime or image default.
