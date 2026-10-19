import {copyFile,mkdir} from 'node:fs/promises';
for(const name of ['lifecycle.mjs','contracts.mjs']){await mkdir(new URL('../deepseek/lib/',import.meta.url),{recursive:true});await copyFile(new URL('../shared/'+name,import.meta.url),new URL('../deepseek/lib/'+name,import.meta.url));}
console.log('Shared runtime copied into self-contained DeepSeek package');
