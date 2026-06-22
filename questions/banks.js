// 題庫入口 — 按回合 + 年級組織
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
