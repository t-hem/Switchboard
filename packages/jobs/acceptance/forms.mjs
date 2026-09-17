// Step 9 acceptance: a real supervised browser prepares a real fixture form.
// The fixture server must see the correct form fields and the exact uploaded resume hash,
// and must record zero submissions. Disposable state; loopback fixture only.
// Build first, then run: npm run jobs:build && JOBS_BROWSER_EXECUTABLE=<chrome> node packages/jobs/acceptance/forms.mjs
// It imports the built dist, exactly as the service runs in production.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const chrome = process.env.JOBS_BROWSER_EXECUTABLE;
if (!chrome) { console.log('SKIP: set JOBS_BROWSER_EXECUTABLE to run the browser form acceptance'); process.exit(0); }
const { SupervisedBrowser, browserPaths, readOwnership } = await import('../dist/browser.js');
const { PuppeteerFormSession } = await import('../dist/form.js');
const { SettingsStore } = await import('../dist/store.js');
const { ArtifactStore } = await import('../dist/artifacts.js');
const { Postings } = await import('../dist/postings.js');
const { Library } = await import('../dist/library.js');
const { PreparationService } = await import('../dist/preparation.js');
const { FetchHttpClient } = await import('../dist/net.js');

const sha256 = value => createHash('sha256').update(value).digest('hex');
const now = () => Date.now();
const resumeText = 'Ada Lovelace\nEngineer\n- Shipped fixtures\n';

// --- Fixture form site -------------------------------------------------------------------
const formPage = (action, extra = '') => `<!doctype html><html><body><h1>Apply</h1>
<form id="apply">
  <label for="name">Full name</label><input id="name" name="name" required>
  <label for="email">Email</label><input id="email" name="email" type="email" required>
  <label for="workAuth">Work authorization</label>
  <select id="workAuth" name="workAuth" required><option value="">Select</option><option value="yes">Yes</option><option value="no">No</option></select>
  <label for="coverLetter">Cover letter</label><textarea id="coverLetter" name="coverLetter"></textarea>
  <label for="resume">Resume</label><input id="resume" name="resume" type="file" required accept=".pdf,.txt">
  <button type="button" data-apply-action="preview">Review application</button>
  <button type="button" data-apply-action="submit">Submit application</button>
</form>${extra}
<script>
const hex = buffer => Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
document.title = ${JSON.stringify(action)};
document.querySelector("[data-apply-action='preview']").addEventListener('click', async () => {
  const form = document.getElementById('apply');
  const fields = {};
  for (const [key, value] of new FormData(form)) if (typeof value === 'string') fields[key] = value;
  const file = form.querySelector("input[type=file]").files[0] ?? null;
  const payload = { fields, file: file ? { name: file.name, size: file.size, sha256: hex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())) } : null };
  const response = await fetch('/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  document.body.insertAdjacentHTML('beforeend', '<p id="prepared">' + (await response.text()) + '</p>');
});
document.querySelector("[data-apply-action='submit']").addEventListener('click', async () => {
  await fetch('/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
});
</script></body></html>`;

const record = { requests: [], prepareCalls: 0, submissions: 0, fields: null, file: null };
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  record.requests.push(`${request.method} ${url.pathname}`);
  if (request.method === 'GET' && url.pathname === '/apply') { response.writeHead(200, { 'Content-Type': 'text/html' }); return response.end(formPage('apply')); }
  if (request.method === 'GET' && url.pathname === '/apply-captcha') { response.writeHead(200, { 'Content-Type': 'text/html' }); return response.end(formPage('captcha', '<div data-apply-captcha></div>')); }
  if (request.method === 'GET' && url.pathname === '/apply-forbidden') { response.writeHead(200, { 'Content-Type': 'text/html' }); return response.end(formPage('forbidden', '<div data-apply-automation-forbidden></div>')); }
  if (request.method === 'GET' && url.pathname === '/empty') { response.writeHead(200, { 'Content-Type': 'text/html' }); return response.end('<html><body><h1>Apply by email</h1><p>Send your resume to jobs@example.test</p></body></html>'); }
  if (request.method === 'GET' && url.pathname === '/__record') { response.writeHead(200, { 'Content-Type': 'application/json' }); return response.end(JSON.stringify(record)); }
  if (request.method === 'POST' && url.pathname === '/prepare') {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    return request.on('end', () => {
      const payload = JSON.parse(body);
      record.prepareCalls++; record.fields = payload.fields; record.file = payload.file;
      response.writeHead(200, { 'Content-Type': 'text/plain' }); response.end('Preview recorded');
    });
  }
  if (request.method === 'POST' && url.pathname === '/submit') { record.submissions++; response.writeHead(200); return response.end('submitted'); }
  response.writeHead(404); response.end('not found');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// --- Disposable jobs state ---------------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-forms-'));
const store = new SettingsStore(path.join(dir, 'jobs.sqlite'));
const artifacts = new ArtifactStore(store.db, dir);
const postings = new Postings(store.db, artifacts, now);
const library = new Library(store.db, now);
const { jobId } = postings.ingest({ adapterId: 'fixture', company: 'Acme', title: 'Engineer', originalUrl: 'https://acme.example/1', descriptionText: 'Body', provenance: 'browser' });
const snapshotId = postings.recordSnapshot({ jobId, purpose: 'discovery', fetchedUrl: 'u', finalUrl: 'u', descriptionText: 'Body',
  screenshot: Buffer.from('png'), captureVersion: 'browser:1', capture: {}, completeness: 'complete' }).snapshotId;
