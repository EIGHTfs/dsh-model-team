// 统计"代码行"：跳过空行、纯 // 注释行、纯 /* */ 块注释行（含 JSDoc 的 * 行）
import { readFileSync } from 'node:fs';
const files = process.argv.slice(2);
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  let inBlock = false, code = 0, comment = 0, blank = 0;
  for (const line of lines) {
    const t = line.trim();
    if (inBlock) { comment++; if (t.includes('*/')) inBlock = false; continue; }
    if (t === '') { blank++; continue; }
    if (t.startsWith('//')) { comment++; continue; }
    if (t.startsWith('/*')) { comment++; if (!t.includes('*/')) inBlock = true; continue; }
    if (t.startsWith('*')) { comment++; continue; }
    code++;
  }
  console.log(`${code}\t${file}\t(注释 ${comment} / 空行 ${blank} / 物理 ${lines.length})`);
}
