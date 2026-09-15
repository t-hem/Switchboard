# Later — the review loop

Not to be built until Switchboard itself is working across all three machines. This
is the intent, not a design. Hand it to a planning session when the time comes.

## The loop

1. Agent session does work in a repo, pushes to GitHub, opens a PR.
2. A **separate model** reviews the PR — deliberately not the one that wrote it.
3. Thomas accepts or rejects.
4. On reject: a **new session** opens automatically, seeded with the review agent's
   notes plus Thomas's own notes, to fix what was called out.
5. Loop until accepted. No cap on iterations.

## Principles already settled

- **Fresh session per iteration.** No session history persistence — task done means
  context cleared. The PR thread is the history, and a rejected PR's new session
  reads that thread for its context rather than inheriting a stale conversation.
- **The reviewer is a different model from the author.** The point is an outside
  opinion, not the same model marking its own homework.
- **Thomas stays in the accept/reject seat.** The loop automates the grind around
  the decision, not the decision.

## What Switchboard contributes

Only one thing: the ability to spawn an agent session on a chosen machine from
something that isn't a browser. That already exists. The pipeline is a separate
program that calls it.

Two things in the current code exist to support this and shouldn't be "tidied" away:

- `POST /sessions` is authenticated but **not** claim-gated, so the pipeline can
  spawn without evicting whatever browser is in use.
- Exited sessions stay in the map with their exit code until something clears them,
  so the pipeline can poll for completion. Don't add auto-reaping.

## Open questions for the planning session

- Where does the pipeline itself run? Probably the always-on Linux box, but it could
  live outside Switchboard entirely.
- GitHub webhook or polling?
- How does the reviewer get invoked — a Switchboard session like any other, or a
  plain API call, given it doesn't need a terminal?
- Which machine should a fix session land on? Whichever holds the repo, presumably,
  but that mapping has to come from somewhere.
- How do Thomas's own review notes get into the fix session's prompt — PR comments
  scraped from the thread, or entered separately?
- What happens when a fix session fails or hangs rather than producing a PR.
