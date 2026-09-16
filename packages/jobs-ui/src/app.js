const $=id=>document.getElementById(id);
let revision;
let review;
let connectionEpoch=0;
$('token').value=localStorage.getItem('jobs.token')??'';
const message=text=>{$('message').textContent=text;};
async function request(route,body,method=body?'PUT':'GET'){
 const epoch=connectionEpoch;
 const response=await fetch(route,{method,headers:{Authorization:`Bearer ${$('token').value}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
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
  await loadDashboard();
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
 list('applications',data.applications,r=>`${r.title} · ${r.company} · ${r.state}${r.block_reason?` · ${r.block_reason}`:''}`,r=>`/api/applications/${encodeURIComponent(r.id)}`);
 list('decisions',data.decisions,r=>`${r.decision} · ${r.subject_type} · ${r.reason??''}`,r=>r.attention_id?`/api/reviews/${encodeURIComponent(r.attention_id)}`:null);
 $('dashboard').hidden=false;
}
async function download(hash){
 const response=await fetch(`/api/artifacts/${hash}`,{headers:{Authorization:`Bearer ${$('token').value}`},signal:AbortSignal.timeout(15000)});
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
$('refresh-dashboard').onclick=()=>void loadDashboard().catch(error=>message(error.message));
$('diagnostics').onclick=async()=>{try{$('diagnostics-data').textContent=JSON.stringify(await request('/api/diagnostics'),null,2);}catch(error){message(error.message);}};
if($('token').value)void load();
