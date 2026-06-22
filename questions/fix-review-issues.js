/**
 * 執行審報告 #2.2 #2.3 #2.4 修正
 * 
 * 2.2: 反義詞題干擾項 — 三近一反 → 語義相關但非直接反義
 * 2.3: 成語運用干擾項 — 完全無關 → 語義相關成語 
 * 2.4: 修辭辨識去重 — R1保留基礎, Bonus進階
 */

const fs = require('fs');
const DIR = __dirname;

// ============================================================
// 2.2: 反義詞題干擾項修正
// ============================================================
// 對每題反義詞，找出正確答案，將同義/近義干擾項替換為「語義相關但非反義」詞
// 策略：從同級別其他題的正確答案中隨機抽取語義相關詞

function fixAntonymDistractors(questions, grade) {
  let count = 0;
  for (const q of questions) {
    if (q.category !== '詞義辨析') continue;
    if (!q.text.includes('反義詞')) continue;

    const correctIdx = q.answer;
    const correct = q.options[correctIdx];

    // 找出哪些干擾項是同義/近義詞（與正確答案語義方向相同）
    const synonymSet = new Set([
      '相同','相似','類似','相近','對立','不同','相反','顛倒'
    ]);
    // 這些詞本身也是問題，但之前已處理過。現在找「三近一反」模式
    // 例如「退縮」的反義→「畏縮/勇進/卻步/退避」中三個是近義
    
    // 對於反義詞題，我們需要辨識：
    // 正確答案(correct) 是反義詞
    // 干擾項中如果多於2個都和correct是「同一方向的」就是問題
    
    // 簡單策略：為這些反義詞題生成更好的干擾項
    // 從同級別題庫中找「語義相關但不是反義」的詞
    const relatedWords = new Map();
    
    // 從所有同級別題目收集詞彙
    for (const other of questions) {
      if (other.category === '詞義辨析') {
        for (const opt of other.options) {
          if (opt.length >= 2 && opt.length <= 6) {
            relatedWords.set(opt, (relatedWords.get(opt) || 0) + 1);
          }
        }
      }
      if (other.category === '成語運用') {
        for (const opt of other.options) {
          if (opt.length >= 4 && opt.length <= 20) {
            relatedWords.set(opt, (relatedWords.get(opt) || 0) + 1);
          }
        }
      }
    }

    // 對現有干擾項，檢查是否有太多同方向的
    const distractors = q.options.filter((_, i) => i !== correctIdx);
    
    // 如果干擾項中有 >= 2 個與 correct 是同方向（同是近義或同是反義方向）
    // 只保留 1 個同方向，其餘替換
    let badCount = 0;
    for (const d of distractors) {
      // 如果干擾項與 correct 有相同字（如「退縮」的干擾「畏縮」「退避」）
      let overlap = 0;
      for (const ch of d) {
        if (correct.includes(ch) || d.includes(correct)) {
          overlap++;
        }
      }
      // 粗略判斷：共享字元多的可能是同方向
      if (overlap >= 1 && d !== correct) {
        badCount++;
      }
    }

    // 如果至少有 2 個干擾項含有相同字，替換其中一些
    if (badCount >= 2) {
      // 保留 1 個同方向干擾，其餘替換
      const pool = [...relatedWords.keys()].filter(w => 
        !q.options.includes(w) && 
        w !== correct &&
        !w.includes(correct) &&
        !correct.includes(w) &&
        w.length >= 2 && w.length <= 6
      );
      
      // shuffle
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }

      // 找出可被替換的干擾項位置（保留 1 個同方向）
      let keptOne = false;
      const newOptions = [correct]; // 正確答案始終 index 0
      for (let i = 0; i < q.options.length; i++) {
        if (i === correctIdx) continue;
        const d = q.options[i];
        let overlap = 0;
        for (const ch of d) {
          if (correct.includes(ch) || d.includes(correct)) {
            overlap++;
          }
        }
        if (overlap >= 1 && !keptOne) {
          newOptions.push(d);
          keptOne = true;
        } else if (overlap >= 1 && pool.length > 0) {
          // 替換
          newOptions.push(pool.shift());
        } else {
          newOptions.push(d);
        }
      }

      // 確保 4 個選項
      while (newOptions.length < 4 && pool.length > 0) {
        newOptions.push(pool.shift());
      }

      // Shuffle 但保持 correct 位置
      const ansPos = Math.floor(Math.random() * 4);
      const result = new Array(4);
      result[ansPos] = correct;
      let idx = 0;
      for (let i = 0; i < 4; i++) {
        if (i !== ansPos) {
          result[i] = newOptions[idx + 1];
          idx++;
        }
      }
      
      q.options = result;
      q.answer = ansPos;
      count++;
    }
  }
  return count;
}

