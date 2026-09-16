import { SettingsStore } from '../../src/store.js';
import { ArtifactStore } from '../../src/artifacts.js';
import { TaskQueue } from '../../src/queue.js';
const [mode, file, root, boundary] = process.argv.slice(2) as [string,string,string,string];
const store = new SettingsStore(file);
if (mode === 'transaction') {
  store.db.exec('BEGIN IMMEDIATE');
  new ArtifactStore(store.db, root).put(Buffer.from('transaction evidence'), 'text/plain', 'test');
  if (boundary === 'committed') store.db.exec('COMMIT');
  process.kill(process.pid, 'SIGKILL');
} else if (mode === 'crash') {
  new ArtifactStore(store.db, root).put(Buffer.from('crash evidence'), 'text/plain', 'test', stage => {
    if (stage === boundary) process.kill(process.pid, 'SIGKILL');
  });
} else {
  const queue = new TaskQueue(store.db);
  const owner = queue.acquireScheduler(root, 30000);
  console.log(JSON.stringify({ acquired: !!owner, task: owner ? queue.claim(owner)?.task.id : null }));
}
store.close();