const profile = library.addProfile({ profileId: 'primary', data: { contact: { name: 'Ada' }, facts: [], suggestions: [] } });
const template = library.addTemplate({ templateId: 'base', data: { name: 'Base', sections: [{ id: 'summary', title: 'Summary', type: 'facts', factKeys: ['summary'], optional: true }] } });
const resumeHash = artifacts.put(Buffer.from(resumeText, 'utf8'), 'text/plain', 'resume-text').hash;
const resumeId = 'resume-1';
store.db.prepare(`INSERT INTO resume_versions(id,job_snapshot_id,profile_revision_id,template_revision_id,parent_resume_id,agent_run_id,phase,source_json,selected_bullets_json,edits_json,text_artifact_hash,pdf_artifact_hash,created_at)
  VALUES(?,?,?,?,NULL,NULL,'render','{}','[]','{}',?,NULL,?)`).run(resumeId, snapshotId, profile.id, template.id, resumeHash, new Date().toISOString());
const applicationId = String(store.db.prepare('SELECT id FROM applications WHERE job_id=?').get(jobId).id);
store.db.prepare('UPDATE applications SET selected_resume_id=? WHERE id=?').run(resumeId, applicationId);

// --- Supervised browser ------------------------------------------------------------------
const paths = browserPaths(dir);
const browser = new SupervisedBrowser({ executablePath: chrome, ...paths });
const preparation = new PreparationService({ store, db: store.db, artifacts, http: new FetchHttpClient({ allowPrivate: true }), now,
  createSession: () => new PuppeteerFormSession(browser) });
const answers = { name: 'Ada Lovelace', email: 'ada@example.test', workAuth: 'yes', coverLetter: 'Hello' };
const run = (extra = {}) => ({ applicationId, adapterId: 'fixture-form', formUrl: `${origin}/apply`, answers, settingsRevision: 1, allowPrivate: true, ...extra });

try {
  // A real browser fills the real form; the server sees the exact fields and file hash.
  const first = await preparation.prepare(run());
  assert.equal(first.state, 'draft', first.detail);
  assert.ok(readOwnership(paths.ownershipFile), 'browser ownership is recorded while it runs');
  let seen = await (await fetch(`${origin}/__record`)).json();
  assert.equal(seen.prepareCalls, 1, 'the site saw exactly one prepared form');
  assert.equal(seen.submissions, 0, 'nothing was submitted');
  assert.equal(seen.fields.name, 'Ada Lovelace');
  assert.equal(seen.fields.workAuth, 'yes');
  assert.equal(seen.fields.coverLetter, 'Hello');
  assert.equal(seen.file.name, `resume-${applicationId.slice(0, 8)}.txt`, 'the site sees a meaningful filename, not a digest');
  assert.equal(seen.file.sha256, resumeHash, 'the server saw the exact resume bytes');
  assert.equal(seen.file.size, Buffer.byteLength(resumeText));
  const manifest = first.manifest;
  assert.equal(manifest.uploads[0].artifactHash, resumeHash);
  assert.equal(manifest.snapshotId, snapshotId);
  assert.equal(manifest.resumeVersionId, resumeId);

  // Repeating the same preparation is idempotent: no second fill, no second site contact.
  const again = await preparation.prepare(run());
  assert.equal(again.created, false);
  seen = await (await fetch(`${origin}/__record`)).json();
  assert.equal(seen.prepareCalls, 1, 'an identical preparation never re-contacts the site');

  // Changed answers create a new attempt (a prior review cannot silently carry over).
  const changed = await preparation.prepare(run({ answers: { ...answers, workAuth: 'no' } }));
  assert.equal(changed.created, true);
  assert.notEqual(changed.attemptId, first.attemptId);
  seen = await (await fetch(`${origin}/__record`)).json();
  assert.equal(seen.fields.workAuth, 'no');

  // A CAPTCHA and a forbidden-automation page become inbox handoffs with no prohibited request.
  const before = (await (await fetch(`${origin}/__record`)).json()).requests.length;
  const captcha = await preparation.prepare(run({ formUrl: `${origin}/apply-captcha` }));
  assert.equal(captcha.code, 'captcha');
  const forbidden = await preparation.prepare(run({ formUrl: `${origin}/apply-forbidden` }));
  assert.equal(forbidden.code, 'forbidden_automation');
  const after = await (await fetch(`${origin}/__record`)).json();
  assert.equal(after.prepareCalls, 2, 'a blocked form is never filled or previewed');
  assert.equal(after.submissions, 0);
  assert.ok(!after.requests.slice(before).some(entry => entry.includes('/prepare') || entry.includes('/submit')), 'no further requests beyond loading the page');
  for (const code of ['captcha', 'forbidden_automation']) {
    const item = store.db.prepare("SELECT * FROM attention_items WHERE subject_type='application-handoff' AND title LIKE ? ORDER BY created_at DESC LIMIT 1").get(`%${code}%`);
    assert.ok(item, `${code} produced an inbox handoff`);
    const context = JSON.parse(String(item.context_json));
    assert.ok(context.formUrl && context.answers && context.resumeVersionId, `${code} handoff carries URL, answers and resume`);
  }

  // A page with no form at all is a valid completed handoff for manual completion.
  const empty = await preparation.prepare(run({ formUrl: `${origin}/empty` }));
  assert.equal(empty.state, 'draft', `an empty form is still a reviewable outcome: ${empty.detail}`);

  // Crash recovery: a second supervisor reaps the browser the first one left behind.
  const pid = readOwnership(paths.ownershipFile).pid;
  const recovery = new SupervisedBrowser({ executablePath: chrome, ...paths });
  assert.equal(await recovery.reapStale(), 'killed', 'the orphaned owned browser is reaped');
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'no unmanaged Chromium child is left running');
  assert.equal(readOwnership(paths.ownershipFile), null, 'the ownership record is cleared');

  console.log('forms acceptance: ALL PASS');
} finally {
  await browser.close().catch(() => undefined);
  server.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
