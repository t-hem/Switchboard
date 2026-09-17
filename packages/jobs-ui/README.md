# Jobs client

An independently buildable static dashboard and settings editor served by the jobs service.
`npm --prefix packages/jobs-ui run build` copies its assets into dist. It imports no
Switchboard code and has no runtime build dependency on the daemon. It shows durable
attention items, grouped child agents, task/job/application details and review history.
Approve/deny/request-changes records a version-checked decision without starting work.
All current workflow settings are editable via the structured JSON editor. The token
stays in this client's local storage, never a URL. Applicant records are fetched from
the service and are not persisted in browser storage. Downloads use authentication
headers and inert blob URLs; server-supplied strings render as text, never HTML.

Step 5 adds posting import (URL capture plus manual text) and source management: the
enabled/disabled state, per-source Discover action and recent discovery runs. Capture
controls are disabled with the service's stated reason when no browser is configured.
Importing records evidence only; it never starts an agent or submits an application.

Step 6 adds the career library and resume preview: JSON editors for the profile,
bullet library and base template (saved as new immutable revisions), library
export/import, and a render form that shows the rendered text, its visible omissions
and each selected bullet's matched tags. PDF output is not implemented yet.

Steps 8–12 add candidate screening with skip/requeue reasons, **Application preparation**
(a prepare form plus a review package showing the posting text, screenshot, source link,
selected resume with its agent run, the answer set, filled fields and uploads, and what
changed since the last review), resume selection for an application, manifest approval,
handoff resolution, an explicit external-action Send control, a **Submissions** list with
reconciliation for unconfirmed sends, and **Site policies** controls that record
permit/forbid and automatic-sending revisions. Nothing is sent without an operator action
while the review gates are on.
