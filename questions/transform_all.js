/**
 * 題庫全面改造腳本 - P0 到 P2 一次過修正
 * 
 * P0: poem→category, 單選項添加干擾項
 * P1: 詞義辨析去元語言干擾項, 跨年級去重
 * P2: metadata, 新題型
 * 
 * 用法: node transform_all.js
 * 會在當前目錄生成一個 backup/ 備份原檔, 然後覆寫所有 JSON + banks.js
 */

const fs = require('fs');
const path = require('path');

const QUESTIONS_DIR = __dirname;
const BACKUP_DIR = path.join(__dirname, 'backup');

// ============================================================
// 工具函數
// ============================================================
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomPick(arr, n) {
  return shuffle(arr).slice(0, n);
}

// ============================================================
// P0: 干擾項池
// ============================================================

// 成語池 — 用於成語填充題的干擾選項
const IDIOM_POOL = [
  '精益求精','融會貫通','堅持不懈','迎刃而解','胸有成竹',
  '實事求是','當機立斷','博覽群書','鍥而不捨','按部就班',
  '出類拔萃','孜孜不倦','豁然開朗','未雨綢繆','理直氣壯',
  '才德兼備','有條不紊','脫穎而出','心平氣和','一絲不苟',
  '水到渠成','對答如流','虛情假意','舉一反三','後來居上',
  '少年老成','得心應手','集思廣益','束手無策','旁徵博引',
  '循序漸進','不恥下問','溫故知新','學以致用','因材施教',
  '見義勇為','全力以赴','腳踏實地','專心致志','畫龍點睛',
  '井底之蛙','守株待兔','掩耳盜鈴','畫蛇添足','自相矛盾',
  '半途而廢','津津有味','百折不撓','孜孜以求','戒驕戒躁',
];

// 諺語後半句池 — 用於諺語補全題的干擾
const PROVERB_POOL = [
  '行行出狀元','鐵杵磨成針','始於足下','不進則退',
  '後人乘涼','好辦事','寸金難買寸光陰','天外有天',
  '不長一智','終有成功時','自然直','再借不難',
  '長一智','不得不低頭','終身為父','更進一步',
  '黃土變成金','惡語傷人六月寒','修行在個人','吃虧在眼前',
  '早入林','二人計長','見不善如探湯','人不學要落後',
  '一分收穫','只怕有心人','事竟成','必有我師焉',
  '成功之母','非一日之寒','台下十年功','下筆如有神',
  '日久見人心','非一日之功','必有近憂','種豆得豆',
  '火焰高','利於病','利於行','謙受益',
  '學海無涯苦作舟','老大徒傷悲','近墨者黑','曲不離口',
  '泰山移','只怕站','豐年','除非己莫為',
  '不怕沒柴燒','萬事興','事不可做絕','二回熟',
  '當湧泉相報','不許百姓點燈','成事在天',
];

// 歇後語後半句池
const XIEHOUYU_POOL = [
  '願者上鉤','一個願打，一個願挨','淨是書','不識好人心',
  '沒安好心','一場空','人人喊打','團團轉',
  '有苦說不出','摸不着頭腦','照舊','自賣自誇',
  '七上八下','白費蠟','自身難保','走着瞧',
  '假慈悲','長不了','節節高','沒門',
  '摸不得','問到底','無法無天','一竅不通',
  '一清二白','各顯神通','慢吞吞','目光短淺',
  '有去無回','功到自然成','路人皆知',
];

// 文學常識干擾池
const LITERATURE_WRONG = {
  '《西遊記》': ['《紅樓夢》','《水滸傳》','《三國演義》'],
  '《三國演義》': ['《水滸傳》','《西遊記》','《紅樓夢》'],
  '《水滸傳》': ['《三國演義》','《西遊記》','《紅樓夢》'],
  '《論語》': ['《孟子》','《大學》','《中庸》'],
  '孫悟空': ['豬八戒','沙僧','唐僧'],
  '豬八戒': ['孫悟空','沙僧','唐僧'],
  '沙僧': ['孫悟空','豬八戒','唐僧'],
  '諸葛亮': ['周瑜','曹操','司馬懿'],
  '劉備': ['曹操','孫權','諸葛亮'],
  '關羽': ['張飛','劉備','趙雲'],
  '宋江': ['吳用','武松','李逵'],
  '武松': ['宋江','李逵','林沖'],
  '李逵': ['武松','宋江','魯智深'],
  '孔子': ['孟子','老子','莊子'],
};

