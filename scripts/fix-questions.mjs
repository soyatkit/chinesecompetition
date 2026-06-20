// 一次過 fix 晒題庫問題
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'questions');

// === Fix genQ-p4.json ===
let p4 = JSON.parse(readFileSync(path.join(dir, 'genQ-p4.json'), 'utf-8'));
let changes = 0;

p4.forEach((q) => {
  // 誠實反義: 顛倒→謊話
  if (q.text === '「誠實」的反義詞是甚麼？' && q.options[1] === '顛倒') {
    q.options[1] = '謊話'; changes++;
  }
  // 勇敢反義: 顛倒→懦弱
  if (q.text === '「勇敢」的反義詞是甚麼？' && q.options[2] === '顛倒') {
    q.options[2] = '懦弱'; changes++;
  }
  // 專心近義: 專心→投入
  if (q.text === '「專心」的近義詞是甚麼？' && q.options[2] === '專心') {
    q.options[2] = '投入'; changes++;
  }
  // 高興近義: 改選項（避免全部合理）
  if (q.text === '「高興」的近義詞是甚麼？' && q.options.includes('興奮')) {
    q.options = ['愉快', '悲傷', '生氣', '難過'];
    q.answer = 0; changes++;
  }
});
writeFileSync(path.join(dir, 'genQ-p4.json'), JSON.stringify(p4, null, 2), 'utf-8');
console.log(`✅ genQ-p4.json: ${changes} fixes`);

// === Fix genQ-p5.json ===
let p5 = JSON.parse(readFileSync(path.join(dir, 'genQ-p5.json'), 'utf-8'));
changes = 0;

p5.forEach((q) => {
  // 節省反義: 節省→節約
  if (q.text === '「節省」的反義詞是甚麼？' && q.options[2] === '節省') {
    q.options[2] = '節約'; changes++;
  }
  // 清楚近義: 清楚→清晰
  if (q.text === '「清楚」的近義詞是甚麼？' && q.options[0] === '清楚') {
    q.options[0] = '清晰'; changes++;
  }
  // 迅速近義: 迅速→快速
  if (q.text === '「迅速」的近義詞是甚麼？' && q.options[0] === '迅速') {
    q.options[0] = '快速'; changes++;
  }
});
writeFileSync(path.join(dir, 'genQ-p5.json'), JSON.stringify(p5, null, 2), 'utf-8');
console.log(`✅ genQ-p5.json: ${changes} fixes`);

console.log('\n🎉 全部 fix 完成！');
