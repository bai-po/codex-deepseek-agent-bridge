import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export async function verify(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const results = [];
  const dsh = JSON.parse(await readFile(path.join(root,'deepseek/package.json'),'utf8'));
  const iconPath = path.resolve(root,'deepseek',dsh.exports['./icon']);
  if (path.relative(path.join(root,'deepseek'),iconPath).startsWith('..')) throw new Error('icon path escapes plugin');
  const icon = await readFile(iconPath);
  if (icon.length > 256 * 1024) throw new Error('DSH icon exceeds 256 KiB limit');
  results.push('DSH icon <= 256 KiB');
  for (const file of ['codex/.codex-plugin/plugin.json','codex/.mcp.json','deepseek/package.json','.agents/plugins/marketplace.json']) {
    const value = JSON.parse(await readFile(path.join(root,file),'utf8'));
    if (/plugin\.json$/.test(file) || file === 'deepseek/package.json') {
      if (value.version !== pkg.version) throw new Error(`${file}: version mismatch`);
    }
    results.push(file);
  }
  for (const file of ['codex/server.mjs','deepseek/index.js','codex/MANUAL.md','deepseek/MANUAL.md','docs/INSTALL.md','LICENSE']) {
    await access(path.join(root,file)); results.push(file);
  }
  for (const file of ['lifecycle.mjs','contracts.mjs']) {
    const source = await readFile(path.join(root,'shared',file));
    const packaged = await readFile(path.join(root,'deepseek/lib',file));
    if (!source.equals(packaged)) throw new Error(file + ': shared/deepseek runtime byte mismatch');
    results.push('shared/' + file + ' == deepseek/lib/' + file);
  }
  return { version: pkg.version, checked: results, scope: '静态文件与版本检查；不证明宿主加载、消息投递或功能验收' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verify(process.argv[2]).then(result => console.log(JSON.stringify(result,null,2))).catch(error => { console.error(error.message); process.exitCode=1; });
}
