# Job sources and adapter implementation notes

Research date: 2026-09-16. Companion to [JOB-APPLICATION-PLAN.md](./JOB-APPLICATION-PLAN.md).
Documentation reviewed; no live scraping, accounts, notifications or applications tested.
Listed API support is not a blanket determination that every employer permits every
kind of automation. Recheck documentation and site policy when enabling a real target.

## First implementation order

Build manual import and local fixtures first, then Greenhouse discovery for one configured
company. Add Lever and Ashby, then SmartRecruiters and Workable, each in a separate
verified adapter commit under steps 5/8. Their shared output is normalized posting data
plus preserved raw responses. JobSpy is an optional extra discovery worker, not the
application engine. Form automation is separately scoped under steps 9/10; a completed
discovery adapter does not have to support automatic submission.

Prefer fetching the employer's original posting over an aggregator copy when a permitted
original link exists. Preserve both source records and explain the canonical match.
Do not merge solely on company/title: requisition IDs, locations, URLs and reposts can
differ. Ambiguous matches stay separate for review. A failed/partial scan must not mark
all missing jobs closed; only a completed authoritative scan can supply that evidence.

## Selected starter set — 10 companies

Selected 2026-09-16 for variety across the five company-board adapters, not applicant
fit. Links below are company posting/board references checked during planning; actual
API responses, slugs and terms still get their adapter smoke checks before enabling.
A stale slug is a visible setup error, not a reason to abandon the source or fabricate jobs.