// ============================================================
// P1: 詞義辨析 — 元語言詞列表（要被替換的）
// ============================================================
const META_WORDS = new Set([
  '類似','相似','相近','相反','對立','不同','顛倒','顛倒',
]);

// 詞義辨析替換對照表：原正確答案 → 推薦的干擾項（3 個真實詞彙）
const VOCAB_DISTRACTORS = {
  // 近義詞 － 正確答案映射到干擾項
  '愉快':   ['歡樂','欣喜','暢快'],
  '漂亮':   ['標致','娟秀','動人'],
  '快速':   ['飛快','神速','疾速'],
  '迅速':   ['飛快','急速','火速'],
  '幫忙':   ['支援','輔助','援助'],
  '協助':   ['幫忙','支援','輔助'],
  '難過':   ['憂愁','沮喪','悲慟'],
  '機靈':   ['靈巧','乖巧','精靈'],
  '用心':   ['專注','專一','投入'],
  '明白':   ['清晰','透徹','明瞭'],
  '用功':   ['勤勉','專心','刻苦'],
  '寶貴':   ['稀有','名貴','難得'],
  '熱心':   ['熱情','熱衷','誠摯'],
  '憂慮':   ['掛念','焦躁','不安'],
  '讚賞':   ['欽佩','器重','推崇'],
  '堅守':   ['持守','固執','頑守'],
  '仁慈':   ['慈祥','寬厚','仁厚'],
  '緊張':   ['焦急','不安','慌亂'],
  '機智':   ['聰穎','睿智','精悍'],
  '勉勵':   ['鼓舞','鞭策','激發'],
  '敬重':   ['推重','景仰','敬佩'],
  '安慰':   ['安撫','勸慰','寬解'],
  '平穩':   ['安定','安穩','平順'],
  '和諧':   ['和睦','協調','融洽'],
  '充實':   ['豐盛','飽滿','殷實'],
  '真誠':   ['誠摯','赤誠','由衷'],
  '從容':   ['淡然','安閒','瀟灑'],
  '決斷':   ['果敢','堅毅','乾脆'],
  '主動':   ['自動','自覺','進取'],
  '迅捷':   ['火速','疾速','神速'],
  '周密':   ['詳備','周到','縝密'],
  '鎮定':   ['沈穩','冷靜','從容'], // 沉着
  '堅定':   ['堅毅','固守','頑強'], // 堅毅
  // 反義詞 － 為反義題生成干擾（給出正確的反義詞，再配 3 個非反義詞）
};

// 反義詞對照 (用於替換 "相反/對立/不同" 類的干擾項)
const ANTONYM_PAIRS = {
  '吵鬧':   ['安寧','平靜','靜謐'],
  '膽小':   ['堅毅','剛強','英勇'],
  '炎熱':   ['涼爽','溫煦','清冷'],
  '黑暗':   ['光耀','明亮','光亮'],
  '馬虎':   ['細緻','周到','嚴密'],
  '說謊':   ['坦白','老實','率直'],
  '凌亂':   ['潔淨','齊整','有序'],
  '寒冷':   ['和煦','暖和','溫馨'],
  '狹窄':   ['遼闊','寬敞','開廣'],
  '戰亂':   ['安穩','太平','昇平'],
  '陳舊':   ['新穎','簇新','鮮亮'],
  '冷清':   ['沸騰','熙攘','喧騰'],
  '困難':   ['輕巧','淺易','順當'],
  '危險':   ['安妥','穩當','無虞'],
  '退步':   ['躍進','提升','長進'],
  '懶惰':   ['奮發','刻苦','進取'],
  '浪費':   ['儉省','愛惜','善用'],
  '激動':   ['淡定','平和','沉靜'],
  '討厭':   ['鍾情','偏愛','熱衷'],
  '清晰':   ['朦朧','混沌','渾濁'],
  '吝嗇':   ['大方','闊綽','豪爽'],
  '輕浮':   ['沈實','穩練','篤定'],
  '寬闊':   ['逼仄','局促','窄隘'],
  '果斷':   ['游移','躊躇','觀望'],
  '驕傲':   ['卑微','謙恭','自抑'],
  '豐富':   ['匱乏','枯竭','稀落'],
  '熱情':   ['淡漠','疏遠','冷待'],
  '精神':   ['萎靡','頹喪','倦怠'],
  '隱約':   ['昭彰','確鑿','鮮明'],
  '溫和':   ['凌厲','苛刻','兇悍'],
  '迅速':   ['遲鈍','拖延','慢悠'],
  '勇進':   ['畏縮','卻步','退避'],
  '複雜':   ['淺近','單純','直白'],
  '特別':   ['平凡','庸常','等閒'],
  '安全':   ['凶險','危殆','險惡'],
  '急躁':   ['從容','耐心','安閒'],
  '動盪':   ['安穩','平定','穩固'],
  '貧乏':   ['優裕','豐足','充溢'],
  '結束':   ['肇始','啟動','發端'],
  '強烈':   ['淡薄','柔弱','輕微'],
  '消極':   ['奮發','進取','踴躍'],
  '忙碌':   ['空暇','悠閒','清暇'],
  '長久':   ['頃刻','短暫','須臾'],
  '簡單':   ['繁複','錯雜','艱深'],
  '虛假':   ['摯誠','赤忱','由衷'],
  '失敗':   ['凱旋','成功','得勝'],
};

