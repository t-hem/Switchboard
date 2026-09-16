import fs from 'node:fs';
fs.mkdirSync(new URL('./dist/', import.meta.url), {recursive:true});
fs.cpSync(new URL('./src/', import.meta.url), new URL('./dist/', import.meta.url), {recursive:true});