// ============================================================
// 2.3: 成語運用干擾項修正
// ============================================================
// 將完全無關的干擾項換成語義相關的

function fixIdiomDistractors(questions) {
  let count = 0;
  
  // 成語語義分組（用於生成相關干擾項）
  const idiomGroups = {
    '專心': ['全神貫注', '專心致志', '一心一意', '心無旁騖', '聚精會神'],
    '見識': ['井底之蛙', '坐井觀天', '孤陋寡聞', '目光如豆', '鼠目寸光'],
    '驚嚇': ['大吃一驚', '目瞪口呆', '驚慌失措', '大驚失色', '瞠目結舌'],
    '說話': ['心直口快', '實話實說', '直言不諱', '開門見山', '坦率直言'],
    '次序': ['井井有條', '有條不紊', '按部就班', '井然有序', '有條有理'],
    '詳細': ['一五一十', '原原本本', '鉅細無遺', '細細道來', '有條不紊'],
    '約定': ['不約而同', '不謀而合', '不期而遇', '殊途同歸', '異口同聲'],
    '辦法': ['千方百計', '想方設法', '費盡心思', '絞盡腦汁', '挖空心思'],
    '觀看': ['東張西望', '左顧右盼', '四處張望', '目不轉睛', '注視前方'],
    '乾淨': ['一塵不染', '窗明几淨', '煥然一新', '乾淨利落', '井井有條'],
    '關鍵': ['畫龍點睛', '一語道破', '一針見血', '切中要害', '點睛之筆'],
    '記憶': ['念念不忘', '刻骨銘心', '銘記於心', '牢記在心', '耿耿於懷'],
    '結果': ['自食其果', '自作自受', '咎由自取', '罪有應得', '自作孽'],
    '有趣': ['津津有味', '興致勃勃', '饒有興致', '意猶未盡', '樂在其中'],
    '比喻': ['井底之蛙', '畫蛇添足', '守株待兔', '掩耳盜鈴', '畫龍點睛'],
  };

  for (const q of questions) {
    if (q.category !== '成語運用') continue;
    
    const correctIdx = q.answer;
    const correctText = q.options[correctIdx];
    
    // 試 match 成語分組
    let group = null;
    for (const [g, words] of Object.entries(idiomGroups)) {
      if (words.includes(correctText)) {
        group = words;
        break;
      }
    }
    
    if (!group) {
      // 如果不在分組中，嘗試從所有成語中找相關的
      continue;
    }

    // 檢查現有干擾項
    const distractors = q.options.filter((_, i) => i !== correctIdx);
    const totallyUnrelated = ['完全相同', '非常專心', '見識短淺', '很有味道', '想盡辦法',
      '專心做事', '自己承受後果', '詳細說出', '到處張望', '非常乾淨',
      '念念不忘', '反覆思考', '來之不易', '非常驚訝', '做事不專心',
      '保守秘密', '做事或說話有次序', '關鍵一筆', '關鍵地方',
      '按實際情況處理', '不誇大不虛假', '持續努力', '不輕易放棄',
      '問題順利解決', '沉着鎮定', '做事前已有周詳打算', '性格直率',
      '說話爽快', '一見如故', '來之不易', '保守秘密'];
    
    const hasUnrelated = distractors.some(d => totallyUnrelated.includes(d));
    if (!hasUnrelated) continue;

    // 從同組生成干擾項
    const groupDistractors = group.filter(w => w !== correctText);
    const pool = [...groupDistractors];
    
    // 從其他組也抽一些來 mix
    for (const [, words] of Object.entries(idiomGroups)) {
      for (const w of words) {
        if (!pool.includes(w) && w !== correctText && !q.options.includes(w)) {
          pool.push(w);
        }
      }
    }

    // 隨機抽 3 個
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    const newDistractors = pool.slice(0, 3).filter(w => !q.options.includes(w));
    
    if (newDistractors.length < 3) continue;

    // Build new options
    const ansPos = Math.floor(Math.random() * 4);
    const result = new Array(4);
    result[ansPos] = correctText;
    let di = 0;
    for (let i = 0; i < 4; i++) {
      if (i !== ansPos) {
        result[i] = newDistractors[di];
        di++;
      }
    }
    
    q.options = result;
    q.answer = ansPos;
    count++;
  }
  
  return count;
}

