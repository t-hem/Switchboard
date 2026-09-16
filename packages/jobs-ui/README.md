# Jobs client

An independently buildable static settings editor served by the jobs service.
`npm --prefix packages/jobs-ui run build` copies its assets into dist. It imports no
Switchboard code and has no runtime build dependency on the daemon. Step 4 expands
this into the job dashboard; all scaffold workflow settings are already editable via
the structured editor. The token stays in this client's local storage, never an URL.
