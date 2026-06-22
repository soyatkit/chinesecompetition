/**
 * 2.3: 成語運用干擾項修正 — 直接針對已知問題題目
 * 比對完全無關的干擾項，替換為語義相關的成語解釋
 */

const fs = require('fs');
const DIR = __dirname;

const files = ['genQ-p4.json', 'genQ-p5.json', 'genQ-p6.json'];

// 成語 → 語義相關的成語解釋（用於干擾）
const IDIOM_SEMANTIC_MAP = {
  '井底之蛙': { matches: ['見識短淺'], related: ['目光如豆', '坐井觀天', '孤陋寡聞', '鼠目寸光'] },
  '畫龍點睛': { matches: ['精彩一筆', '關鍵', '關鍵一筆'], related: ['一語道破', '一針見血', '切中要害', '畫蛇添足'] },
  '全神貫注': { matches: ['專心'], related: ['專心致志', '一心一意', '聚精會神', '心無旁騖'] },
  '一心一意': { matches: ['專心'], related: ['專心致志', '全神貫注', '聚精會神', '心無旁騖'] },
  '心直口快': { matches: ['性格直率', '說話爽快'], related: ['直言不諱', '坦率直言', '開門見山', '實話實說'] },
  '有條有理': { matches: ['有次序', '條理'], related: ['井井有條', '有條不紊', '井然有序', '按部就班'] },
  '一五一十': { matches: ['詳細'], related: ['原原本本', '鉅細無遺', '細細道來', '不厭其詳'] },
  '不約而同': { matches: ['沒有事先約定'], related: ['不謀而合', '異口同聲', '殊途同歸', '不期而遇'] },
  '千方百計': { matches: ['想盡辦法', '想盡各種辦法'], related: ['想方設法', '費盡心思', '絞盡腦汁', '挖空心思'] },
  '東張西望': { matches: ['到處張望', '四處'], related: ['左顧右盼', '四處張望', '東張西望', '探头探腦'] },
  '念念不忘': { matches: ['牢記'], related: ['刻骨銘心', '銘記於心', '牢記在心', '耿耿於懷'] },
  '津津有味': { matches: ['很有味道', '有興趣'], related: ['興致勃勃', '饒有興致', '意猶未盡', '樂在其中'] },
  '目不轉睛': { matches: ['專心地看', '專心看'], related: ['全神貫注', '聚精會神', '目定口呆', '注視'] },
  '畫蛇添足': { matches: ['多此一舉'], related: ['多此一舉', '弄巧反拙', '適得其反', '欲蓋彌彰'] },
  '半途而廢': { matches: ['中途', '放棄'], related: ['有始無終', '功虧一簣', '前功盡廢', '虎頭蛇尾'] },
  '自言自語': { matches: ['自己說話', '自己跟自己'], related: ['喃喃自語', '自說自話', '竊竊私語', '獨白'] },
  '七上八下': { matches: ['心情不安', '不安'], related: ['忐忑不安', '坐立不安', '心神不寧', '心緒不寧'] },
};

let totalFixed = 0;