// ============================================================
// 2.4: 修辭辨識去重
// ============================================================
// 方案 B: R1 保留基礎修辭（比喻/擬人/排比/誇張），Bonus 做進階
// 步驟:
//   1. 從 R1 移除較進階的修辭題（設問/反問/反覆/對偶）
//   2. 替換為新增的基礎修辭題
//   3. Bonus 修辭手法全部改為進階（轉品/雙關/借代/互文/列錦/博喻/示現/層遞）

function fixRhetoricOverlap(r1Questions, category) {
  // 基礎修辭：比喻、擬人、排比、誇張
  const basic = ['比喻', '擬人', '排比', '誇張'];
  // 進階/可移除：設問、反問、反覆、對偶
  const advanced = ['設問', '反問', '反覆', '對偶'];
  
  let removed = 0;
  const kept = [];
  const toReplace = [];
  
  for (const q of r1Questions) {
    if (q.category !== category) continue;
    const correct = q.options[q.answer];
    // 如果是進階修辭，標記為需要替換
    if (advanced.some(a => correct.includes(a))) {
      toReplace.push(q);
      removed++;
    } else {
      kept.push(q);
    }
  }
  
  // 為被移除的題目生成新的基礎修辭題
  const newQuestions = [];
  const basicExamples = [
    { text: '「她的笑容像陽光一樣燦爛。」用了甚麼修辭？', answer: '比喻', opts: ['比喻', '擬人', '誇張', '排比'] },
    { text: '「時間像流水一樣一去不回。」用了甚麼修辭？', answer: '比喻', opts: ['比喻', '擬人', '反問', '設問'] },
    { text: '「小鳥在樹上開演唱會。」用了甚麼修辭？', answer: '擬人', opts: ['擬人', '比喻', '排比', '誇張'] },
    { text: '「風兒輕輕撫摸我的臉。」用了甚麼修辭？', answer: '擬人', opts: ['擬人', '比喻', '設問', '反覆'] },
    { text: '「他一口氣喝了三桶水。」用了甚麼修辭？', answer: '誇張', opts: ['誇張', '比喻', '擬人', '排比'] },
    { text: '「她的眼淚像決堤的河水。」用了甚麼修辭？', answer: '誇張', opts: ['誇張', '比喻', '擬人', '設問'] },
    { text: '「我愛看書，我愛畫畫，我愛唱歌。」用了甚麼修辭？', answer: '排比', opts: ['排比', '比喻', '擬人', '誇張'] },
    { text: '「春天是綠色的，夏天是紅色的，秋天是金色的，冬天是白色的。」用了甚麼修辭？', answer: '排比', opts: ['排比', '設問', '反問', '反覆'] },
    { text: '「她的歌聲像夜鶯一樣動聽。」用了甚麼修辭？', answer: '比喻', opts: ['比喻', '擬人', '誇張', '對偶'] },
    { text: '「月亮像白玉盤掛在天空。」用了甚麼修辭？', answer: '比喻', opts: ['比喻', '擬人', '排比', '反問'] },
    { text: '「春姑娘輕輕喚醒了大地。」用了甚麼修辭？', answer: '擬人', opts: ['擬人', '比喻', '誇張', '排比'] },
    { text: '「這書包重得我肩膀都要斷了。」用了甚麼修辭？', answer: '誇張', opts: ['誇張', '比喻', '擬人', '設問'] },
    { text: '「他跑，他跳，他笑，他大聲喊叫。」用了甚麼修辭？', answer: '排比', opts: ['排比', '比喻', '擬人', '誇張'] },
    { text: '「小草從土裡探出頭來。」用了甚麼修辭？', answer: '擬人', opts: ['擬人', '比喻', '誇張', '排比'] },
    { text: '「這屋裡熱得像蒸籠一樣。」用了甚麼修辭？', answer: '比喻', opts: ['比喻', '擬人', '誇張', '反問'] },
  ];

  for (let i = 0; i < toReplace.length && i < basicExamples.length; i++) {
    const ex = basicExamples[i];
    const ansPos = Math.floor(Math.random() * 4);
    const result = new Array(4);
    result[ansPos] = ex.answer;
    let di = 0;
    for (let j = 0; j < 4; j++) {
      if (j !== ansPos) {
        result[j] = ex.opts.filter(o => o !== ex.answer)[di];
        di++;
      }
    }
    
    const newQ = {
      text: ex.text,
      options: result,
      answer: ansPos,
      category: toReplace[i].category,
      id: toReplace[i].id,
      difficulty: toReplace[i].difficulty,
      timeLimit: toReplace[i].timeLimit,
      explanation: `正確答案：「${ex.answer}」。`,
    };
    newQuestions.push(newQ);
  }

  // 將新題目放回原來位置
  let replaceIdx = 0;
  for (let i = 0; i < r1Questions.length; i++) {
    if (r1Questions[i].category === category) {
      const correct = r1Questions[i].options[r1Questions[i].answer];
      if (advanced.some(a => correct.includes(a))) {
        r1Questions[i] = newQuestions[replaceIdx];
        replaceIdx++;
      }
    }
  }

  return removed;
}

