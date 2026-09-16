const $=id=>document.getElementById(id);
let revision;
$('token').value=localStorage.getItem('jobs.token')??'';
const message=text=>{$('message').textContent=text;};
async function request(route,body){
 const response=await fetch(route,{method:body?'PUT':'GET',headers:{Authorization:`Bearer ${$('token').value}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 const value=await response.json();
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
 }catch(error){message(error.message);}
}
$('connect').addEventListener('submit',event=>{event.preventDefault();void load();});
$('disconnect').onclick=()=>{localStorage.removeItem('jobs.token');$('token').value='';$('settings').hidden=true;$('editor').value='';message('Token forgotten.');};
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
if($('token').value)void load();
