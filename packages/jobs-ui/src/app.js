const $=id=>document.getElementById(id);
let revision;
let review;
let adapters=[];
let captureAvailable=false;
let libraryState=null;
let connectionEpoch=0;
$('token').value=localStorage.getItem('jobs.token')??'';
const message=text=>{$('message').textContent=text;};
async function request(route,body,method=body?'PUT':'GET'){
 const epoch=connectionEpoch;
 const response=await fetch(route,{method,headers:{Authorization:`Bearer ${$('token').value}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(60000)});
 const value=await response.json();
 if(epoch!==connectionEpoch)throw new Error('Connection changed. Connect again.');
 if(!response.ok)throw new Error([value.error?.message,...(value.error?.fields??[]).map(f=>`${f.path}: ${f.message}`)].filter(Boolean).join('\n'));
 return value;
}
async function load(){
 try{
  const [saved,status]=await Promise.all([request('/api/settings'),request('/api/status')]);
  revision=saved.revision;$('editor').value=JSON.stringify(saved.value,null,2);
  $('revision').textContent=`Revision ${revision} · ${saved.updatedAt}`;
  $('state').textContent=status.scheduler.reason;
  $('details').textContent=JSON.stringify({dataDirectory:status.dataDirectory,bootstrap:status.bootstrap,capabilities:status.capabilities},null,2);
  $('settings').hidden=false;localStorage.setItem('jobs.token',$('token').value);message('Settings loaded.');
  await Promise.all([loadDashboard(),loadSources(),loadLibrary(),loadApplications(),loadSubmissions(),loadPolicies()]);
 }catch(error){message(error.message);}
}
$('connect').addEventListener('submit',event=>{event.preventDefault();void load();});
$('disconnect').onclick=()=>{connectionEpoch++;review=undefined;localStorage.removeItem('jobs.token');$('token').value='';$('settings').hidden=true;$('dashboard').hidden=true;$('record').hidden=true;$('editor').value='';message('Token forgotten.');};
$('reload').onclick=()=>void load();
$('save').onclick=async()=>{
 try{await request('/api/settings',{expectedRevision:revision,value:JSON.parse($('editor').value)});await load();message('Settings saved.');}
 catch(error){message(error.message);}
};
$('export').onclick=()=>{
 try{
  const value=JSON.parse($('editor').value);const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download='job-settings.json';a.click();URL.revokeObjectURL(url);
 }catch(error){message(error.message);}
};
$('import').onchange=async event=>{try{const file=event.target.files[0];if(file){$('editor').value=JSON.stringify(JSON.parse(await file.text()),null,2);message('Imported for review. Save to apply.');}}catch(error){message(error.message);}};
function button(label,action){const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>void action().catch(error=>message(error.message));return b;}
function list(id,rows,label,route){
 const root=$(id);root.replaceChildren();
 if(!rows.length){root.textContent='No records yet.';return;}
 for(const row of rows){const item=document.createElement('p');item.className='record-row';
  item.append(route(row)?button(label(row),()=>showRecord(route(row),row.title??row.id)):document.createTextNode(label(row)));root.append(item);}
}
async function loadDashboard(){
 const [data,status]=await Promise.all([request('/api/dashboard'),request('/api/status')]);
 $('workflow-state').textContent=status.scheduler.reason;
 $('counts').textContent=Object.entries(data.counts).map(([name,count])=>`${count} ${name.replaceAll('_',' ')}`).join(' · ');
 list('attention',data.attention,r=>r.title,r=>`/api/reviews/${encodeURIComponent(r.id)}`);
 list('agents',data.agents,r=>`${r.agent} · ${r.state} · task ${r.task_id} · ${r.model}`,r=>`/api/agents/${encodeURIComponent(r.id)}`);
 list('tasks',data.tasks,r=>`${r.kind} · ${r.state} · attempt ${r.attempt}/${r.max_attempts}`,r=>`/api/tasks/${encodeURIComponent(r.id)}`);
 list('jobs',data.jobs,r=>`${r.title} · ${r.company}`,r=>`/api/jobs/${encodeURIComponent(r.id)}`);
 list('applications',data.applications,r=>r.title,r=>null);
 applicationsList(data.applications??[]);
 fillSelect('prepare-application',(data.applications??[]).map(a=>({value:a.id,label:`${a.title} · ${a.company} · ${a.state}`})));
 list('decisions',data.decisions,r=>`${r.decision} · ${r.subject_type} · ${r.reason??''}`,r=>r.attention_id?`/api/reviews/${encodeURIComponent(r.attention_id)}`:null);
 list('runs',data.searchRuns??[],r=>`${r.source_key} · ${r.adapter_id} · ${r.state}${r.error_json?` · ${JSON.parse(r.error_json).code??''}`:''}`,()=>null);
 screeningList(data.screening??[]);
 fillSelect('render-snapshot',(data.snapshots??[]).map(s=>({value:s.id,label:`${s.company} · ${s.title} · ${s.completeness}`})));
 $('dashboard').hidden=false;
}
function screeningList(rows){
 const root=$('screening');root.replaceChildren();
 if(!rows.length){root.textContent='No screening decisions yet.';return;}
 for(const row of rows){const line=document.createElement('p');line.className='record-row';
  const reasons=(JSON.parse(row.reasons_json??'[]')).map(reason=>reason.code).join(', ');
  const jobId=encodeURIComponent(row.job_id);
  line.append(document.createTextNode(`${row.title} · ${row.company} · ${row.decision} · ${reasons} `));
  line.append(button('Skip',async()=>{const reason=window.prompt('Reason for skipping this posting?');if(!reason)return;await request(`/api/jobs/${jobId}/skip`,{reason},'POST');message('Skipped.');await loadDashboard();}));
  line.append(button('Requeue',async()=>{await request(`/api/jobs/${jobId}/requeue`,{},'POST');message('Requeued.');await loadDashboard();}));
  root.append(line);}
}
function fillSelect(id,options){const select=$(id);const previous=select.value;select.replaceChildren(...options.map(option=>{const element=document.createElement('option');element.value=option.value;element.textContent=option.label;return element;}));if(options.some(option=>option.value===previous))select.value=previous;}
async function loadLibrary(){
 const data=await request('/api/library');libraryState=data;
 const profile=data.profiles[data.profiles.length-1]??null;const template=data.templates[0]??null;
 $('library-summary').textContent=`${data.profiles.length} profile(s), ${data.bullets.length} bullet(s), ${data.templates.length} template(s). Rendering produces structured text; PDF output is not implemented yet.`;
 $('profile-editor').value=profile?JSON.stringify(profile.data,null,2):'';
 $('bullets-editor').value=JSON.stringify(data.bullets.map(b=>({bulletId:b.bulletId,prose:b.prose,tags:b.tags,filters:b.filters,evidence:b.evidence})),null,2);
 $('template-editor').value=template?JSON.stringify(template.data,null,2):'';
 fillSelect('render-profile',data.profiles.map(p=>({value:p.id,label:`${p.profileId} rev ${p.revision}`})));
 fillSelect('render-template',data.templates.map(t=>({value:t.id,label:`${t.templateId} rev ${t.revision}`})));
}
async function loadSources(){
 const data=await request('/api/sources');adapters=data.adapters;
 captureAvailable=data.capture.available;
 $('capture-submit').disabled=!captureAvailable;
 $('capture-availability').textContent=captureAvailable
  ?(data.capture.allowPrivateImport?'Browser capture is available. Private/loopback targets are explicitly permitted for this local fixture.':'Browser capture is available. Private and loopback targets are refused.')
  :'URL capture is unavailable: no browser executable is configured. Use manual text import, which records no screenshot evidence.';
 const select=$('source-adapter');select.replaceChildren(...adapters.map(a=>{const o=document.createElement('option');o.value=a.id;o.textContent=`${a.id} (v${a.version})`;return o;}));
 const root=$('sources');root.replaceChildren();
 if(!data.sources.length){root.textContent='No sources configured.';return;}
 for(const source of data.sources){const row=document.createElement('p');row.className='record-row';
  row.append(document.createTextNode(`${source.sourceKey} · ${source.adapterId} · ${source.enabled?'enabled':'disabled'} · ${source.config.companyName??''} `));
  row.append(button('Discover',async()=>{const run=await request(`/api/sources/${encodeURIComponent(source.id)}/discover`,{}, 'POST');message(`Discovery ${run.complete?'completed':'stopped early'}: ${run.discovered} postings, ${run.created} new.`);await Promise.all([loadDashboard(),loadSources()]);}));
  row.append(button(source.enabled?'Disable':'Enable',async()=>{await request(`/api/sources/${encodeURIComponent(source.id)}`,{adapterId:source.adapterId,sourceKey:source.sourceKey,config:source.config,enabled:!source.enabled});message(source.enabled?'Source disabled.':'Source enabled.');await loadSources();}));
  root.append(row);}
}
async function download(hash){
 const response=await fetch(`/api/artifacts/${hash}`,{headers:{Authorization:`Bearer ${$('token').value}`},signal:AbortSignal.timeout(60000)});
 if(!response.ok)throw new Error('Artifact unavailable or corrupt. No download was produced.');
 const url=URL.createObjectURL(await response.blob());
 const link=document.createElement('a');link.href=url;link.download=hash;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function showRecord(route,title){
 review=undefined;$('decision').hidden=true;message('Loading record…');
 const data=await request(route);review=route.startsWith('/api/reviews/')?data.item:undefined;
 $('record-title').textContent=title;$('record-data').textContent=JSON.stringify(data,null,2);
 $('record-links').replaceChildren();
 const hashes=new Set();
 function links(value){if(!value||typeof value!=='object')return;
  for(const [key,item] of Object.entries(value)){
   if(typeof item==='string'&&key.endsWith('hash')&&/^[a-f0-9]{64}$/.test(item)&&key!=='content_hash')hashes.add(item);
   if(typeof item==='object')links(item);
  }
 }
 links(data);
 for(const hash of hashes)$('record-links').append(button(`Download artifact ${hash.slice(0,12)}`,()=>download(hash)));
 const subject=data.item??data.run;
 if(subject?.task_id)$('record-links').append(button('View task',()=>showRecord(`/api/tasks/${encodeURIComponent(subject.task_id)}`,'Task')));
 if(subject?.run_id)$('record-links').append(button('View saved agent run',()=>showRecord(`/api/agents/${encodeURIComponent(subject.run_id)}`,'Agent run')));
 for(const run of data.runs??[])$('record-links').append(button(`View agent ${run.id}`,()=>showRecord(`/api/agents/${encodeURIComponent(run.id)}`,'Agent run')));
 if(data.application)$('record-links').append(button('View job evidence',()=>showRecord(`/api/jobs/${encodeURIComponent(data.application.job_id)}`,'Job evidence')));
 $('decision').hidden=!review||review.state!=='open';$('reason').value='';$('record').hidden=false;$('record').focus();
 message('Record loaded.');
}
$('decision').onsubmit=async event=>{
 event.preventDefault();if(!review)return;
 const id=review.id;const buttons=[...$('decision').querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
 try{await request(`/api/reviews/${encodeURIComponent(id)}/decision`,{expectedVersion:review.version,expectedSettingsRevision:revision,decision:event.submitter.value,reason:$('reason').value},'POST');
  await loadDashboard();await showRecord(`/api/reviews/${encodeURIComponent(id)}`,'Saved decision');message('Decision recorded. No work was dispatched.');
 }catch(error){message(error.message);}finally{buttons.forEach(b=>b.disabled=false);}
};
$('import-url').onsubmit=async event=>{event.preventDefault();
 try{const result=await request('/api/import/url',{url:$('import-url-value').value,company:$('import-company').value,title:$('import-title').value||undefined},'POST');
  await Promise.all([loadDashboard(),showRecord(`/api/jobs/${encodeURIComponent(result.jobId)}`,'Imported posting')]);
  message(`Captured (${result.completeness}). ${result.warning??'Text and screenshot saved as evidence.'}`);
 }catch(error){message(error.message);}};
$('import-manual').onsubmit=async event=>{event.preventDefault();
 try{const result=await request('/api/import/manual',{url:$('manual-url').value,company:$('manual-company').value,title:$('manual-title').value||undefined,descriptionText:$('manual-text').value},'POST');
  await Promise.all([loadDashboard(),showRecord(`/api/jobs/${encodeURIComponent(result.jobId)}`,'Imported posting')]);
  message(result.warning);
 }catch(error){message(error.message);}};
$('source-form').onsubmit=async event=>{event.preventDefault();
 try{const sourceKey=$('source-key').value;const id=$('source-id').value;const adapterId=$('source-adapter').value;
  const config={sourceKey,companyName:$('source-company').value,boardId:$('source-board').value};
  await request(`/api/sources/${encodeURIComponent(id)}`,{adapterId,sourceKey,config,enabled:$('source-enabled').checked});
  message('Source saved. Discovery runs only when enabled.');await loadSources();
 }catch(error){message(error.message);}};
$('refresh-dashboard').onclick=()=>void Promise.all([loadDashboard(),loadSources(),loadLibrary()]).catch(error=>message(error.message));
$('save-profile').onclick=async()=>{try{await request('/api/library/profile',{profileId:'primary',data:JSON.parse($('profile-editor').value)},'PUT');message('Profile revision saved.');await loadLibrary();}catch(error){message(error.message);}};
$('save-bullets').onclick=async()=>{try{const profile=libraryState?.profiles?.at(-1);if(!profile)throw new Error('Save a profile before bullets.');await request('/api/library/bullets',{profileRevisionId:profile.id,bullets:JSON.parse($('bullets-editor').value)},'PUT');message('Bullet revisions saved.');await loadLibrary();}catch(error){message(error.message);}};
$('save-template').onclick=async()=>{try{await request('/api/library/template',{templateId:'base',data:JSON.parse($('template-editor').value)},'PUT');message('Template revision saved.');await loadLibrary();}catch(error){message(error.message);}};
$('export-library').onclick=async()=>{try{const data=await request('/api/library/export');const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='career-library.json';link.click();URL.revokeObjectURL(url);}catch(error){message(error.message);}};
$('import-library').onchange=async event=>{try{const file=event.target.files[0];if(!file)return;const result=await request('/api/library/import',{payload:JSON.parse(await file.text())},'POST');message(`Imported ${result.profiles} profile(s), ${result.bullets} bullet(s), ${result.templates} template(s) as new revisions.`);await loadLibrary();}catch(error){message(error.message);}};
$('render-form').onsubmit=async event=>{event.preventDefault();
 try{const body={jobSnapshotId:$('render-snapshot').value};if($('render-profile').value)body.profileRevisionId=$('render-profile').value;if($('render-template').value)body.templateRevisionId=$('render-template').value;
  const result=await request('/api/resumes/render',body,'POST');
  $('render-note').textContent=`Resume version ${result.resumeVersionId} (${result.created?'created':'reused'}). ${result.structured.missing.length?`Omissions: ${result.structured.missing.join('; ')}`:'No omissions.'}`;
  $('render-text').textContent=result.text;
  const root=$('render-bullets');root.replaceChildren();
  for(const bullet of result.selectedBullets){const line=document.createElement('p');line.className='record-row';line.textContent=`${bullet.bulletId} · matched: ${bullet.matched.length?bullet.matched.join(', '):'no direct tag match'} · ${bullet.prose}`;root.append(line);}
  message('Resume rendered.');
 }catch(error){message(error.message);}};
$('diagnostics').onclick=async()=>{try{$('diagnostics-data').textContent=JSON.stringify(await request('/api/diagnostics'),null,2);}catch(error){message(error.message);}};
// --- Application preparation and review ------------------------------------------------
let applicationAdapters=[];
function applicationsList(rows){
 const root=$('applications');root.replaceChildren();
 if(!rows.length){root.textContent='No applications yet.';return;}
 for(const row of rows){const line=document.createElement('p');line.className='record-row';
  line.append(document.createTextNode(`${row.title} · ${row.company} · ${row.state}${row.block_reason?` · ${row.block_reason}`:''} `));
  line.append(button('Review package',()=>showPackage(row.id)));
  line.append(button('Raw record',()=>showRecord(`/api/applications/${encodeURIComponent(row.id)}`,'Application')));
  root.append(line);}
}
async function loadApplications(){
 const data=await request('/api/application-adapters');applicationAdapters=data.adapters;
 fillSelect('prepare-adapter',data.adapters.map(a=>({value:a.id,label:`${a.id} (v${a.version})${a.capabilities.prepare?'':' · manual handoff'}`})));
 $('prepare-note').textContent=data.browser.available
  ?'Supervised browser configured; it fills and previews but never submits.'
  :'No browser executable configured: only in-process adapters can prepare.';
}
function artifactButton(label,hash){return button(label,()=>download(hash));}
function sourceLink(text,href){const a=document.createElement('a');a.textContent=text;a.href=href;a.rel='noreferrer noopener';a.target='_blank';return a;}
function jsonBlock(label,value){const box=document.createElement('details');const summary=document.createElement('summary');summary.textContent=label;box.append(summary);
 const pre=document.createElement('pre');pre.textContent=JSON.stringify(value,null,2);box.append(pre);return box;}
async function showPackage(applicationId){
 const pkg=await request(`/api/applications/${encodeURIComponent(applicationId)}/package`);
 const root=$('package');root.replaceChildren();
 const add=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;root.append(el);return el;};
 const application=pkg.application,manifest=pkg.attempt?.manifest??null;
 add('h3',`${pkg.job?.title??'Application'} · ${pkg.job?.company??''} · ${application.state}`);
 if(application.block_reason)add('p','Blocked: '+application.block_reason);

 const evidence=add('details');evidence.open=true;const evidenceSummary=document.createElement('summary');
 evidenceSummary.textContent=`Posting evidence · ${pkg.snapshot?`${pkg.snapshot.completeness} captured ${pkg.snapshot.captured_at}`:'none'}`;evidence.append(evidenceSummary);
 if(pkg.snapshot){
  const link=pkg.job?.original_url??pkg.job?.canonical_url??pkg.snapshot.final_url;
  if(link){const line=document.createElement('p');line.append(sourceLink('Open the original posting',link));evidence.append(line);}
  if(pkg.snapshot.screenshot_hash)evidence.append(artifactButton('Download full-page screenshot',pkg.snapshot.screenshot_hash));
  const text=document.createElement('pre');text.textContent=pkg.snapshot.description_text??'(no text captured)';evidence.append(text);
 } else evidence.append(document.createTextNode('Preparation is blocked until a complete capture exists.'));

 const resume=add('details');const resumeSummary=document.createElement('summary');
 resumeSummary.textContent=`Selected resume · ${pkg.resume?`${pkg.resume.phase} version ${pkg.resume.id}`:'none selected'}`;resume.append(resumeSummary);
 if(pkg.resume){
  resume.append(artifactButton('Download resume text',pkg.resume.text_artifact_hash));
  resume.append(document.createTextNode(pkg.resume.pdf_artifact_hash?' PDF available.':' PDF output is not implemented; preparation uploads the text artifact.'));
  if(pkg.agentRun)resume.append(button(`View agent run (${pkg.agentRun.state})`,()=>showRecord(`/api/agents/${encodeURIComponent(pkg.agentRun.id)}`,'Agent run')));
 } else resume.append(document.createTextNode('Select a resume version before preparing.'));

 if(manifest){
  add('p',`Prepared ${manifest.preparedAt} with ${manifest.adapterId} v${manifest.adapterVersion}. Manifest ${String(manifest.manifestHash).slice(0,12)}…`);
  root.append(jsonBlock('Answer set',manifest.answers??{}));
  const filled=document.createElement('p');filled.textContent=(manifest.filled??[]).length?`Filled: ${(manifest.filled??[]).map(f=>f.field).join(', ')}`:'Filled: no fields';root.append(filled);
  const uploads=document.createElement('p');uploads.textContent=(manifest.uploads??[]).length?`Uploads: ${(manifest.uploads??[]).map(u=>`${u.field} → ${u.filename} (${u.artifactHash.slice(0,12)}…)`).join(', ')}`:'Uploads: none';root.append(uploads);
  root.append(jsonBlock('Form fields seen',manifest.fields??[]));
 } else add('p','No prepared attempt yet. Prepare to create the reviewable manifest.');

 const approval=add('details');approval.open=true;const approvalSummary=document.createElement('summary');
 approvalSummary.textContent=pkg.approval?`Approval · ${pkg.approval.current?'current':'invalidated by later changes'}`:'Approval · none recorded yet';approval.append(approvalSummary);
 if(pkg.changesSinceReview){const changes=document.createElement('p');
  changes.textContent=pkg.changesSinceReview.length?`Changed since review: ${pkg.changesSinceReview.map(c=>c.field).join(', ')}`:'Nothing changed since the approved manifest.';approval.append(changes);
  approval.append(jsonBlock('Changes since review',pkg.changesSinceReview));}
 if(pkg.attempt&&pkg.attempt.state==='draft'&&manifest){
  approval.append(button('Approve this exact manifest',async()=>{
   const reason=window.prompt('Reason for approving this prepared submission?');if(!reason)return;
   await request(`/api/attempts/${encodeURIComponent(pkg.attempt.id)}/approve`,{expectedManifestHash:manifest.manifestHash,reason},'POST');
   message('Approved. Nothing was sent; submission is a separate, later decision.');await showPackage(applicationId);await loadDashboard();}));
 } else if(pkg.attempt)approval.append(document.createTextNode(`This attempt is ${pkg.attempt.state}; only a draft can be approved.`));

 if(pkg.handoff){
  const handoff=add('fieldset');const legend=document.createElement('legend');legend.textContent=`Needs you: ${pkg.handoff.code??'handoff'}`;handoff.append(legend);
  handoff.append(document.createTextNode(`Only an operator can resolve this. Form: ${pkg.handoff.formUrl??'(none)'}`));
  if(pkg.handoff.formUrl)handoff.append(sourceLink('Open the form',pkg.handoff.formUrl));
  handoff.append(jsonBlock('Recorded answers',pkg.handoff.answers??{}));
  const answers=document.createElement('textarea');answers.rows=4;answers.spellcheck=false;answers.value=JSON.stringify(pkg.handoff.answers??{},null,2);
  const note=document.createElement('input');note.maxLength=2000;note.placeholder='What did you do (login, CAPTCHA, decision)?';note.required=true;
  handoff.append(document.createTextNode('Answers JSON (merged over the recorded ones)'),answers,document.createTextNode('Resolution note'),note);
  handoff.append(button('Resolve and prepare again',async()=>{
   await request(`/api/applications/${encodeURIComponent(applicationId)}/resolve`,{code:pkg.handoff.code,note:note.value,answers:JSON.parse(answers.value)},'POST');
   message('Handoff resolved; preparation continued on the same application.');await showPackage(applicationId);await loadDashboard();}));
 }

 const manual=add('fieldset');const manualLegend=document.createElement('legend');manualLegend.textContent='Report a manual completion';manual.append(manualLegend);
 manual.append(document.createTextNode('If you applied on the site yourself, record what happened. Nothing is sent by this service; your report is stored as evidence.'));
 const detail=document.createElement('input');detail.maxLength=2000;detail.placeholder='Submitted on the employer site';detail.required=true;
 const receipt=document.createElement('textarea');receipt.rows=3;receipt.placeholder='Confirmation text or reference number you were shown (optional)';receipt.maxLength=200000;
 manual.append(document.createTextNode('What happened'),detail,document.createTextNode('Receipt as shown to you'),receipt);
 manual.append(button('Record manual completion',async()=>{
  await request(`/api/applications/${encodeURIComponent(applicationId)}/manual-completion`,{detail:detail.value,receiptText:receipt.value||undefined},'POST');
  message('Manual completion recorded with the receipt you supplied.');await showPackage(applicationId);await loadDashboard();}));

 root.append(button('Reload package',()=>showPackage(applicationId)));

 // Sending: a separate, gated, external action on this exact manifest.
 const send=add('fieldset');const sendLegend=document.createElement('legend');sendLegend.textContent='Sending';send.append(sendLegend);
 const attemptState=pkg.attempt?pkg.attempt.state:'none';
 send.append(document.createTextNode(`Attempt state: ${attemptState}. ${pkg.approval?`Approval ${pkg.approval.current?'matches this manifest':'belongs to an earlier manifest'}.`:'No approval recorded.'}`));
 if(pkg.attempt){
  if(pkg.attempt.send_started_at)send.append(document.createTextNode(` Send started ${pkg.attempt.send_started_at}.`));
  if(pkg.attempt.outcome_json){const outcome=JSON.parse(pkg.attempt.outcome_json);
   send.append(document.createTextNode(` Recorded outcome: ${outcome.outcome}${outcome.externalId?` (${outcome.externalId})`:''}${outcome.observedBy===`operator`?` — reported by the operator, not observed by the service`:''}.`));}
  if(pkg.attempt.receipt_hash)send.append(artifactButton('Download the confirmation evidence',pkg.attempt.receipt_hash));
  if(attemptState==='approved'){
   send.append(button('Send this application now (external action)',async()=>{
    if(!window.confirm('Send this exact prepared application to the employer site now?'))return;
    const result=await request(`/api/attempts/${encodeURIComponent(pkg.attempt.id)}/submit`,{},'POST');
    message(result.blocked?`Not sent: ${result.blocked.code} — ${result.blocked.detail}`
     :result.state==='submitted'?`Sent and confirmed${result.externalId?` (${result.externalId})`:''}.`
     :result.state==='rejected'?'The site rejected this application; nothing else was sent.'
     :'The send could not be confirmed. Reconcile it below before another attempt.');
    await showPackage(applicationId);await Promise.all([loadDashboard(),loadSubmissions()]);}));
  } else if(attemptState==='unknown')send.append(document.createTextNode(' This send is unconfirmed. Record what you found under Submissions; nothing is retried automatically.'));
  else if(attemptState==='draft')send.append(document.createTextNode(' Approve this exact manifest above before it can be sent.'));
 }
 message('Review package loaded.');
}
async function loadSubmissions(){
 const data=await request('/api/submissions');const root=$('submissions');root.replaceChildren();
 if(!data.submissions.length){root.textContent='Nothing has been sent yet.';return;}
 for(const row of data.submissions){const box=document.createElement('fieldset');const legend=document.createElement('legend');
  let outcome={};try{outcome=JSON.parse(row.outcome_json??'{}');}catch{}
  legend.textContent=`${row.company} · ${row.title} · ${row.state}`;box.append(legend);
  const line=document.createElement('p');line.textContent=`${row.adapter_id} · started ${row.send_started_at??'—'}${row.finished_at?` · finished ${row.finished_at}`:''}${outcome.externalId?` · reference ${outcome.externalId}`:''}${outcome.observedBy===`operator`?' · operator-reported':''}`;box.append(line);
  if(row.receipt_hash)box.append(artifactButton('Download confirmation evidence',row.receipt_hash));
  if(row.state==='unknown'){
   const note=document.createElement('p');note.textContent='Confirm the real outcome from the site or your email. This is recorded as your report, not as something the service observed.';box.append(note);
   const detail=document.createElement('input');detail.placeholder='What did you find?';detail.maxLength=2000;
   const reference=document.createElement('input');reference.placeholder='External reference (optional)';reference.maxLength=200;
   const receipt=document.createElement('textarea');receipt.rows=3;receipt.placeholder='Confirmation text you were shown (optional)';receipt.maxLength=200000;
   box.append(document.createTextNode('What you found'),detail,document.createTextNode('Reference'),reference,document.createTextNode('Receipt text'),receipt);
   const actions=document.createElement('div');actions.className='actions';
   for(const outcome of ['submitted','rejected'])actions.append(button(`Record as ${outcome}`,async()=>{
    await request(`/api/attempts/${encodeURIComponent(row.id)}/reconcile`,{outcome,detail:detail.value||`Operator reported ${outcome}`,externalId:reference.value||null,receiptText:receipt.value||undefined},'POST');
    message('Reconciliation recorded. Nothing was resent.');await Promise.all([loadSubmissions(),loadDashboard()]);}));
   box.append(actions);
  }
  root.append(box);}
}
async function loadPolicies(){
 const data=await request('/api/policies');const root=$('policies');root.replaceChildren();
 const latest=new Map();for(const policy of data.policies)if(!latest.has(policy.scopeKey))latest.set(policy.scopeKey,policy);
 if(!latest.size){root.textContent='No site policies yet. Preparing an application creates the first revision.';return;}
 for(const policy of [...latest.values()]){const box=document.createElement('fieldset');const legend=document.createElement('legend');
  legend.textContent=`${policy.scopeKey} · revision ${policy.revision}`;box.append(legend);
  box.append(document.createTextNode(`submission ${policy.capabilities.submit?'permitted':'forbidden'} · automatic ${policy.restrictions.autoSubmit?'enabled':'off'}${policy.restrictions.maxPerDay!==undefined?` · max ${policy.restrictions.maxPerDay}/day`:''}`));
  const actions=document.createElement('div');actions.className='actions';
  const revise=async(patch,caps,restrictions)=>{
   const capabilities={...policy.capabilities,...caps||{}};const merged={...policy.restrictions,...restrictions||{}};delete merged.notes;
   await request('/api/policies',{adapterId:policy.adapterId,siteUrl:policy.siteUrl??'',capabilities,restrictions:merged},'PUT');
   message(`Policy revision recorded: submission ${capabilities.submit?'permitted':'forbidden'}.`);await loadPolicies();};
  actions.append(button(policy.capabilities.submit?'Forbid submission':'Permit submission',()=>revise({},policy.capabilities.submit?{submit:false}:{submit:true},policy.capabilities.submit?{autoSubmit:false}:{})));
  if(policy.capabilities.submit)actions.append(button(policy.restrictions.autoSubmit?'Disable automatic sending':'Allow automatic sending',()=>revise({},{},{autoSubmit:!policy.restrictions.autoSubmit})));
  box.append(actions);root.append(box);}
}
$('prepare-form').onsubmit=async event=>{event.preventDefault();
 const applicationId=$('prepare-application').value;if(!applicationId){message('Choose an application first.');return;}
 const submit=$('prepare-submit');submit.disabled=true;
 try{
  const outcome=await request(`/api/applications/${encodeURIComponent(applicationId)}/prepare`,{adapterId:$('prepare-adapter').value,formUrl:$('prepare-url').value,answers:JSON.parse($('prepare-answers').value||'{}')},'POST');
  message(outcome.state==='draft'?`Prepared and ready for review (attempt ${String(outcome.attemptId).slice(0,8)}).`:`${outcome.state}: ${outcome.code} — ${outcome.detail}`);
  await showPackage(applicationId);await loadDashboard();
 }catch(error){message(error.message);}finally{submit.disabled=false;}};
if($('token').value)void load();