// ============================================================
// Bonus 修辭手法 → 進階修辭
// ============================================================

const ADVANCED_RHETORIC = [
  { text: '「春蠶到死絲方盡」中「絲」與「思」諧音，用了甚麼修辭？', answer: '雙關', opts: ['雙關', '借代', '轉品', '互文'] },
  { text: '「東邊日出西邊雨，道是無晴卻有晴」中的「晴」用了甚麼修辭？', answer: '雙關', opts: ['雙關', '比喻', '擬人', '對偶'] },
  { text: '「他是一個活雷鋒」中的「雷鋒」用了甚麼修辭？', answer: '借代', opts: ['借代', '比喻', '擬人', '誇張'] },
  { text: '「朱門酒肉臭」中的「朱門」用了甚麼修辭？', answer: '借代', opts: ['借代', '比喻', '雙關', '轉品'] },
  { text: '「春風又綠江南岸」中「綠」字由形容詞變動詞，用了甚麼修辭？', answer: '轉品', opts: ['轉品', '雙關', '借代', '互文'] },
  { text: '「春蠶到死絲方盡，蠟炬成灰淚始乾」上下句互相補充，用了甚麼修辭？', answer: '互文', opts: ['互文', '對偶', '比喻', '雙關'] },
  { text: '「秦時明月漢時關」意思是秦漢時的明月和關塞，用了甚麼修辭？', answer: '互文', opts: ['互文', '借代', '雙關', '對偶'] },
  { text: '「枯藤、老樹、昏鴉，小橋、流水、人家」用了甚麼修辭？', answer: '列錦', opts: ['列錦', '排比', '對偶', '層遞'] },
  { text: '「圓圓的月亮像白玉盤，又像一面明鏡」用了甚麼修辭？', answer: '博喻', opts: ['博喻', '明喻', '隱喻', '借喻'] },
  { text: '「她瘦得皮包骨頭」中的「皮包骨」用了甚麼修辭？', answer: '誇飾', opts: ['誇飾', '比喻', '借代', '雙關'] },
  { text: '「沉默啊，沉默啊！不在沉默中爆發，就在沉默中滅亡」主要修辭是？', answer: '反覆和對比', opts: ['反覆和對比', '排比和比喻', '對偶和誇張', '擬人和反覆'] },
  { text: '「感時花濺淚，恨別鳥驚心」的最主要修辭手法是？', answer: '擬人', opts: ['擬人', '比喻', '對比', '排比'] },
  { text: '「以你的聰明，這點小事還辦不到嗎？」用了甚麼修辭？', answer: '反問', opts: ['反問', '設問', '誇張', '反語'] },
  { text: '「問君能有幾多愁？恰似一江春水向東流」包含哪兩種修辭？', answer: '設問和比喻', opts: ['設問和比喻', '反問和排比', '設問和誇張', '反問和比喻'] },
  { text: '「盼望着，盼望着，東風來了，春天的腳步近了」用了甚麼修辭？', answer: '反覆和擬人', opts: ['反覆和擬人', '排比和比喻', '反覆和排比', '擬人和誇張'] },
  { text: '「桃花潭水深千尺，不及汪倫送我情」用了甚麼修辭？', answer: '襯托', opts: ['襯托', '比喻', '反問', '排比'] },
  { text: '「山舞銀蛇，原馳蠟象」用了甚麼修辭手法？', answer: '對偶和比喻', opts: ['對偶和比喻', '擬人和排比', '比喻和排比', '對偶和誇張'] },
  { text: '「舊時王謝堂前燕，飛入尋常百姓家」用了甚麼修辭手法？', answer: '對比', opts: ['對比', '比喻', '擬人', '排比'] },
  { text: '「忽如一夜春風來，千樹萬樹梨花開」用了甚麼修辭手法？', answer: '借喻', opts: ['借喻', '擬人', '誇張', '排比'] },
  { text: '「白髮三千丈，緣愁似箇長」用了甚麼修辭手法？', answer: '誇張', opts: ['誇張', '比喻', '擬人', '排比'] },
];