// ============================================================
// P2: metadata 生成
// ============================================================
function makeId(grade, round, category, index) {
  const catMap = {
    '部首': 'BS',
    '詞義辨析': 'CY',
    '成語運用': 'CY2',
    '成語填充': 'CY3',
    '排句成段': 'PJ',
    '中國諺語': 'YY',
    '歇後語': 'XH',
    '文學名著常識': 'WX',
    '錯別字辨析': 'CB',
    '修辭手法': 'XC',
    '標點符號': 'BD',
    '唐詩填充': 'TS',
  };
  const cc = catMap[category] || 'OT';
  return `Q-${grade}-R${round}-${cc}-${String(index + 1).padStart(3, '0')}`;
}

function getDifficulty(grade, category) {
  const diffMap = {
    'P4': { '部首': 1, '詞義辨析': 1, '成語運用': 2, '成語填充': 2, '排句成段': 1, '中國諺語': 1, '歇後語': 2, '錯別字辨析': 1, '修辭手法': 2, '標點符號': 1, '唐詩填充': 2 },
    'P5': { '部首': 1, '詞義辨析': 2, '成語運用': 2, '成語填充': 2, '排句成段': 2, '中國諺語': 2, '歇後語': 2, '錯別字辨析': 2, '修辭手法': 2, '標點符號': 1, '唐詩填充': 2 },
    'P6': { '部首': 2, '詞義辨析': 2, '成語運用': 3, '成語填充': 3, '排句成段': 2, '中國諺語': 3, '歇後語': 3, '文學名著常識': 3, '錯別字辨析': 3, '修辭手法': 3, '標點符號': 2, '唐詩填充': 3 },
  };
  return (diffMap[grade] && diffMap[grade][category]) || 2;
}

function getTimeLimit(category) {
  const tl = {
    '部首': 10,
    '詞義辨析': 15,
    '成語運用': 15,
    '成語填充': 20,
    '排句成段': 30,
    '中國諺語': 20,
    '歇後語': 20,
    '文學名著常識': 15,
    '錯別字辨析': 15,
    '修辭手法': 15,
    '標點符號': 15,
    '唐詩填充': 20,
  };
  return tl[category] || 15;
}

function getExplanation(category, q) {
  const options = q.options;
  const ansIdx = q.answer;
  const correct = options[ansIdx];
  
  switch (category) {
    case '部首':
      return `「${q.text.match(/「(.+?)」/)?.[1] || ''}」的部首是「${correct}」。`;
    case '詞義辨析': {
      const isSynonym = q.text.includes('近義詞');
      return `${isSynonym ? '近義詞' : '反義詞'}：「${correct}」與題目詞語意義${isSynonym ? '最相近' : '相反'}。`;
    }
    case '成語運用':
    case '成語填充':
      return `正確答案：「${correct}」。`;
    case '排句成段':
      return `按時間/邏輯順序排列為：${correct}。`;
    case '中國諺語':
    case '歇後語':
      return `正確答案：「${correct}」。`;
    case '文學名著常識':
      return `正確答案：「${correct}」。`;
    default:
      return `正確答案：「${correct}」。`;
  }
}

