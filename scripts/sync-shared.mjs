import {copyFile,mkdir} from 'node:fs/promises';
for(const name of ['lifecycle.mjs','contracts.mjs','read-policy.mjs']){await mkdir(new URL('../deepseek/lib/',import.meta.url),{recursive:true});await copyFile(new URL('../shared/'+name,import.meta.url),new URL('../deepseek/lib/'+name,import.meta.url));}
console.log('Shared runtime copied into self-contained DeepSeek package');

await mkdir(new URL('../codex/lib/',import.meta.url),{recursive:true});await copyFile(new URL('../shared/read-policy.mjs',import.meta.url),new URL('../codex/lib/read-policy.mjs',import.meta.url));
