/**
 * 修正 Round 1「找錯字」題目
 * 
 * 問題：選項中包含「不需改正」「另有其他錯字」——移除並替換為合理的錯字選項
 * 
 * 策略：從題庫本身提取所有獨特的「X→Y」錯字配對作為干擾項池
 * 對每題：保留原正確選項 + 反向選項 + 2 個來自池中的其他合理選項
 */

const fs = require('fs');
const path = __dirname;

const files = ['genQ-p4.json', 'genQ-p5.json', 'genQ-p6.json'];

// 1. 先掃所有檔案，建立錯字配對池
const allPairs = new Set();
const allQuestions = {};

for (const f of files) {
  const qs = JSON.parse(fs.readFileSync(path + '/' + f, 'utf-8'));
  allQuestions[f] = qs;
  for (const q of qs) {
    if (q.category !== '找錯字') continue;
    for (const opt of q.options) {
      // 匹配 "X→Y" 格式
      if (/^[^\s]→[^\s]$/.test(opt)) {
        allPairs.add(opt);
      }
      // 也匹配反向
      if (/^[^\s]→[^\s]$/.test(opt)) {
        const [a, b] = opt.split('→');
        allPairs.add(b + '→' + a);
      }
    }
  }
}

const pool = [...allPairs];
console.log('Total unique pairs in pool:', pool.length);

// 2. 逐檔案修正
let totalFixed = 0;

for (const f of files) {
  const qs = allQuestions[f];
  let fixed = 0;

  for (const q of qs) {
    if (q.category !== '找錯字') continue;
    if (!q.options.some(o => o === '不需改正' || o === '另有其他錯字')) continue;

    // 找出有效的「X→Y」選項（保留）
    const validOptions = q.options.filter(o => /^[^\s]→[^\s]$/.test(o));
    const answerText = q.options[q.answer];

    // 確保正確答案在 validOptions 中
    if (!validOptions.includes(answerText)) {
      // 如果正確答案是「不需改正」或「另有其他錯字」，但有 validOptions
      // 這不可能發生——看看實際情況
      console.log(`  WARNING: ${f} answer=${q.answer} text="${answerText}" validOptions=[${validOptions}]`);
      // fallback:第一個 valid 選項就是答案
      if (validOptions.length > 0) {
        q.answer = 0;
      }
      continue;
    }

    // 正確答案必須是 index 0，其餘 shuffle
    const others = validOptions.filter(o => o !== answerText);
    // shuffle others
    for (let i = others.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [others[i], others[j]] = [others[j], others[i]];
    }

    // 需要補到 4 個選項
    let finalOptions = [answerText, ...others];
    
    // 從池中補充不足的選項
    while (finalOptions.length < 4) {
      const candidates = pool.filter(p => !finalOptions.includes(p));
      if (candidates.length === 0) break;
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      finalOptions.push(pick);
    }

    // 確認題目選項有 4 個
    q.options = finalOptions.slice(0, 4);
    q.answer = 0; // 正確答案在 index 0

    fixed++;
    totalFixed++;
  }

  // 寫回檔案
  fs.writeFileSync(path + '/' + f, JSON.stringify(qs, null, 2), 'utf-8');
  console.log(f + ': fixed ' + fixed + ' questions');
}

console.log('Total fixed:', totalFixed);