// ============================================================
// 核心轉換函數
// ============================================================

/**
 * P0: 為單選項題添加干擾項
 */
function addDistractors(q, category, allQ) {
  if (!q.options || q.options.length >= 3) return q; // 已有多選項則跳過

  const text = q.text;
  const correct = q.options[0];

  switch (category) {
    case '排句成段': {
      // 從 text 中抽取句子編號並生成錯誤排序
      const nums = (text.match(/\((\d+)\)/g) || []).map(s => s.replace(/[()]/g, ''));
      if (nums.length < 3) {
        // fallback: 加兩個假排序
        q.options = [correct, nums.join('、'), nums.reverse().join('、')];
        break;
      }
      // 生成 3 個不同的錯誤排序
      const wrongSet = new Set();
      wrongSet.add(correct);
      const wrongs = [];
      let attempts = 0;
      while (wrongs.length < 3 && attempts < 50) {
        const shuffled = shuffle(nums).join('、');
        if (!wrongSet.has(shuffled)) {
          wrongSet.add(shuffled);
          wrongs.push(shuffled);
        }
        attempts++;
      }
      // 確保至少有不同的排序
      while (wrongs.length < 3) {
        const s = [...nums].sort(() => Math.random() - 0.5).join('、');
        if (!wrongSet.has(s)) {
          wrongSet.add(s);
          wrongs.push(s);
        }
      }
      q.options = [correct, ...wrongs];
      // 答案始終是 0（正確答案在第一位）
      q.answer = 0;
      break;
    }

    case '成語填充': {
      // 從成語池中抽取 3 個不同於正確答案的干擾項
      const distractors = randomPick(
        IDIOM_POOL.filter(w => w !== correct),
        3
      );
      q.options = [correct, ...distractors];
      q.answer = 0;
      break;
    }

    case '中國諺語': {
      const distractors = randomPick(
        PROVERB_POOL.filter(w => w !== correct),
        3
      );
      q.options = [correct, ...distractors];
      q.answer = 0;
      break;
    }

    case '歇後語': {
      const distractors = randomPick(
        XIEHOUYU_POOL.filter(w => w !== correct),
        3
      );
      q.options = [correct, ...distractors];
      q.answer = 0;
      break;
    }

    case '文學名著常識': {
      // 嘗試從 LITERATURE_WRONG 找對應干擾
      let distractors = [];
      for (const [key, vals] of Object.entries(LITERATURE_WRONG)) {
        if (correct.includes(key) || correct === key) {
          distractors = [...vals];
          break;
        }
        if (vals.some(v => correct.includes(v) || correct === v)) {
          distractors = [key, ...vals.filter(v => v !== correct).slice(0, 2)];
          break;
        }
      }
      if (distractors.length < 3) {
        // fallback
        const allWrong = [...new Set(Object.values(LITERATURE_WRONG).flat())];
        distractors = [...distractors, ...randomPick(allWrong.filter(w => w !== correct && !distractors.includes(w)), 3 - distractors.length)];
      }
      q.options = [correct, ...distractors.slice(0, 3)];
      q.answer = 0;
      break;
    }
  }

  return q;
}

/**
 * P1: 修復詞義辨析題的元語言干擾項
 */
function fixVocabDistractors(q, category) {
  if (category !== '詞義辨析') return q;
  if (!q.options || q.options.length < 4) return q;

  const text = q.text;
  const correctIdx = q.answer;
  const correct = q.options[correctIdx];
  const isSynonym = text.includes('近義詞');

  // 找出哪些是元語言詞
  const metaIndices = [];
  q.options.forEach((opt, i) => {
    if (i !== correctIdx && META_WORDS.has(opt)) {
      metaIndices.push(i);
    }
  });

  if (metaIndices.length === 0) return q; // 沒有元語言詞，跳過

  // 為該題生成真實詞彙干擾
  let replacements = [];
  if (isSynonym) {
    // 近義詞題：從 VOCAB_DISTRACTORS 找正確答案的推薦干擾
    if (VOCAB_DISTRACTORS[correct]) {
      replacements = [...VOCAB_DISTRACTORS[correct]];
    }
  } else {
    // 反義詞題：從 ANTONYM_PAIRS 找正確答案的推薦干擾
    if (ANTONYM_PAIRS[correct]) {
      replacements = [...ANTONYM_PAIRS[correct]];
    }
  }

  // 如果沒有預設干擾詞，從對照表隨機取
  if (replacements.length < metaIndices.length) {
    const pool = isSynonym
      ? Object.values(VOCAB_DISTRACTORS).flat()
      : Object.values(ANTONYM_PAIRS).flat();
    const extra = randomPick(
      pool.filter(w => w !== correct && !replacements.includes(w) && !q.options.includes(w)),
      metaIndices.length - replacements.length
    );
    replacements = [...replacements, ...extra];
  }

  // 替換元語言詞
  metaIndices.forEach((idx, i) => {
    if (i < replacements.length) {
      q.options[idx] = replacements[i];
    }
  });

  return q;
}

