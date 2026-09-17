# Jobs application review — 2026-09-17

Review baseline: `c5fcd76`. Changes are local and uncommitted. Scope: jobs service,
standalone jobs UI, workflow/state transitions, browser/network handling, worker recovery,
records/exports, and the existing tests. No host/core-web changes, live application sends,
production data edits, or service restarts were performed.

## Fixed

- **High — stale approvals and duplicate applications.** Changing the selected resume now
  cancels draft/approved attempts. Approval requires the newest attempt and selected resume.
  Preparation, resume selection and manual completion refuse completed or unresolved sends.
  Repeating preparation reports an existing approved attempt honestly. Idempotency includes
  snapshot/resume revision IDs, not just identical content hashes.
- **High — concurrent preparation.** After browser work, preparation checks that the selected
  resume, latest complete snapshot, settings revision and latest attempt have not changed.
  Concurrent identical requests reuse one result; competing different requests cannot both
  publish stale drafts. Resume upload staging is content-specific so another preparation
  cannot overwrite the file a browser is about to upload.
- **High — send boundary.** Browser-backed sends recheck pause, current policy and existing
  evidence gates immediately before pressing submit. Session-construction failures now
  release unsent claims. A lost claim is not restored over an unknown/completed outcome.
  Browser submission no longer unconditionally enables private-network access.
- **High — recovery fencing.** Recovery rediscovers and records children created before the
  session ID was saved. A different spawner instance cannot classify the original host's
  child as absent. Ownership is checked again after asynchronous inspection. Shutdown waits
  for an in-flight worker tick, and expired scheduler ownership abandons rather than kills
  a potentially live child. Releasing a lease preserves monotonic generations.
- **Medium — scheduler overlap.** Manual run-now and timer/worker cycles share one local
  single-flight guard. Subsequent sources recheck pause and scheduler ownership.
- **High — network hardening.** HTTP response-body reads retain the timeout and enforce a
  streaming byte limit. Hexadecimal IPv4-mapped IPv6 cannot bypass private-address checks.
  Browser redirects/subresources are checked before sending through request interception.
  This is hardening, not a complete network sandbox; see remaining work below.
- **Medium — process ownership.** Browser cleanup matches the exact profile argument instead
  of a path prefix, and rechecks ownership before escalating to SIGKILL.
- **Medium — archive integrity.** Read-only archive startup skips submission sweeping and
  stale-browser cleanup. Records include failed/no-resume runs linked through application
  tasks, resume decisions, attempt policy revisions, and profile/template revisions.
  Export discovers hashes inside JSON-encoded evidence, flushes files before publishing,
  and rejects malformed/path-like artifact names before reading them during reconstruction.
- **Medium — rendered output.** Reordering resume sections now also reorders preview/final
  text, not just the structured object.
- **UI.** The selected resume can be changed after initial selection, with an approval
  warning. External posting/form links accept only HTTP(S). Approved preparation reuse no
  longer produces an `undefined` status message.

## Validation

- Jobs TypeScript compilation and standalone jobs UI build.
- Jobs test suite, including new approval/concurrency, recovery, scheduler, streaming HTTP,
  browser interception, upload isolation, export and send-boundary regressions.
- The sandbox prevents the storage suite's subprocess scenarios. Its 12 tests pass when
  rerun outside that restriction, including SIGKILL durability and process competition.
- Real Chromium `acceptance/rollout.mjs`: **ALL PASS**. Uses a disposable data directory and
  loopback employer fixture: capture, render, select, prepare, approve, one observed send,
  offline export, restart, unknown-outcome recovery and explicit reconciliation.
- Corrected two old tests that tried to reuse an already-submitted application for another
  send. Daily-cap and restart tests now use separate applications and assert that reopening
  the completed application is refused.
- `git diff --check`.

This review did not run the full real-host crash matrix, live model invocation, real employer
submission, real phone testing, or the complete core-host/browser acceptance matrix.

## Remaining release blockers and follow-ups

1. **Model-driven tailoring is still incomplete.** The jobs-owned agent tool bridge is
   missing, shipped personas are placeholders, and the real pi JSON envelope has not been
   verified. Existing fake-spawner tests cannot establish live model readiness.
2. **Stage-review gates are not fully implemented.** `runner.ts:afterAccept` queues the edit
   pass immediately after assembly. `Reviews.decide` records a generic decision but does
   not apply it to stage progression or finish the corresponding tailoring task. Settings
   expose discovery/build/edit/preparation gates, but only the submission gate has its
   complete send-time enforcement. Implement workflow-specific decision consumers and
   stage-transition tests before describing these settings as working pause/resume gates.
   This review did not invent that missing workflow or auto-dispatch work on generic approval.
3. **Recovery acceptance remains incomplete.** Exercise the real host/jobs/both-crash matrix.
   A run classified `lost` still needs a clearer operator reconciliation path; retry refuses
   unresolved children intentionally. Discovery interrupted in `running` state also needs
   explicit restart/checkpoint coverage. These must not be "fixed" by blindly retrying work.
4. **Browser/network isolation is not complete.** DNS validation and the actual connection
   perform separate resolution; rebinding is not fully prevented. Request interception is
   not an OS egress boundary and does not claim to isolate every browser transport. Chromium
   currently launches with `--no-sandbox`. Use a dedicated restricted execution environment
   before treating arbitrary hostile employer pages as safely isolated from the machine.
5. **Production evidence and adapters.** Real-site extraction/freshness and resume readability
   need representative captures. The current send path still needs stronger integrity checks
   for posting screenshots, beyond its completeness/freshness and resume-artifact checks.
   The browser form adapter is a fixture adapter, not a verified real-site integration.
   PDF output remains deferred. No real employer submission was attempted.

The result is a hardened local/fixture workflow, not a sign-off for unattended applications.
