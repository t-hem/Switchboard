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