for (const f of files) {
  const qs = JSON.parse(fs.readFileSync(DIR + '/' + f, 'utf-8'));
  let fixed = 0;

  for (const q of qs) {
    if (q.category !== '成語運用') continue;

    const correct = q.options[q.answer];
    
    // 找對應的成語
    let mapping = null;
    for (const [idiom, map] of Object.entries(IDIOM_SEMANTIC_MAP)) {
      if (correct.includes(idiom) || map.matches.some(m => correct.includes(m))) {
        mapping = map;
        break;
      }
    }
    if (!mapping) continue;

    // 檢查是否有完全無關的干擾項
    const badWords = ['非常乾淨', '到處張望', '想盡辦法', '專心做事', '自己承受後果', 
      '詳細說出', '念念不忘', '反覆思考', '來之不易', '非常驚訝', '做事不專心',
      '保守秘密', '關鍵一筆', '關鍵地方', '按實際情況處理', '不誇大不虛假',
      '持續努力', '不輕易放棄', '問題順利解決', '沉着鎮定', '做事前已有周詳打算',
      '有味道', '很有味道', '有次序', '專心看', '完全相同'];

    const distractors = q.options.filter((_, i) => i !== q.answer);
    const hasBad = distractors.some(d => badWords.some(b => d.includes(b)));
    if (!hasBad) continue;

    // 生成新干擾項：從 related 中抽
    // 但 related 是成語，需要轉換成解釋形式
    const relatedMeanings = mapping.related;
    
    // 為每個 related 成語配一個簡短解釋
    const meaningMap = {
      '目光如豆': '見識狹窄',
      '坐井觀天': '見識狹窄',
      '孤陋寡聞': '見識少',
      '鼠目寸光': '眼光短淺',
      '一語道破': '一句話說中要害',
      '一針見血': '說話切中要害',
      '切中要害': '說到關鍵',
      '畫蛇添足': '多此一舉',
      '專心致志': '非常專心',
      '聚精會神': '集中精神',
      '心無旁騖': '專心做事',
      '直言不諱': '說話直率',
      '坦率直言': '說話坦白',
      '開門見山': '說話直接',
      '實話實說': '說真話',
      '井井有條': '有條理',
      '有條不紊': '有條理',
      '井然有序': '有秩序',
      '按部就班': '有次序',
      '原原本本': '詳細說出',
      '鉅細無遺': '詳細無漏',
      '細細道來': '詳細說明',
      '不謀而合': '沒有約定而一致',
      '異口同聲': '說法一致',
      '殊途同歸': '方法不同結果相同',
      '不期而遇': '偶然相遇',
      '想方設法': '想辦法',
      '費盡心思': '用盡心思',
      '絞盡腦汁': '用盡腦力',
      '挖空心思': '用盡心思',
      '左顧右盼': '四處張望',
      '四處張望': '到處看',
      '刻骨銘心': '牢記不忘',
      '銘記於心': '牢記心中',
      '牢記在心': '記在心裡',
      '耿耿於懷': '心中掛念',
      '興致勃勃': '很有興趣',
      '饒有興致': '很有興趣',
      '意猶未盡': '還未滿足',
      '樂在其中': '從中感受到快樂',
      '多此一舉': '做多餘的事',
      '弄巧反拙': '本想取巧反而更糟',
      '適得其反': '結果與預期相反',
      '有始無終': '不能堅持到底',
      '功虧一簣': '最後關頭失敗',
      '前功盡廢': '之前的努力白費',
      '虎頭蛇尾': '開始好結尾差',
      '喃喃自語': '低聲自己說話',
      '自說自話': '自己說自己的',
      '忐忑不安': '心情不安',
      '坐立不安': '坐著站著都不安',
      '心神不寧': '心情不安',
      '心緒不寧': '心裡不能平靜',
    };

    const pool = relatedMeanings
      .map(r => meaningMap[r] || r)
      .filter(r => !q.options.includes(r) && r !== correct);
    
    // Shuffle pool
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    if (pool.length < 3) continue;

    // 但保留 1 個原有干擾項（非無關的），其餘替換
    const keptDistractors = distractors.filter(d => !badWords.some(b => d.includes(b)));
    const newDistractors = [...keptDistractors, ...pool].slice(0, 3);
    
    if (newDistractors.length < 3) continue;

    // 重新組合
    const ansPos = Math.floor(Math.random() * 4);
    const result = new Array(4);
    result[ansPos] = correct;
    let di = 0;
    for (let i = 0; i < 4; i++) {
      if (i !== ansPos) {
        result[i] = newDistractors[di];
        di++;
      }
    }

    q.options = result;
    q.answer = ansPos;
    fixed++;
    totalFixed++;
  }

  fs.writeFileSync(DIR + '/' + f, JSON.stringify(qs, null, 2), 'utf-8');
  console.log(`${f}: 成語運用修正 ${fixed} 題`);
}

console.log(`\n2.3 合計: ${totalFixed} 題`);