| Company | Adapter | Initial board identifier | Board reference |
|---|---|---|---|
| Canonical | Greenhouse | `canonical` | [Board](https://job-boards.greenhouse.io/canonical) |
| Datadog | Greenhouse | `datadog` | [Board reference](https://job-boards.greenhouse.io/embed/job_app?for=datadog&token=6793408) |
| Cloudflare | Greenhouse | `cloudflare` | [Posting reference](https://job-boards.greenhouse.io/cloudflare/jobs/7863831) |
| Palantir | Lever | `palantir` | [Board](https://jobs.lever.co/palantir) |
| Zoox | Lever | `zoox` | [Board](https://jobs.lever.co/zoox/) |
| Ashby | Ashby | `ashby` | [Posting reference](https://jobs.ashbyhq.com/ashby/0f5dbf59-687b-4d88-88a7-73ee0a66b48d) |
| Linear | Ashby | `Linear` | [Board](https://jobs.ashbyhq.com/Linear) |
| ServiceNow | SmartRecruiters | `ServiceNow` | [Board](https://careers.smartrecruiters.com/ServiceNow) |
| Visa | SmartRecruiters | `Visa` (validate canonical casing) | [Board](https://careers.smartrecruiters.com/visa) |
| Hugging Face | Workable | `huggingface` | [Board](https://apply.workable.com/huggingface/) |

Seed company feeds plus JobSpy entries for LinkedIn, Indeed, Glassdoor, Google and
ZipRecruiter. Seeded is not automatically enabled: retain per-site restrictions below;
manual import/handoff remains usable for a restricted source. Missing API permission
must not be treated as a passing smoke test. Preserve casing where board IDs require it.

Start with a manual discovery run; enable six-hour scheduling once approved. One
concurrent request per source, at most two bounded retries, and honor tighter server
limits. Archive complete permitted API results, then classify broad IT families locally.
For expensive browser/model tests, select at most 20 representative IT postings per
run across the companies; leave the remaining records queued and label the test cap.
A cap must not silently discard stored jobs or imply a full scan completed.

IT families: support/help desk, systems/network administration, cloud/platform/DevOps/
SRE, cybersecurity, software/web/mobile, QA/test automation, data engineering/analytics/
databases, and enterprise applications. Include technical management; exclude clearly
nontechnical sales/recruiting/finance and unrelated mechanical/civil engineering.
Classify ambiguous roles as needs-review. All seniorities, work arrangements and salary
ranges initially; no applicant location/work-authorization assumptions. Aggregator test
queries start with United States and several role-family queries rather than literal
“IT,” all editable. Every application action remains human-gated initially.

Acceptance: import the seed twice without duplicates; edit/disable an entry from the
UI; show source-by-source status and restrictive policy reasons; support all listed
families; never process synthetic applicant data as a real submission. Use local fixture
responses for automated tests, with permitted live discovery a separate explicit smoke.

## Source-specific findings

| Source | Discovery implementation | Submission boundary |
|---|---|---|
| Greenhouse | GET `https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true`; retain IDs, source URLs and content; use per-job detail for additional fields | Documented application POST requires an employer API key. Public GET access is not enough. Hosted form/manual handoff is the baseline |
| Lever | GET `https://api.lever.co/v0/postings/{site}?mode=json`; use `skip`/`limit` and configured global/EU region, retain `hostedUrl`/`applyUrl` | Documented POST also requires an account API key. Public posting data does not expose custom application questions; inspect the permitted hosted flow |
| Ashby | GET `https://api.ashbyhq.com/posting-api/job-board/{board}?includeCompensation=true`; retain plain/HTML description, compensation, job/apply URLs; respect `isListed` | Lightweight posting endpoint is discovery. Do not assume an unauthenticated application API; start with permitted hosted flow/manual handoff |
| Workable | Prefer documented public GET `https://www.workable.com/api/accounts/{subdomain}?details=true` | Employer SPI endpoints are authenticated; do not build on assumed applicant access |
| SmartRecruiters | GET `https://api.smartrecruiters.com/v1/companies/{companyIdentifier}/postings`; explicit PUBLIC destination, `limit` (max 100)/`offset`; fetch posting detail separately | Posting API is distinct from candidate/application integrations. Resolve submission capabilities separately, not from successful listing requests |

Primary documentation supporting this table:

- [Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html): public reads,
  job content/details and authenticated application creation. Its submission endpoint
  also leaves required-field validation to the caller; our form validation cannot be
  replaced by treating any HTTP success as complete evidence.
- [Lever Postings API](https://github.com/lever/postings-api): global/EU URLs, pagination,
  hosted application links, limits of public form data and API-key requirement for POST.
- [Ashby public posting API](https://developers.ashbyhq.com/docs/public-job-posting-api):
  public board URL, plain/HTML descriptions, optional compensation and listing visibility.
- [Workable careers-page guidance](https://help.workable.com/hc/en-us/articles/115012771647-Using-the-Workable-API-to-create-a-careers-page):
  documented public account endpoint with `details=true`, separate authenticated SPI.
  The proposed `apply.workable.com/api/v3/accounts/{co}/jobs` URL was not established
  as a supported integration by this documentation; treat it as an unverified website
  interface, not the initial production contract. If needed, verify method/payload,
  pagination and permission on the chosen target before adding a separate adapter version.
- [SmartRecruiters list endpoint](https://developers.smartrecruiters.com/reference/v1listpostings)
  and [detail endpoints](https://developers.smartrecruiters.com/docs/endpoints): list/detail
  split, company identifier and pagination. Restrict discovery to public postings;
  internal-posting access is outside this application.

These APIs generally require a board/company identifier; they are not a universal
company directory. The operator supplies company career URLs/slugs, with a validation
preview resolving each to its adapter. Keep optional company-list import simple.

## JobSpy

The upstream [JobSpy README](https://github.com/speedyapply/JobSpy) lists LinkedIn,
Indeed, Glassdoor, Google and ZipRecruiter among supported sources. It is a Python
scraper (`python-jobspy`, Python 3.10+), not an auto-application library. Its source
filters differ: for example, some Indeed filter groups cannot be combined, and Google
uses its dedicated search string. Do not advertise a common filter as remotely enforced
when it must instead be applied after collection. Pin the tested version and preserve
its original output/schema with normalized results.

Proposed integration: an optional jobs-only virtual environment and short-lived worker
process, taking a versioned JSON request and returning JSONL results/status. Track its
PID/identity, deadline, exit and stderr like other owned workers. Keep stdout a data
channel, capture diagnostics separately, validate output and kill/reconcile timed-out
owned children. Switchboard must not acquire Python dependencies. Fixture worker tests
cover malformed output, partial success, absent Python/package and timeouts. Checkpoint
completed records before retrying; no duplicate jobs when the worker exits midway.

Supported by a scraper is not the same as permitted by the website. LinkedIn explicitly
restricts third-party scraping/automation; Indeed restricts automated site use and
Indeed Apply outside its authorized tooling. Therefore default those JobSpy connectors
to disabled/manual import unless an applicable authorized route is established. This
follows the operator's stated policy rather than treating CAPTCHA as the only boundary.
[LinkedIn policy](https://www.linkedin.com/help/linkedin/answer/a1341387),
[Indeed terms](https://www.indeed.com/legal).

For Glassdoor, Google and ZipRecruiter, a library support claim does not settle the
permitted use. Enabling each requires a recorded review of that target's current terms
and supported access path, plus a low-volume discovery smoke test when permitted.
No proxy rotation, CAPTCHA-solving or anti-bot workaround is planned. A blocked source
becomes a visible source error/manual intake route without stopping other adapters.

## Company/source registry and effective settings

Store the live configuration in SQLite with revisioned JSON import/export. Edit it from
the Jobs settings page; avoid separately mutable JSON and DB copies competing for truth.
Suggested import shape (illustrative, not a shipped API):

```json
{
  "schemaVersion": 1,
  "sources": [
    {
      "id": "example-greenhouse",
      "companyName": "Example",
      "adapter": "greenhouse",
      "boardId": "replace-with-real-board-token",
      "enabled": false,
      "filters": { "keywords": ["software"], "locations": [], "remote": null },
      "schedule": { "intervalMinutes": 360 },
      "requests": { "concurrency": 1, "maxRetries": 2 },
      "actions": {
        "discover": false,
        "capture": false,
        "fill": false,
        "upload": false,
        "submit": false
      },
      "termsReview": { "url": null, "reviewedAt": null, "notes": "Not reviewed" }
    }
  ]
}
```

Configured actions are ceilings, not permissions granted by a website. Effective
behavior is the intersection of supported capability, recorded target restrictions,
operator settings and current stage approvals. Company-specific restrictions can
narrow an adapter's defaults. UI explains the limiting reason instead of merely
showing a disabled button. Changed policies are rechecked before queued actions run.

Each adapter reports separate `discover`, `fetch`, `capture`, `fill`, `upload`, `submit`
and `reconcile` capabilities, plus version, pagination and rate-limit behavior.
Persist request URL/time, safe response metadata/body, source ID, parser version,
checkpoint, normalized posting and errors. Honor rate limits with bounded backoff;
one inaccessible employer must not stall the queue. Text from JSON is not a screenshot:
render/capture the actual posting through a permitted route before auto-submission.
If only operator capture is possible, accept a manual artifact marked with its provenance.

Acceptance shared across adapters: pagination complete/partial, duplicate/repost,
missing optional data, HTML entities, description changes, closed jobs, redirects,
429/backoff, malformed JSON, permission denied, and effective-policy restriction.
Each adapter commit gets its own fixture set; live tests only establish what was
actually exercised on the configured target, not universal website compatibility.

## Manual handoff and browser access

A handoff is a durable Jobs inbox item, never just an alert. It includes employer/job,
form URL, posting evidence, exact resume files, prepared answers, completed actions,
remaining steps and reason (policy, CAPTCHA, login, unknown field or unsupported form).
If the browser cannot legally/technically fill anything, an empty-form link plus
local resume/answers is a successful handoff. Never claim prefilled state transferred
to a phone just because a URL opens: browser profiles and form state are machine-local.

Initial human browser intervention happens in the dedicated browser on this Linux
machine. From the phone the operator can review/download/open the target form and
complete manually; preserving the Linux browser's live state remotely would require
an explicit later remote-browser feature. Record that limitation in the task. Manual
completion can be acknowledged with a receipt/reference/upload; distinguish it from
adapter-observed submission. Expired state resumes/rebuilds permitted preparation,
not an unverified re-submission.

## Optional phone alerts

Selected initial transport: ntfy HTTP publish to a configured topic; the phone subscribes
in ntfy and a click opens the authenticated Jobs page. Discord webhook is an alternative
transport to an existing Discord channel. ntfy is selected; a topic and phone subscription are not configured yet. Implement
`NotificationTransport` with a factory so a replacement preserves the inbox/workflow
and leaves the ntfy adapter available.
[ntfy publishing](https://docs.ntfy.sh/publish/),
[phone subscription](https://docs.ntfy.sh/subscribe/phone/).

Keep the payload minimal (pending-count/reason category and link), no bearer token,
resume, applicant answers or other full records. The in-app inbox holds all materials.
The UI remains the source of truth; notification delivery is optional and non-blocking.
Test through a local receiver. A service cannot notify after it has crashed; independent
monitoring can be added later and is separate from the mandatory child-recovery tests.