function upgradeBonusRhetoric(bonusQuestions) {
  let upgraded = 0;
  let idx = 0;
  for (const q of bonusQuestions) {
    if (q.category === '修辭手法' || q.category === '修辭辨識') {
      if (idx < ADVANCED_RHETORIC.length) {
        const ex = ADVANCED_RHETORIC[idx];
        const ansPos = Math.floor(Math.random() * 4);
        const result = new Array(4);
        result[ansPos] = ex.answer;
        let di = 0;
        for (let j = 0; j < 4; j++) {
          if (j !== ansPos) {
            result[j] = ex.opts.filter(o => o !== ex.answer)[di];
            di++;
          }
        }
        q.text = ex.text;
        q.options = result;
        q.answer = ansPos;
        q.explanation = `正確答案：「${ex.answer}」。`;
        upgraded++;
      }
      idx++;
    }
  }
  return upgraded;
}

// ============================================================
// MAIN
// ============================================================

const r1files = ['genQ-p4.json', 'genQ-p5.json', 'genQ-p6.json'];
const bonusFiles = ['genQ-bonus-p4.json', 'genQ-bonus-p5.json', 'genQ-bonus-p6.json'];

// 2.2 & 2.3: 反義詞 + 成語運用
let antonymTotal = 0;
let idiomTotal = 0;
for (const f of r1files) {
  const qs = JSON.parse(fs.readFileSync(DIR + '/' + f, 'utf-8'));
  const grade = f.match(/p([456])/)[1];
  
  const a = fixAntonymDistractors(qs, 'P' + grade);
  const i = fixIdiomDistractors(qs);
  antonymTotal += a;
  idiomTotal += i;
  
  fs.writeFileSync(DIR + '/' + f, JSON.stringify(qs, null, 2), 'utf-8');
  console.log(`${f}: 反義詞修正 ${a} 題, 成語運用修正 ${i} 題`);
}
console.log(`\n2.2 合計: ${antonymTotal} 題`);
console.log(`2.3 合計: ${idiomTotal} 題`);

// 2.4: 修辭辨識去重
console.log('\n--- 2.4 修辭辨識去重 ---');
for (const f of r1files) {
  const qs = JSON.parse(fs.readFileSync(DIR + '/' + f, 'utf-8'));
  const category = f === 'genQ-p4.json' ? '修辭辨識' : '修辭辨識';
  const removed = fixRhetoricOverlap(qs, '修辭辨識');
  fs.writeFileSync(DIR + '/' + f, JSON.stringify(qs, null, 2), 'utf-8');
  console.log(`${f}: 移除 ${removed} 題進階修辭，補充基礎修辭`);
}

// Bonus: 升級修辭手法
console.log('\n--- Bonus 修辭手法升級 ---');
for (const f of bonusFiles) {
  const qs = JSON.parse(fs.readFileSync(DIR + '/' + f, 'utf-8'));
  const upgraded = upgradeBonusRhetoric(qs);
  fs.writeFileSync(DIR + '/' + f, JSON.stringify(qs, null, 2), 'utf-8');
  console.log(`${f}: 升級 ${upgraded} 題進階修辭`);
}

console.log('\n✅ 全部完成');
