/**
 * 修正 Round 1「唐詩理解」題目中的無效選項
 * 
 * 問題：選項包含「無從得知」「各詩不同」「以上皆是」
 * 修正：替換為其他真實詩句作為干擾項
 */

const fs = require('fs');
const path = __dirname;

const files = ['genQ-p4.json', 'genQ-p5.json', 'genQ-p6.json'];

// 1. 從所有檔案的唐詩理解題中建立真實詩句池
const poetryLines = new Set();
const allQuestions = {};

for (const f of files) {
  const qs = JSON.parse(fs.readFileSync(path + '/' + f, 'utf-8'));
  allQuestions[f] = qs;
  for (const q of qs) {
    if (q.category !== '唐詩理解') continue;
    const correct = q.options[q.answer];
    // 只收真實詩句（不含「無從得知」「各詩不同」「以上皆是」）
    if (correct && correct.length >= 4 && !['無從得知', '各詩不同', '以上皆是'].includes(correct)) {
      poetryLines.add(correct);
    }
  }
}

const pool = [...poetryLines];
console.log('Total unique poetry lines in pool:', pool.length);

// 2. 逐檔案修正
let totalFixed = 0;

for (const f of files) {
  const qs = allQuestions[f];
  let fixed = 0;

  for (const q of qs) {
    if (q.category !== '唐詩理解') continue;
    
    const badWords = ['無從得知', '各詩不同', '以上皆是'];
    const hasBad = q.options.some(o => badWords.includes(o));
    if (!hasBad) continue;

    const correctText = q.options[q.answer];
    if (badWords.includes(correctText)) {
      // 這種情況不應出現，但先跳過
      console.log(`  WARNING: ${f} ${q.id} answer is ${correctText}`);
      continue;
    }

    // 保留正確答案 + 所有非 bad 的選項
    const goodOptions = q.options.filter(o => !badWords.includes(o));
    
    // 確保正確答案還在
    if (!goodOptions.includes(correctText)) {
      console.log(`  WARNING: ${f} ${q.id} correct answer ${correctText} not in good options`);
      continue;
    }

    // 從池中抽選干擾項（排除正確答案和已有的選項）
    const candidates = pool.filter(p => 
      !goodOptions.includes(p) && 
      p !== correctText &&
      p.length >= 4
    );
    
    // shuffle candidates
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }

    // 建立新選項：正確答案 + 3 個干擾
    const newOptions = [correctText, ...candidates.slice(0, 3)];
    
    // shuffle 但確保正確答案保持在 q.answer 位置
    const correctIdx = 0; // 先把正確答案放 index 0
    // 但我們需要隨機放置正確答案的位置
    const positions = [0, 1, 2, 3];
    // 把 correct 從 positions 中拿出來
    const ansPos = Math.floor(Math.random() * 4);
    const result = new Array(4);
    result[ansPos] = correctText;
    let ci = 1;
    for (let i = 0; i < 4; i++) {
      if (i !== ansPos) {
        result[i] = newOptions[ci];
        ci++;
      }
    }

    q.options = result;
    q.answer = ansPos;

    fixed++;
    totalFixed++;
  }

  fs.writeFileSync(path + '/' + f, JSON.stringify(qs, null, 2), 'utf-8');
  console.log(f + ': fixed ' + fixed + ' questions');
}

console.log('Total fixed:', totalFixed);
