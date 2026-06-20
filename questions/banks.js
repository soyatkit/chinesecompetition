// 題庫入口 — 按回合 + 年級組織
// Cloudflare Workers ES module — 使用 JSON import

import genQP4 from './genQ-p4.json' with { type: 'json' };
import genQP5 from './genQ-p5.json' with { type: 'json' };
import genQP6 from './genQ-p6.json' with { type: 'json' };

import genQ2P4 from './genQ2-p4.json' with { type: 'json' };
import genQ2P5 from './genQ2-p5.json' with { type: 'json' };
import genQ2P6 from './genQ2-p6.json' with { type: 'json' };

import genQ3P4 from './genQ3-p4.json' with { type: 'json' };
import genQ3P5 from './genQ3-p5.json' with { type: 'json' };
import genQ3P6 from './genQ3-p6.json' with { type: 'json' };

export const BANKS = {
  P4: genQP4,
  P5: genQP5,
  P6: genQP6,
};

export const BANKS_R2 = {
  P4: genQ2P4,
  P5: genQ2P5,
  P6: genQ2P6,
};

export const BANKS_R3 = {
  P4: genQ3P4,
  P5: genQ3P5,
  P6: genQ3P6,
};
