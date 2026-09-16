import { useState } from "react";

export function JobsConnection({url, status, onSave}: {
  url:string; status:string; onSave:(value:string)=>void;
}) {
  const [value,setValue] = useState(url);
  const [message,setMessage] = useState("");
  return <section>
    <h3 className="mb-2 text-xs uppercase tracking-wide text-neutral-500">Optional Jobs app</h3>
    <p className="mb-2 text-xs text-neutral-400">Connect a separately running Jobs service. Enter its token in the Jobs app; it is never included in navigation links.</p>
    <form onSubmit={event => {
      event.preventDefault();
      try { onSave(value); setMessage("Connection saved."); }
      catch(error) { setMessage(error instanceof Error ? error.message : String(error)); }
    }}>
      <label className="block text-xs">Jobs service URL
        <input type="url" value={value} onChange={event=>setValue(event.target.value)} placeholder="https://jobs.example.ts.net"
          className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm" />
      </label>
      <button className="mt-2 rounded border border-neutral-700 px-2 py-1 text-xs">Save Jobs connection</button>
      <button type="button" className="ml-2 text-xs" onClick={()=>{onSave("");setValue("");setMessage("Jobs connection removed.");}}>Remove connection</button>
    </form>
    <p role="status" className="mt-2 text-xs text-neutral-400">{message} {url ? `Jobs ${status}.` : "Not configured."}</p>
    {url && <a className="text-xs text-blue-300" href={url} target="_blank" rel="noopener noreferrer">Open Jobs app</a>}
  </section>;
}