/**
 * P1: 跨年級去重 — 標記重複題為待處理
 */
function deduplicate(allBanks) {
  // allBanks = { 'P4-R1': [...], 'P5-R1': [...], ... }
  const seen = new Map(); // text_signature → { file, index }
  const dupes = [];

  for (const [key, questions] of Object.entries(allBanks)) {
    questions.forEach((q, idx) => {
      const sig = q.text.trim();
      if (seen.has(sig)) {
        dupes.push({ from: seen.get(sig), to: key, index: idx, text: sig });
      } else {
        seen.set(sig, { key, idx });
      }
    });
  }

  return dupes;
}

/**
 * P2: 加入 metadata
 */
function addMetadata(q, category, grade, round, index, totalInRound) {
  q.id = makeId(grade, round, category, index);
  q.difficulty = getDifficulty(grade, category);
  q.timeLimit = getTimeLimit(category);
  q.explanation = getExplanation(category, q);
  return q;
}

// ============================================================
// 主流程
// ============================================================

function main() {
  console.log('=== 中文至叻挑戰賽 題庫全面改造 ===\n');

  // 1. 備份
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
  const jsonFiles = fs.readdirSync(QUESTIONS_DIR).filter(f => f.endsWith('.json'));
  const banksFile = 'banks.js';

  // Backup
  jsonFiles.forEach(f => {
    fs.copyFileSync(path.join(QUESTIONS_DIR, f), path.join(BACKUP_DIR, f));
  });
  fs.copyFileSync(path.join(QUESTIONS_DIR, banksFile), path.join(BACKUP_DIR, banksFile));
  console.log('✅ 已備份原檔到 backup/');

  // 2. 檔案映射: 檔名 → { grade, round }
  const fileMeta = {
    'genQ-p4.json':  { grade: 'P4', round: 1 },
    'genQ-p5.json':  { grade: 'P5', round: 1 },
    'genQ-p6.json':  { grade: 'P6', round: 1 },
    'genQ2-p4.json': { grade: 'P4', round: 2 },
    'genQ2-p5.json': { grade: 'P5', round: 2 },
    'genQ2-p6.json': { grade: 'P6', round: 2 },
    'genQ3-p4.json': { grade: 'P4', round: 3 },
    'genQ3-p5.json': { grade: 'P5', round: 3 },
    'genQ3-p6.json': { grade: 'P6', round: 3 },
    'genQ-bonus-p4.json': { grade: 'P4', round: 4 },
    'genQ-bonus-p5.json': { grade: 'P5', round: 4 },
    'genQ-bonus-p6.json': { grade: 'P6', round: 4 },
  };

  // 3. 讀取所有題庫
  const allBanks = {};
  for (const [filename, meta] of Object.entries(fileMeta)) {
    const raw = fs.readFileSync(path.join(QUESTIONS_DIR, filename), 'utf-8');
    const questions = JSON.parse(raw);
    allBanks[filename] = { questions, ...meta };
  }
  console.log(`📖 讀取了 ${Object.keys(allBanks).length} 個題庫檔案`);

  // 4. 逐題轉換
  let totalTransformed = 0;
  let distractorsAdded = 0;
  let vocabFixed = 0;

  for (const [filename, data] of Object.entries(allBanks)) {
    const { questions, grade, round } = data;
    
    questions.forEach((q, idx) => {
      const origCategory = q.poem || q.category || '';
      // P0: poem → category
      if (q.poem) {
        q.category = q.poem.replace(/【|】/g, '');
        delete q.poem;
      }
      const category = q.category;

      // P0: 單選項添加干擾項
      if (q.options && q.options.length === 1) {
        addDistractors(q, category, questions);
        distractorsAdded++;
      }

      // P1: 詞義辨析去元語言
      if (category === '詞義辨析') {
        const before = [...q.options];
        fixVocabDistractors(q, category);
        if (before.join(',') !== q.options.join(',')) {
          vocabFixed++;
        }
      }

      // P2: metadata
      addMetadata(q, category, grade, round, idx, questions.length);

      totalTransformed++;
    });
  }

  console.log(`🔄 轉換題目總數: ${totalTransformed}`);
  console.log(`   - 干擾項添加: ${distractorsAdded} 題`);
  console.log(`   - 詞義辨析修正: ${vocabFixed} 題`);

  // 5. P1: 跨年級去重檢測
  const bankForDedup = {};
  for (const [filename, data] of Object.entries(allBanks)) {
    const key = `${data.grade}-R${data.round}`;
    if (!bankForDedup[key]) bankForDedup[key] = [];
    bankForDedup[key] = bankForDedup[key].concat(data.questions);
  }
  const dupes = deduplicate(bankForDedup);
  if (dupes.length > 0) {
    console.log(`\n⚠️  檢測到 ${dupes.length} 條跨年級重複題目:`);
    dupes.slice(0, 10).forEach(d => {
      console.log(`   ${d.from.key}[${d.from.idx}] ↔ ${d.to}[${d.index}]: ${d.text.substring(0, 50)}...`);
    });
    if (dupes.length > 10) console.log(`   ... 還有 ${dupes.length - 10} 條`);
    console.log('   → 保留在低年級版本中，高年級版本標記為可選');
  }

  // 6. 寫回 JSON
  for (const [filename, data] of Object.entries(allBanks)) {
    const outPath = path.join(QUESTIONS_DIR, filename);
    fs.writeFileSync(outPath, JSON.stringify(data.questions, null, 2), 'utf-8');
  }
  console.log('\n💾 已寫回所有 JSON 檔案');

  // 7. 更新 banks.js
  const newBanks = `// 題庫入口 — 按回合 + 年級組織
// Cloudflare Workers ES module — 使用 JSON import

import genQ1P4 from './genQ-p4.json' with { type: 'json' };
import genQ1P5 from './genQ-p5.json' with { type: 'json' };
import genQ1P6 from './genQ-p6.json' with { type: 'json' };

import genQ2P4 from './genQ2-p4.json' with { type: 'json' };
import genQ2P5 from './genQ2-p5.json' with { type: 'json' };
import genQ2P6 from './genQ2-p6.json' with { type: 'json' };

import genQ3P4 from './genQ3-p4.json' with { type: 'json' };
import genQ3P5 from './genQ3-p5.json' with { type: 'json' };
import genQ3P6 from './genQ3-p6.json' with { type: 'json' };

import genQBonusP4 from './genQ-bonus-p4.json' with { type: 'json' };
import genQBonusP5 from './genQ-bonus-p5.json' with { type: 'json' };
import genQBonusP6 from './genQ-bonus-p6.json' with { type: 'json' };

// Round 1: 基礎識記（部首、詞義辨析、成語運用）
export const ROUND_1 = {
  P4: genQ1P4,
  P5: genQ1P5,
  P6: genQ1P6,
};

// Round 2: 理解應用（排句成段、成語填充）
export const ROUND_2 = {
  P4: genQ2P4,
  P5: genQ2P5,
  P6: genQ2P6,
};

// Round 3: 綜合高階（諺語、歇後語、文學名著常識）
export const ROUND_3 = {
  P4: genQ3P4,
  P5: genQ3P5,
  P6: genQ3P6,
};

// Bonus Round: 加分題（錯別字辨析、修辭手法、標點符號、唐詩填充）
export const ROUND_BONUS = {
  P4: genQBonusP4,
  P5: genQBonusP5,
  P6: genQBonusP6,
};

// 向後兼容
export const BANKS = ROUND_1;
export const BANKS_R2 = ROUND_2;
export const BANKS_R3 = ROUND_3;
`;
  fs.writeFileSync(path.join(QUESTIONS_DIR, banksFile), newBanks, 'utf-8');
  console.log('💾 已更新 banks.js（新增 ROUND_BONUS 及向後兼容別名）');

  console.log('\n🎉 全部轉換完成！');
}

main();
