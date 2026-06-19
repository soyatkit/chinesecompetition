// 中文至叻挑戰賽 — Cloudflare Worker (固定五組 / 三回合版)
// Admin: lyt / lyt

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '*';
    const CORS = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const p = url.pathname;
    function ok(data) { return Response.json({ success: true, ...data }, { headers: CORS }); }
    function err(msg, code) { return Response.json({ success: false, error: msg }, { status: code, headers: CORS }); }
    function auth(req) { return (req.headers.get('Authorization') || '') === 'Bearer lyt:lyt'; }

    // ── SERVE WEBSITE (fetch fresh from GitHub, zero CDN) ──
    if (request.method === 'GET' && (p === '/' || p === '/index.html' || p === '')) {
      try {
        const gh = await fetch('https://raw.githubusercontent.com/soyatkit/chinesepoetry/main/index.html');
        if (gh.ok) {
          const h = await gh.text();
          return new Response(h, {
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, max-age=0', 'Pragma': 'no-cache', 'Expires': '0' },
          });
        }
      } catch (e) {}
    }

    // ── HEALTH ──
    if (p === '/api/health') { const d = (await env.LEADERBOARD.get('top20', 'json')) || []; return ok({ status: 'ok', entries: d.length }); }

    // ── LEADERBOARD ──
    if (p === '/api/leaderboard' && request.method === 'GET') { return ok({ leaderboard: (await env.LEADERBOARD.get('top20', 'json')) || [] }); }
    if (p === '/api/leaderboard' && request.method === 'POST') { return handleLBPost(request, env, CORS); }

    // ── ADMIN LOGIN ──
    if (p === '/api/admin/login' && request.method === 'POST') {
      const { username, password } = await request.json().catch(() => ({}));
      return (username === 'lyt' && password === 'lyt') ? ok({ token: 'lyt:lyt' }) : err('Wrong credentials', 401);
    }

    // ── ADMIN DELETE LB ──
    if (p === '/api/admin/leaderboard' && request.method === 'DELETE') {
      if (!auth(request)) return err('Unauthorized', 401);
      const { index } = await request.json().catch(() => ({}));
      const lb = (await env.LEADERBOARD.get('top20', 'json')) || [];
      if (index != null && index >= 0 && index < lb.length) { lb.splice(index, 1); await env.LEADERBOARD.put('top20', JSON.stringify(lb)); return ok({ leaderboard: lb }); }
      await env.LEADERBOARD.put('top20', JSON.stringify([]));
      return ok({ leaderboard: [] });
    }

    // ── SESSION CREATE ──
    if (p === '/api/session/create' && request.method === 'POST') {
      if (!auth(request)) return err('Unauthorized', 401);
      const { grade, groupCount } = await request.json().catch(() => ({}));
      if (!['P4', 'P5', 'P6'].includes(grade)) return err('Invalid grade', 400);
      const gc = Math.max(2, Math.min(6, Number(groupCount) || 4));
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const letters = 'ABCDEF'.slice(0, gc);
      const groups = {};
      for (const ch of letters) groups[ch] = 0;
      const questions = genQ(grade);
      // Round-robin: assign each question to a group (no overlap)
      const groupQuestions = {};
      const groupCurrentQ = {};
      for (const ch of letters) { groupQuestions[ch] = []; groupCurrentQ[ch] = 0; }
      for (let i = 0; i < questions.length; i++) {
        const g = letters[i % gc];
        groupQuestions[g].push(i);
      }
      const session = {
        code, grade, groupCount: gc,
        state: 'waiting', currentQ: 0,
        questions, groupQuestions, groupCurrentQ,
        groups, history: [],
        createdAt: new Date().toISOString(),
      };
      await env.SESSIONS.put(code, JSON.stringify(session), { expirationTtl: 7200 });
      return ok({ code, grade, groupCount: gc });
    }

    // ── SESSION GET ──
    const sm = p.match(/^\/api\/session\/(\d{6})$/);
    if (sm && request.method === 'GET') {
      const raw = await env.SESSIONS.get(sm[1]);
      if (!raw) return err('Session not found', 404);
      const s = JSON.parse(raw);
      const group = (new URL(request.url)).searchParams.get('group') || '';
      let q = null;
      let qIndex = null;
      let totalForGroup = s.questions.length;
      let gCurrentQ = 0;
      if (s.state === 'playing') {
        let idx;
        if (group && s.groupQuestions && s.groupQuestions[group]) {
          const cq = s.groupCurrentQ ? (s.groupCurrentQ[group] || 0) : 0;
          const gqs = s.groupQuestions[group];
          idx = cq < gqs.length ? gqs[cq] : -1;
          totalForGroup = gqs.length;
          gCurrentQ = cq;
        } else {
          idx = s.currentQ;
        }
        if (idx >= 0 && idx < s.questions.length) {
          const qq = s.questions[idx];
          q = { poem: qq.poem, text: qq.text, options: qq.options, answer: qq.answer };
          qIndex = idx;
        }
      }
      return ok({ code: s.code, grade: s.grade, groupCount: s.groupCount || 4, state: s.state, currentQ: qIndex != null ? qIndex : s.currentQ, totalQ: totalForGroup, gCurrentQ, question: q, groups: s.groups, history: s.history, groupQuestions: s.groupQuestions, groupCurrentQ: s.groupCurrentQ });
    }

    // ── SESSION START ──
    const startM = p.match(/^\/api\/session\/(\d{6})\/start$/);
    if (startM && request.method === 'POST') {
      if (!auth(request)) return err('Unauthorized', 401);
      const raw = await env.SESSIONS.get(startM[1]); if (!raw) return err('Not found', 404);
      const s = JSON.parse(raw); s.state = 'playing'; s.currentQ = 0;
      await env.SESSIONS.put(startM[1], JSON.stringify(s), { expirationTtl: 7200 });
      return ok({});
    }

    // ── SCORE GROUP (per question) ──
    const scoreM = p.match(/^\/api\/session\/(\d{6})\/score$/);
    if (scoreM && request.method === 'POST') {
      if (!auth(request)) return err('Unauthorized', 401);
      const { group, type, delta, round, difficulty, advanceGroup } = await request.json().catch(() => ({}));
      if (!/^[A-F]$/.test(group) || !['correct','wrong','bonus'].includes(type)) return err('Invalid params', 400);
      const raw = await env.SESSIONS.get(scoreM[1]); if (!raw) return err('Not found', 404);
      const s = JSON.parse(raw);
      if (s.state !== 'playing') return err('Game not started', 400);
      const appliedDelta = Number.isFinite(Number(delta))
        ? Number(delta)
        : (type === 'correct' ? 10 : type === 'bonus' ? 20 : -5);
      s.groups[group] = (s.groups[group] || 0) + appliedDelta;
      s.history.push({ q: s.currentQ, group, type, delta: appliedDelta, round: round || null, difficulty: difficulty || null, time: new Date().toISOString() });
      if (advanceGroup && s.groupCurrentQ) {
        s.groupCurrentQ[group] = (s.groupCurrentQ[group] || 0) + 1;
      }
      await env.SESSIONS.put(scoreM[1], JSON.stringify(s), { expirationTtl: 7200 });
      return ok({ groups: s.groups });
    }

    // ── NEXT QUESTION ──
    const nextM = p.match(/^\/api\/session\/(\d{6})\/next$/);
    if (nextM && request.method === 'POST') {
      if (!auth(request)) return err('Unauthorized', 401);
      const raw = await env.SESSIONS.get(nextM[1]); if (!raw) return err('Not found', 404);
      const s = JSON.parse(raw); s.currentQ++;
      if (s.currentQ >= s.questions.length) {
        s.state = 'finished';
        // Save groups to leaderboard
        const lb = (await env.LEADERBOARD.get('top20', 'json')) || [];
        for (const [g, sc] of Object.entries(s.groups)) {
          lb.push({ grade: s.grade, group: g, className: '第' + g + '組', studentNo: '', score: sc, time: new Date().toISOString() });
        }
        lb.sort((a, b) => b.score - a.score || new Date(a.time) - new Date(b.time));
        await env.LEADERBOARD.put('top20', JSON.stringify(lb.slice(0, 50)));
      }
      await env.SESSIONS.put(nextM[1], JSON.stringify(s), { expirationTtl: 7200 });
      return ok({ state: s.state, currentQ: s.currentQ });
    }

    // ── END GAME ──
    const endM = p.match(/^\/api\/session\/(\d{6})\/end$/);
    if (endM && request.method === 'POST') {
      if (!auth(request)) return err('Unauthorized', 401);
      const raw = await env.SESSIONS.get(endM[1]); if (!raw) return err('Not found', 404);
      const s = JSON.parse(raw); s.state = 'finished';
      const lb = (await env.LEADERBOARD.get('top20', 'json')) || [];
      for (const [g, sc] of Object.entries(s.groups)) {
        lb.push({ grade: s.grade, group: g, className: '第' + g + '組', studentNo: '', score: sc, time: new Date().toISOString() });
      }
      lb.sort((a, b) => b.score - a.score || new Date(a.time) - new Date(b.time));
      await env.LEADERBOARD.put('top20', JSON.stringify(lb.slice(0, 50)));
      await env.SESSIONS.put(endM[1], JSON.stringify(s), { expirationTtl: 7200 });
      return ok({});
    }

    return err('Not found', 404);
  },
};

// ========== HELPERS ==========

function genQ(grade) {
  const BANK = {
    P4: [
      {poem:'【部首】',text:'「海」的部首是甚麼？',options:["口", "木", "氵", "火"],answer:2},
      {poem:'【部首】',text:'「跑」的部首是甚麼？',options:["心", "扌", "口", "足"],answer:3},
      {poem:'【部首】',text:'「樹」的部首是甚麼？',options:["火", "金", "木", "氵"],answer:2},
      {poem:'【部首】',text:'「說」的部首是甚麼？',options:["心", "日", "言", "口"],answer:2},
      {poem:'【部首】',text:'「吃」的部首是甚麼？',options:["口", "日", "言", "木"],answer:0},
      {poem:'【部首】',text:'「媽」的部首是甚麼？',options:["木", "女", "口", "心"],answer:1},
      {poem:'【部首】',text:'「河」的部首是甚麼？',options:["金", "氵", "火", "木"],answer:1},
      {poem:'【部首】',text:'「花」的部首是甚麼？',options:["木", "氵", "口", "艹"],answer:3},
      {poem:'【部首】',text:'「打」的部首是甚麼？',options:["心", "口", "木", "扌"],answer:3},
      {poem:'【部首】',text:'「明」的部首是甚麼？',options:["木", "日", "口", "月"],answer:1},
      {poem:'【部首】',text:'「草」的部首是甚麼？',options:["日", "木", "口", "艹"],answer:3},
      {poem:'【部首】',text:'「紅」的部首是甚麼？',options:["日", "糹", "口", "火"],answer:1},
      {poem:'【部首】',text:'「休」的部首是甚麼？',options:["心", "亻", "口", "木"],answer:1},
      {poem:'【部首】',text:'「尖」的部首是甚麼？',options:["大", "小", "口", "木"],answer:1},
      {poem:'【部首】',text:'「字」的部首是甚麼？',options:["子", "木", "口", "宀"],answer:0},
      {poem:'【部首】',text:'「林」的部首是甚麼？',options:["口", "木", "山", "艹"],answer:1},
      {poem:'【部首】',text:'「江」的部首是甚麼？',options:["木", "氵", "工", "口"],answer:1},
      {poem:'【部首】',text:'「好」的部首是甚麼？',options:["口", "木", "子", "女"],answer:3},
      {poem:'【部首】',text:'「時」的部首是甚麼？',options:["日", "月", "寸", "口"],answer:0},
      {poem:'【部首】',text:'「語」的部首是甚麼？',options:["吾", "五", "言", "口"],answer:2},
      {poem:'【部首】',text:'「他」的部首是甚麼？',options:["亻", "口", "木", "也"],answer:0},
      {poem:'【部首】',text:'「亮」的部首是甚麼？',options:["儿", "亠", "口", "日"],answer:1},
      {poem:'【部首】',text:'「星」的部首是甚麼？',options:["木", "口", "生", "日"],answer:3},
      {poem:'【部首】',text:'「秋」的部首是甚麼？',options:["口", "火", "木", "禾"],answer:3},
      {poem:'【部首】',text:'「國」的部首是甚麼？',options:["口", "或", "玉", "囗"],answer:3},
      {poem:'【部首】',text:'「美」的部首是甚麼？',options:["口", "羊", "大", "木"],answer:1},
      {poem:'【部首】',text:'「書」的部首是甚麼？',options:["口", "木", "曰", "聿"],answer:2},
      {poem:'【部首】',text:'「鳥」的部首是甚麼？',options:["火", "鳥", "木", "口"],answer:1},
      {poem:'【部首】',text:'「農」的部首是甚麼？',options:["木", "口", "曲", "辰"],answer:3},
      {poem:'【部首】',text:'「問」的部首是甚麼？',options:["口", "門", "日", "木"],answer:0},
      {poem:'【詞義辨析】',text:'「高興」的近義詞是甚麼？',options:["灰心", "擔心", "傷心", "開心"],answer:3},
      {poem:'【詞義辨析】',text:'「勇敢」的反義詞是甚麼？',options:["膽小", "冷靜", "堅強", "熱情"],answer:0},
      {poem:'【詞義辨析】',text:'「快速」的近義詞是甚麼？',options:["猶豫", "緩慢", "安靜", "迅速"],answer:3},
      {poem:'【詞義辨析】',text:'「美麗」的近義詞是甚麼？',options:["平凡", "漂亮", "醜陋", "普通"],answer:1},
      {poem:'【詞義辨析】',text:'「聰明」的反義詞是甚麼？',options:["智慧", "機智", "愚蠢", "靈活"],answer:2},
      {poem:'【詞義辨析】',text:'「溫暖」的反義詞是甚麼？',options:["炎熱", "溫和", "寒冷", "涼快"],answer:2},
      {poem:'【詞義辨析】',text:'「安靜」的近義詞是甚麼？',options:["吵鬧", "喧嘩", "寧靜", "熱鬧"],answer:2},
      {poem:'【詞義辨析】',text:'「勤力」的近義詞是甚麼？',options:["懶惰", "馬虎", "努力", "隨便"],answer:2},
      {poem:'【詞義辨析】',text:'「輕盈」的反義詞是甚麼？',options:["笨重", "快速", "輕巧", "靈活"],answer:0},
      {poem:'【詞義辨析】',text:'「善良」的近義詞是甚麼？',options:["自私", "仁慈", "兇惡", "殘忍"],answer:1},
      {poem:'【詞義辨析】',text:'「驕傲」的反義詞是甚麼？',options:["自滿", "自大", "謙虛", "自豪"],answer:2},
      {poem:'【詞義辨析】',text:'「堅強」的近義詞是甚麼？',options:["懦弱", "軟弱", "膽小", "剛強"],answer:3},
      {poem:'【詞義辨析】',text:'「粗心」的反義詞是甚麼？',options:["大意", "隨便", "馬虎", "細心"],answer:3},
      {poem:'【詞義辨析】',text:'「寬闊」的近義詞是甚麼？',options:["窄小", "細小", "狹窄", "廣闊"],answer:3},
      {poem:'【詞義辨析】',text:'「悲傷」的近義詞是甚麼？',options:["傷心", "開心", "快樂", "高興"],answer:0},
      {poem:'【詞義辨析】',text:'「珍貴」的近義詞是甚麼？',options:["便宜", "普通", "寶貴", "平凡"],answer:2},
      {poem:'【詞義辨析】',text:'「整齊」的反義詞是甚麼？',options:["潔淨", "整潔", "乾淨", "凌亂"],answer:3},
      {poem:'【詞義辨析】',text:'「仔細」的近義詞是甚麼？',options:["認真", "大意", "隨便", "馬虎"],answer:0},
      {poem:'【詞義辨析】',text:'「悠閒」的近義詞是甚麼？',options:["忙碌", "休閒", "匆忙", "緊張"],answer:1},
      {poem:'【詞義辨析】',text:'「活潑」的反義詞是甚麼？',options:["開朗", "文靜", "快樂", "好動"],answer:1},
      {poem:'【詞義辨析】',text:'「認真」的近義詞是甚麼？',options:["馬虎", "分心", "專心", "散漫"],answer:2},
      {poem:'【詞義辨析】',text:'「骯髒」的反義詞是甚麼？',options:["清潔", "污濁", "混濁", "黑暗"],answer:0},
      {poem:'【詞義辨析】',text:'「興奮」的近義詞是甚麼？',options:["沉悶", "激動", "冷靜", "平靜"],answer:1},
      {poem:'【詞義辨析】',text:'「平靜」的反義詞是甚麼？',options:["寧靜", "安靜", "動盪", "清靜"],answer:2},
      {poem:'【詞義辨析】',text:'「富貴」的反義詞是甚麼？',options:["貧窮", "富裕", "富足", "富有"],answer:0},
      {poem:'【詞義辨析】',text:'「溫柔」的近義詞是甚麼？',options:["粗暴", "溫和", "嚴厲", "兇猛"],answer:1},
      {poem:'【詞義辨析】',text:'「明亮」的反義詞是甚麼？',options:["光亮", "明朗", "昏暗", "光明"],answer:2},
      {poem:'【詞義辨析】',text:'「沉悶」的近義詞是甚麼？',options:["生動", "無聊", "精彩", "有趣"],answer:1},
      {poem:'【詞義辨析】',text:'「緊張」的反義詞是甚麼？',options:["著急", "擔憂", "害怕", "放鬆"],answer:3},
      {poem:'【詞義辨析】',text:'「茂盛」的反義詞是甚麼？',options:["繁榮", "枯萎", "昌盛", "興盛"],answer:1},
      {poem:'【成語運用】',text:'「一心一意」形容甚麼？',options:["做事慢", "做事快", "做事馬虎", "做事專心"],answer:3},
      {poem:'【成語運用】',text:'「井底之蛙」比喻甚麼？',options:["聰明的人", "見識廣博", "勇敢的人", "見識短淺"],answer:3},
      {poem:'【成語運用】',text:'「畫龍點睛」指甚麼？',options:["畫工精細", "說話好聽", "關鍵處添精彩", "字寫得好"],answer:2},
      {poem:'【成語運用】',text:'「對牛彈琴」比喻甚麼？',options:["說話不看對象", "彈琴技術好", "音樂好聽", "牛會聽音樂"],answer:0},
      {poem:'【成語運用】',text:'「馬到功成」形容甚麼？',options:["騎馬高手", "做事順利成功", "喜歡騎馬", "馬跑得快"],answer:1},
      {poem:'【成語運用】',text:'「守株待兔」比喻甚麼？',options:["愛護動物", "保護樹木", "樹下等朋友", "死守經驗不變通"],answer:3},
      {poem:'【成語運用】',text:'「百發百中」形容甚麼？',options:["做事百無一失", "買了很多東西", "中了很多獎", "發射很多箭"],answer:0},
      {poem:'【成語運用】',text:'「九牛一毛」比喻甚麼？',options:["牛很珍貴", "牛的毛很長", "極微小的一部分", "很多牛"],answer:2},
      {poem:'【成語運用】',text:'「舉一反三」是甚麼意思？',options:["反覆練習", "觸類旁通", "舉起東西", "三個一起做"],answer:1},
      {poem:'【成語運用】',text:'「半途而廢」指甚麼？',options:["做事中途放棄", "路上休息", "走到一半", "走得很慢"],answer:0},
      {poem:'【成語運用】',text:'「自相矛盾」比喻甚麼？',options:["盾牌很硬", "矛很尖銳", "用矛刺盾", "說話前後不一"],answer:3},
      {poem:'【成語運用】',text:'「鶴立雞群」比喻甚麼？',options:["鶴很高", "才能出眾", "動物園", "雞很矮"],answer:1},
      {poem:'【成語運用】',text:'「一鳴驚人」形容甚麼？',options:["突然有出色表現", "突然嚇到人", "鳥叫很大聲", "聲音很好聽"],answer:0},
      {poem:'【成語運用】',text:'「大公無私」形容甚麼？',options:["公開做事", "沒有私人物品", "很大方", "做事公正不偏私"],answer:3},
      {poem:'【成語運用】',text:'「聚沙成塔」比喻甚麼？',options:["積少成多", "沙子變成塔", "塔是由沙造的", "沙子很多"],answer:0},
      {poem:'【成語運用】',text:'「三心兩意」形容甚麼？',options:["很專心", "兩種意見", "三個想法", "猶豫不決"],answer:3},
      {poem:'【成語運用】',text:'「獨一無二」形容甚麼？',options:["不是第二", "絕無僅有", "兩個人", "只有一個"],answer:1},
      {poem:'【成語運用】',text:'「一竅不通」形容甚麼？',options:["完全不懂", "一條路", "鼻子不通", "一個孔"],answer:0},
      {poem:'【成語運用】',text:'「理所當然」是甚麼意思？',options:["當然是對的", "按部就班", "理論很正確", "按道理該當如此"],answer:3},
      {poem:'【成語運用】',text:'「口是心非」形容甚麼？',options:["口和心不同", "心在跳", "說得很好", "心口不一"],answer:3},
      {poem:'【成語運用】',text:'「千辛萬苦」形容甚麼？',options:["很甜", "非常辛苦", "很辣", "很多味道"],answer:1},
      {poem:'【成語運用】',text:'「根深蒂固」比喻甚麼？',options:["基礎牢固穩固", "樹根很深", "花果很香", "根和花蒂"],answer:0},
      {poem:'【成語運用】',text:'「目不轉睛」形容甚麼？',options:["視力很好", "注意力集中", "眼睛不會轉", "眼角膜很強"],answer:1},
      {poem:'【成語運用】',text:'「口若懸河」形容甚麼？',options:["口很乾", "口掛在河上", "河從口流出", "說話滔滔不絕"],answer:3},
      {poem:'【成語運用】',text:'「千鈞一髮」比喻甚麼？',options:["情況十分危急", "很多鈞", "一千斤", "一根頭髮"],answer:0},
      {poem:'【成語運用】',text:'「不翼而飛」形容甚麼？',options:["飛不起來", "鳥沒有翅膀", "翅膀掉了", "東西無故消失"],answer:3},
      {poem:'【成語運用】',text:'「七上八下」形容甚麼？',options:["七個人上八個人下", "心中忐忑不安", "上下樓梯", "七次上下"],answer:1},
      {poem:'【成語運用】',text:'「心花怒放」形容甚麼？',options:["極度高興", "花開了", "花怒放", "心生氣"],answer:0},
      {poem:'【成語運用】',text:'「一目十行」形容甚麼？',options:["十行字", "看不清", "一隻眼睛", "看書速度很快"],answer:3},
      {poem:'【成語運用】',text:'「以身作則」是甚麼意思？',options:["用身體工作", "遵守規則", "以自己為榜樣", "做規則"],answer:2},
      {poem:'【詞語填充】',text:'雖然天氣轉壞，但同學們仍然＿＿秩序。',options:["保持", "破壞", "擾亂", "忘記"],answer:0},
      {poem:'【詞語填充】',text:'哥哥做事一向很＿＿。',options:["隨便", "馬虎", "懶惰", "認真"],answer:3},
      {poem:'【詞語填充】',text:'這篇文章內容＿＿。',options:["簡短", "貧乏", "豐富", "無聊"],answer:2},
      {poem:'【詞語填充】',text:'我們要＿＿環境，不亂拋垃圾。',options:["弄髒", "污染", "破壞", "愛護"],answer:3},
      {poem:'【詞語填充】',text:'老師＿＿我們要好好學習。',options:["責罵", "批評", "教導", "懲罰"],answer:2},
      {poem:'【詞語填充】',text:'春天到了，花園裡的花都＿＿了。',options:["枯萎", "凋謝", "盛開", "掉落"],answer:2},
      {poem:'【詞語填充】',text:'他每天都＿＿練習，終於取得了好成績。',options:["懶惰", "馬虎", "努力", "隨便"],answer:2},
      {poem:'【詞語填充】',text:'這本書的內容十分＿＿。',options:["沉悶", "難懂", "有趣", "無聊"],answer:2},
      {poem:'【詞語填充】',text:'媽媽＿＿了一桌好菜。',options:["丟棄", "浪費", "破壞", "準備"],answer:3},
      {poem:'【詞語填充】',text:'同學們在運動會上＿＿了獎牌。',options:["獲得", "浪費", "丟棄", "失去"],answer:0},
      {poem:'【詞語填充】',text:'這條小路十分＿＿。',options:["寬闊", "平坦", "狹窄", "筆直"],answer:2},
      {poem:'【詞語填充】',text:'她唱的歌聲十分＿＿。',options:["動聽", "吵鬧", "難聽", "刺耳"],answer:0},
      {poem:'【詞語填充】',text:'天色漸漸＿＿下來。',options:["暗", "亮", "白", "明"],answer:0},
      {poem:'【詞語填充】',text:'這道題目很＿＿。',options:["簡單", "困難", "容易", "複雜"],answer:0},
      {poem:'【詞語填充】',text:'小貓＿＿在沙發上曬太陽。',options:["跑", "站", "跳", "躺"],answer:3},
      {poem:'【詞語填充】',text:'爸爸＿＿了一封重要的信。',options:["寫好", "寄出", "扔掉", "收到"],answer:3},
      {poem:'【詞語填充】',text:'這座山非常＿＿。',options:["平", "矮", "高", "低"],answer:2},
      {poem:'【詞語填充】',text:'弟弟＿＿了媽媽的手不放。',options:["拉著", "推開", "放開", "鬆開"],answer:0},
      {poem:'【詞語填充】',text:'秋天到了，樹葉都＿＿了。',options:["變綠", "變紅", "變黃", "變藍"],answer:2},
      {poem:'【詞語填充】',text:'這件衣服的顏色很＿＿。',options:["沉悶", "鮮豔", "暗淡", "單調"],answer:1},
      {poem:'【詞語填充】',text:'他＿＿地完成了所有功課。',options:["困難", "艱難", "辛苦", "順利"],answer:3},
      {poem:'【詞語填充】',text:'公園裡開滿了＿＿的花朵。',options:["普通", "醜陋", "美麗", "平凡"],answer:2},
      {poem:'【詞語填充】',text:'小朋友＿＿地聽老師講故事。',options:["隨便", "專心", "散漫", "分心"],answer:1},
      {poem:'【詞語填充】',text:'這棟大樓十分＿＿。',options:["宏偉", "簡陋", "矮小", "破舊"],answer:0},
      {poem:'【詞語填充】',text:'她把房間整理得很＿＿。',options:["整潔", "骯髒", "混亂", "凌亂"],answer:0},
      {poem:'【詞語填充】',text:'______的天空中飄著幾朵白雲。',options:["灰暗", "陰沉", "蔚藍", "漆黑"],answer:2},
      {poem:'【詞語填充】',text:'這碗湯的味道很＿＿。',options:["淡而無味", "苦澀", "鮮美", "難喝"],answer:2},
      {poem:'【詞語填充】',text:'每天＿＿運動對身體有好處。',options:["過度", "暴力", "適量", "勉強"],answer:2},
      {poem:'【詞語填充】',text:'圖書館裡十分＿＿。',options:["安靜", "嘈雜", "喧嘩", "吵鬧"],answer:0},
      {poem:'【詞語填充】',text:'老師＿＿地解答同學的疑問。',options:["耐心", "馬虎", "隨便", "煩躁"],answer:0},
      {poem:'【修辭辨識】',text:'「月亮像彎彎的小船」用了甚麼修辭？',options:["排比", "比喻", "誇張", "擬人"],answer:1},
      {poem:'【修辭辨識】',text:'「微風吹過，花兒點頭微笑」用了甚麼修辭？',options:["比喻", "擬人", "反問", "設問"],answer:1},
      {poem:'【修辭辨識】',text:'「他跑得比風還快」用了甚麼修辭？',options:["排比", "比喻", "對偶", "誇張"],answer:3},
      {poem:'【修辭辨識】',text:'「我愛閱讀，愛思考，愛寫作」用了甚麼修辭？',options:["比喻", "擬人", "排比", "反問"],answer:2},
      {poem:'【修辭辨識】',text:'「這樣美麗怎能不喜愛呢」用了甚麼修辭？',options:["比喻", "設問", "排比", "反問"],answer:3},
      {poem:'【修辭辨識】',text:'「甚麼是友誼？友誼就是互相幫助」用了甚麼修辭？',options:["設問", "排比", "比喻", "反問"],answer:0},
      {poem:'【修辭辨識】',text:'「盼望著盼望著，春天來了」用了甚麼修辭？',options:["排比", "比喻", "誇張", "反覆"],answer:3},
      {poem:'【修辭辨識】',text:'「天對地，雨對風」用了甚麼修辭？',options:["擬人", "比喻", "排比", "對偶"],answer:3},
      {poem:'【修辭辨識】',text:'「太陽像大火球掛在天上」用了甚麼修辭？',options:["比喻", "排比", "擬人", "誇張"],answer:0},
      {poem:'【修辭辨識】',text:'「風兒輕輕地唱著歌」用了甚麼修辭？',options:["設問", "比喻", "排比", "擬人"],answer:3},
      {poem:'【修辭辨識】',text:'「他力氣大得像一頭牛」用了甚麼修辭？',options:["對偶", "擬人", "誇張", "比喻"],answer:2},
      {poem:'【修辭辨識】',text:'「讀書好，讀好書，好讀書」用了甚麼修辭？',options:["反覆", "排比", "對偶", "比喻"],answer:1},
      {poem:'【修辭辨識】',text:'「我們不是好朋友嗎」用了甚麼修辭？',options:["反問", "設問", "比喻", "排比"],answer:0},
      {poem:'【修辭辨識】',text:'「甚麼是幸福？幸福就是一家人在一起」用了甚麼修辭？',options:["反問", "設問", "擬人", "排比"],answer:1},
      {poem:'【修辭辨識】',text:'「加油加油，我們一定能贏」用了甚麼修辭？',options:["比喻", "對偶", "反覆", "排比"],answer:2},
      {poem:'【修辭辨識】',text:'「紅花配綠葉，藍天襯白雲」用了甚麼修辭？',options:["排比", "對偶", "比喻", "擬人"],answer:1},
      {poem:'【修辭辨識】',text:'「星星像鑽石般閃爍」用了甚麼修辭？',options:["比喻", "擬人", "誇張", "排比"],answer:0},
      {poem:'【修辭辨識】',text:'「小鳥在唱歌」用了甚麼修辭？',options:["擬人", "比喻", "排比", "誇張"],answer:0},
      {poem:'【修辭辨識】',text:'「他跑得比火箭還快」用了甚麼修辭？',options:["比喻", "排比", "反問", "誇張"],answer:3},
      {poem:'【修辭辨識】',text:'「春天來了花開了草綠了」用了甚麼修辭？',options:["比喻", "排比", "對偶", "擬人"],answer:1},
      {poem:'【修辭辨識】',text:'「難道這不是事實嗎」用了甚麼修辭？',options:["設問", "比喻", "反問", "排比"],answer:2},
      {poem:'【修辭辨識】',text:'「甚麼是勇氣？勇氣就是面對困難不退縮」用了甚麼修辭？',options:["設問", "比喻", "反問", "擬人"],answer:0},
      {poem:'【修辭辨識】',text:'「快來快來，遊戲要開始了」用了甚麼修辭？',options:["對偶", "排比", "反覆", "比喻"],answer:2},
      {poem:'【修辭辨識】',text:'「日出而作，日落而息」用了甚麼修辭？',options:["比喻", "對偶", "擬人", "排比"],answer:1},
      {poem:'【修辭辨識】',text:'「那棵大樹像一把傘」用了甚麼修辭？',options:["反問", "擬人", "設問", "比喻"],answer:3},
      {poem:'【修辭辨識】',text:'「太陽公公起床了」用了甚麼修辭？',options:["排比", "比喻", "誇張", "擬人"],answer:3},
      {poem:'【修辭辨識】',text:'「這朵花比山還高」用了甚麼修辭？',options:["排比", "誇張", "比喻", "擬人"],answer:1},
      {poem:'【修辭辨識】',text:'「有藍天有白雲有清風」用了甚麼修辭？',options:["反問", "排比", "擬人", "設問"],answer:1},
      {poem:'【修辭辨識】',text:'「你不覺得今天很熱嗎」用了甚麼修辭？',options:["反問", "設問", "比喻", "排比"],answer:0},
      {poem:'【修辭辨識】',text:'「努力努力，成功就在眼前」用了甚麼修辭？',options:["排比", "擬人", "對偶", "反覆"],answer:3},
      {poem:'【唐詩理解】',text:'《靜夜思》的作者是誰？',options:["杜甫", "李白", "王維", "白居易"],answer:1},
      {poem:'【唐詩理解】',text:'「舉頭望明月」下一句？',options:["粒粒皆辛苦", "低頭思故鄉", "疑是地上霜", "處處聞啼鳥"],answer:1},
      {poem:'【唐詩理解】',text:'「白日依山盡」下一句？',options:["更上一層樓", "黃河入海流", "花落知多少", "低頭思故鄉"],answer:1},
      {poem:'【唐詩理解】',text:'《登鸛雀樓》作者？',options:["王之渙", "杜甫", "孟浩然", "李白"],answer:0},
      {poem:'【唐詩理解】',text:'「春眠不覺曉」出自？',options:["《憫農》", "《春曉》", "《登鸛雀樓》", "《靜夜思》"],answer:1},
      {poem:'【唐詩理解】',text:'《春曉》作者？',options:["杜甫", "王維", "孟浩然", "李白"],answer:2},
      {poem:'【唐詩理解】',text:'「花落知多少」出自？',options:["《相思》", "《詠鵝》", "《春曉》", "《靜夜思》"],answer:2},
      {poem:'【唐詩理解】',text:'「處處聞啼鳥」描寫甚麼季節？',options:["冬天", "夏天", "秋天", "春天"],answer:3},
      {poem:'【唐詩理解】',text:'《詠鵝》作者？',options:["王維", "李白", "駱賓王", "杜甫"],answer:2},
      {poem:'【唐詩理解】',text:'「曲項向天歌」描寫甚麼？',options:["鵝在飛", "鵝在睡", "鵝在吃", "鵝彎頸唱歌"],answer:3},
      {poem:'【唐詩理解】',text:'《憫農》作者？',options:["李白", "杜甫", "王維", "李紳"],answer:3},
      {poem:'【唐詩理解】',text:'「粒粒皆辛苦」提醒我們？',options:["好好讀書", "珍惜糧食", "多吃飯", "努力耕田"],answer:1},
      {poem:'【唐詩理解】',text:'《相思》作者？',options:["杜甫", "李白", "孟浩然", "王維"],answer:3},
      {poem:'【唐詩理解】',text:'「紅豆生南國」紅豆象徵？',options:["財富", "好運", "健康", "思念"],answer:3},
      {poem:'【唐詩理解】',text:'《鹿柴》作者？',options:["王維", "杜甫", "駱賓王", "李白"],answer:0},
      {poem:'【唐詩理解】',text:'「空山不見人」描寫？',options:["繁華市場", "熱鬧城市", "寧靜山林", "廣闊大海"],answer:2},
      {poem:'【唐詩理解】',text:'「床前明月光」出自？',options:["《春曉》", "《詠鵝》", "《登鸛雀樓》", "《靜夜思》"],answer:3},
      {poem:'【唐詩理解】',text:'「夜來風雨聲」作者？',options:["王之渙", "王維", "孟浩然", "李白"],answer:2},
      {poem:'【唐詩理解】',text:'「欲窮千里目」下一句？',options:["低頭思故鄉", "春眠不覺曉", "黃河入海流", "更上一層樓"],answer:3},
      {poem:'【唐詩理解】',text:'「不知細葉誰裁出」出自？',options:["《靜夜思》", "《相思》", "《春曉》", "《詠柳》"],answer:3},
      {poem:'【唐詩理解】',text:'《登鸛雀樓》描寫景物？',options:["夕陽黃河高山", "草原", "大海", "長江"],answer:0},
      {poem:'【唐詩理解】',text:'「春風吹又生」前一句？',options:["野火燒不盡", "白日依山盡", "床前明月光", "春眠不覺曉"],answer:0},
      {poem:'【唐詩理解】',text:'《敕勒歌》描寫？',options:["海上風景", "城市風光", "山林景色", "草原風光"],answer:3},
      {poem:'【唐詩理解】',text:'「少小離家老大回」作者？',options:["杜甫", "賀知章", "李白", "王維"],answer:1},
      {poem:'【唐詩理解】',text:'《望廬山瀑布》作者？',options:["王維", "李白", "王之渙", "杜甫"],answer:1},
      {poem:'【唐詩理解】',text:'「疑是銀河落九天」形容？',options:["泉水", "河水", "瀑布", "雨水"],answer:2},
      {poem:'【唐詩理解】',text:'《絕句》「兩個黃鸝」作者？',options:["王維", "李白", "杜甫", "孟浩然"],answer:2},
      {poem:'【唐詩理解】',text:'《楓橋夜泊》「姑蘇城」即今？',options:["南京", "蘇州", "揚州", "杭州"],answer:1},
      {poem:'【唐詩理解】',text:'「白毛浮綠水」出自？',options:["《詠鵝》", "《相思》", "《春曉》", "《靜夜思》"],answer:0},
      {poem:'【唐詩理解】',text:'《早發白帝城》作者？',options:["王之渙", "王維", "杜甫", "李白"],answer:3},
      {poem:'【標點符號】',text:'妹妹說＿＿「我要看書」填甚麼？',options:["！", "。", "：", "，"],answer:2},
      {poem:'【標點符號】',text:'公園＿＿圖書館和泳池填甚麼？',options:["、", "。", "！", "："],answer:0},
      {poem:'【標點符號】',text:'這本書真好看＿＿填甚麼？',options:["？", "，", "。", "！"],answer:3},
      {poem:'【標點符號】',text:'你吃飯了嗎＿＿填甚麼？',options:["？", "。", "：", "！"],answer:0},
      {poem:'【標點符號】',text:'今天天氣很好＿＿填甚麼？',options:["，", "！", "。", "？"],answer:2},
      {poem:'【標點符號】',text:'媽媽說＿＿「時間到了」填甚麼？',options:["，", "？", "：", "。"],answer:2},
      {poem:'【標點符號】',text:'我買了蘋果＿＿橙和香蕉',options:["：", "，", "。", "、"],answer:3},
      {poem:'【標點符號】',text:'這朵花真美＿＿',options:["。", "！", "，", "？"],answer:1},
      {poem:'【標點符號】',text:'小明＿＿小華和小強',options:["。", "：", "，", "、"],answer:3},
      {poem:'【標點符號】',text:'你好＿＿',options:["？", "。", "！", "，"],answer:2},
      {poem:'【標點符號】',text:'他跑得很快＿＿',options:["。", "：", "！", "？"],answer:0},
      {poem:'【標點符號】',text:'老師問＿＿「誰知道答案」',options:["，", "！", "：", "。"],answer:2},
      {poem:'【標點符號】',text:'鉛筆＿＿擦膠和尺子',options:["，", "：", "。", "、"],answer:3},
      {poem:'【標點符號】',text:'太好了＿＿',options:["？", "。", "！", "："],answer:2},
      {poem:'【標點符號】',text:'你叫甚麼名字＿＿',options:["！", "，", "？", "。"],answer:2},
      {poem:'【標點符號】',text:'太陽出來了＿＿',options:["！", "。", "？", "："],answer:1},
      {poem:'【標點符號】',text:'他說＿＿「我明白了」',options:["，", "：", "。", "？"],answer:1},
      {poem:'【標點符號】',text:'爸爸＿＿媽媽和我',options:["。", "，", "：", "、"],answer:3},
      {poem:'【標點符號】',text:'真了不起＿＿',options:["？", "。", "！", "："],answer:2},
      {poem:'【標點符號】',text:'你去哪裡＿＿',options:["？", "。", "！", "，"],answer:0},
      {poem:'【標點符號】',text:'花兒開了＿＿',options:["？", "！", "：", "。"],answer:3},
      {poem:'【標點符號】',text:'校長說＿＿「歡迎新同學」',options:["！", "。", "，", "："],answer:3},
      {poem:'【標點符號】',text:'書本＿＿筆記和文具',options:["、", "，", "。", "："],answer:0},
      {poem:'【標點符號】',text:'太棒了＿＿',options:["？", "！", "。", "："],answer:1},
      {poem:'【標點符號】',text:'誰在敲門＿＿',options:["。", "！", "？", "，"],answer:2},
      {poem:'【標點符號】',text:'今天星期一＿＿',options:["：", "。", "？", "！"],answer:1},
      {poem:'【標點符號】',text:'她說＿＿「我愛看書」',options:["？", "：", "，", "。"],answer:1},
      {poem:'【標點符號】',text:'中文＿＿英文和數學',options:["，", "：", "、", "。"],answer:2},
      {poem:'【標點符號】',text:'祝你生日快樂＿＿',options:["。", "：", "？", "！"],answer:3},
      {poem:'【標點符號】',text:'這條路通哪裡＿＿',options:["。", "，", "？", "！"],answer:2},
      {poem:'【找錯字】',text:'「草莓和平果」改正？',options:["莓→梅", "平→蘋", "草→早", "果→菓"],answer:1},
      {poem:'【找錯字】',text:'「操塲」改正？',options:["塲→場", "早→找", "會→匯", "操→澡"],answer:0},
      {poem:'【找錯字】',text:'「安靖」改正？',options:["靖→靜", "看→著", "安→按", "專→轉"],answer:0},
      {poem:'【找錯字】',text:'「公圍」改正？',options:["門→們", "圍→園", "看→著", "公→工"],answer:1},
      {poem:'【找錯字】',text:'「己經」改正？',options:["人→入", "天→夫", "經→徑", "己→已"],answer:3},
      {poem:'【找錯字】',text:'「在見」改正？',options:["見→建", "在→再", "人→入", "天→夫"],answer:1},
      {poem:'【找錯字】',text:'「以經」改正？',options:["人→入", "經→徑", "天→夫", "以→已"],answer:3},
      {poem:'【找錯字】',text:'「希忘」改正？',options:["希→喜", "人→入", "忘→望", "天→夫"],answer:2},
      {poem:'【找錯字】',text:'「煩腦」改正？',options:["天→夫", "人→入", "腦→惱", "煩→凡"],answer:2},
      {poem:'【找錯字】',text:'「成積」改正？',options:["成→城", "積→績", "天→夫", "人→入"],answer:1},
      {poem:'【找錯字】',text:'「辛福」改正？',options:["人→入", "辛→幸", "天→夫", "福→富"],answer:1},
      {poem:'【找錯字】',text:'「因該」改正？',options:["該→孩", "天→夫", "因→應", "人→入"],answer:2},
      {poem:'【找錯字】',text:'「形狀」改正？',options:["天→夫", "人→入", "狀→壯", "形→型"],answer:3},
      {poem:'【找錯字】',text:'「浪廢」改正？',options:["浪→朗", "廢→費", "人→入", "天→夫"],answer:1},
      {poem:'【找錯字】',text:'「密蜂」改正？',options:["人→入", "天→夫", "密→蜜", "蜂→峰"],answer:2},
      {poem:'【找錯字】',text:'「然果」改正？',options:["然→如", "果→裹", "人→入", "天→夫"],answer:0},
      {poem:'【找錯字】',text:'「到處」改正？',options:["人→入", "天→夫", "到→倒", "處→外"],answer:2},
      {poem:'【找錯字】',text:'「免強」改正？',options:["天→夫", "強→牆", "人→入", "免→勉"],answer:3},
      {poem:'【找錯字】',text:'「旦糕」改正？',options:["旦→蛋", "天→夫", "人→入", "糕→羔"],answer:0},
      {poem:'【找錯字】',text:'「知到」改正？',options:["天→夫", "人→入", "知→智", "到→道"],answer:3},
      {poem:'【找錯字】',text:'「年記」改正？',options:["天→夫", "人→入", "記→紀", "年→丰"],answer:2},
      {poem:'【找錯字】',text:'「辯子」改正？',options:["人→入", "天→夫", "子→仔", "辯→辮"],answer:3},
      {poem:'【找錯字】',text:'「題目」改正？',options:["人→入", "題→提", "天→夫", "目→日"],answer:1},
      {poem:'【找錯字】',text:'「自乙」改正？',options:["乙→己", "人→入", "自→字", "天→夫"],answer:0},
      {poem:'【找錯字】',text:'「澡堂」課室改正？',options:["堂→常", "人→入", "澡→課", "天→夫"],answer:2},
      {poem:'【找錯字】',text:'「元旦」改正？',options:["人→入", "天→夫", "旦→蛋", "元→完"],answer:3},
      {poem:'【找錯字】',text:'「文張」改正？',options:["人→入", "張→章", "文→交", "天→夫"],answer:1},
      {poem:'【找錯字】',text:'「運氣」改正？',options:["人→入", "天→夫", "氣→汽", "運→運"],answer:3},
      {poem:'【找錯字】',text:'「菜籃子」改正？',options:["子→仔", "籃→藍", "菜→菜", "天→夫"],answer:2},
      {poem:'【找錯字】',text:'「講故」改正？',options:["故→故", "講→構", "人→入", "天→夫"],answer:0}
    ],
    P5: [
      {poem:'【部首】',text:'「懶」的部首是甚麼？',options:["亻", "女", "心", "忄"],answer:3},
      {poem:'【部首】',text:'「鋼」的部首是甚麼？',options:["水", "火", "金", "木"],answer:2},
      {poem:'【部首】',text:'「裁」的部首是甚麼？',options:["戈", "衣", "刀", "木"],answer:1},
      {poem:'【部首】',text:'「腸」的部首是甚麼？',options:["木", "口", "月", "肉"],answer:2},
      {poem:'【部首】',text:'「鍋」的部首是甚麼？',options:["木", "金", "火", "口"],answer:1},
      {poem:'【部首】',text:'「島」的部首是甚麼？',options:["口", "木", "鳥", "山"],answer:3},
      {poem:'【部首】',text:'「霧」的部首是甚麼？',options:["口", "務", "木", "雨"],answer:3},
      {poem:'【部首】',text:'「箱」的部首是甚麼？',options:["金", "木", "口", "竹"],answer:3},
      {poem:'【部首】',text:'「蓋」的部首是甚麼？',options:["口", "艹", "皿", "木"],answer:1},
      {poem:'【部首】',text:'「箭」的部首是甚麼？',options:["竹", "前", "木", "金"],answer:0},
      {poem:'【部首】',text:'「鏡」的部首是甚麼？',options:["竟", "金", "木", "口"],answer:1},
      {poem:'【部首】',text:'「幫」的部首是甚麼？',options:["口", "巾", "邦", "木"],answer:1},
      {poem:'【部首】',text:'「腦」的部首是甚麼？',options:["月", "木", "心", "口"],answer:0},
      {poem:'【部首】',text:'「酸」的部首是甚麼？',options:["口", "木", "酉", "水"],answer:2},
      {poem:'【部首】',text:'「醒」的部首是甚麼？',options:["木", "酉", "星", "口"],answer:1},
      {poem:'【部首】',text:'「鼻」的部首是甚麼？',options:["鼻", "木", "心", "口"],answer:0},
      {poem:'【部首】',text:'「齒」的部首是甚麼？',options:["牙", "口", "木", "齒"],answer:3},
      {poem:'【部首】',text:'「默」的部首是甚麼？',options:["黑", "口", "木", "犬"],answer:3},
      {poem:'【部首】',text:'「關」的部首是甚麼？',options:["心", "木", "門", "口"],answer:2},
      {poem:'【部首】',text:'「麗」的部首是甚麼？',options:["木", "日", "口", "鹿"],answer:3},
      {poem:'【部首】',text:'「鼠」的部首是甚麼？',options:["心", "口", "鼠", "木"],answer:2},
      {poem:'【部首】',text:'「鼓」的部首是甚麼？',options:["木", "口", "皮", "鼓"],answer:3},
      {poem:'【部首】',text:'「康」的部首是甚麼？',options:["广", "隶", "木", "口"],answer:0},
      {poem:'【部首】',text:'「愛」的部首是甚麼？',options:["木", "心", "口", "爪"],answer:1},
      {poem:'【部首】',text:'「器」的部首是甚麼？',options:["心", "犬", "木", "口"],answer:3},
      {poem:'【部首】',text:'「鬧」的部首是甚麼？',options:["鬥", "門", "口", "木"],answer:0},
      {poem:'【部首】',text:'「鹽」的部首是甚麼？',options:["木", "鹵", "皿", "口"],answer:1},
      {poem:'【部首】',text:'「鬱」的部首是甚麼？',options:["心", "鬯", "木", "口"],answer:1},
      {poem:'【部首】',text:'「襲」的部首是甚麼？',options:["木", "衣", "龍", "口"],answer:1},
      {poem:'【部首】',text:'「鑑」的部首是甚麼？',options:["金", "木", "石", "竹"],answer:0},
      {poem:'【詞義辨析】',text:'「珍貴」的近義詞？',options:["平凡", "寶貴", "便宜", "普通"],answer:1},
      {poem:'【詞義辨析】',text:'「炎熱」的反義詞？',options:["酷熱", "涼快", "溫暖", "寒冷"],answer:3},
      {poem:'【詞義辨析】',text:'「清楚」的近義詞？',options:["複雜", "明白", "模糊", "混亂"],answer:1},
      {poem:'【詞義辨析】',text:'「猶豫」的近義詞？',options:["決斷", "乾脆", "遲疑", "果斷"],answer:2},
      {poem:'【詞義辨析】',text:'「敏捷」的近義詞？',options:["緩慢", "笨拙", "呆板", "靈活"],answer:3},
      {poem:'【詞義辨析】',text:'「虛偽」的反義詞？',options:["真誠", "偽裝", "虛假", "欺騙"],answer:0},
      {poem:'【詞義辨析】',text:'「慷慨」的反義詞？',options:["吝嗇", "大方", "貧窮", "富有"],answer:0},
      {poem:'【詞義辨析】',text:'「勤奮」的近義詞？',options:["怠慢", "懶惰", "努力", "馬虎"],answer:2},
      {poem:'【詞義辨析】',text:'「融洽」的近義詞？',options:["爭吵", "矛盾", "和睦", "衝突"],answer:2},
      {poem:'【詞義辨析】',text:'「慚愧」的近義詞？',options:["自豪", "內疚", "自滿", "驕傲"],answer:1},
      {poem:'【詞義辨析】',text:'「遼闊」的近義詞？',options:["狹窄", "細小", "廣闊", "窄小"],answer:2},
      {poem:'【詞義辨析】',text:'「沉默」的反義詞？',options:["寧靜", "清靜", "多言", "安靜"],answer:2},
      {poem:'【詞義辨析】',text:'「狹窄」的反義詞？',options:["窄小", "寬廣", "細小", "微小"],answer:1},
      {poem:'【詞義辨析】',text:'「稱讚」的反義詞？',options:["批評", "表揚", "誇獎", "讚揚"],answer:0},
      {poem:'【詞義辨析】',text:'「繁榮」的近義詞？',options:["沒落", "衰落", "衰敗", "興盛"],answer:3},
      {poem:'【詞義辨析】',text:'「愚笨」的反義詞？',options:["聰明", "笨拙", "遲鈍", "愚蠢"],answer:0},
      {poem:'【詞義辨析】',text:'「團結」的近義詞？',options:["合群", "分散", "分裂", "分開"],answer:0},
      {poem:'【詞義辨析】',text:'「責備」的反義詞？',options:["指責", "批評", "責罵", "寬恕"],answer:3},
      {poem:'【詞義辨析】',text:'「粗魯」的反義詞？',options:["粗野", "文雅", "野蠻", "粗暴"],answer:1},
      {poem:'【詞義辨析】',text:'「節省」的反義詞？',options:["奢侈", "節約", "節儉", "節制"],answer:0},
      {poem:'【詞義辨析】',text:'「倔強」的近義詞？',options:["順從", "固執", "聽話", "溫順"],answer:1},
      {poem:'【詞義辨析】',text:'「擔憂」的近義詞？',options:["安心", "焦慮", "寬心", "放心"],answer:1},
      {poem:'【詞義辨析】',text:'「幼稚」的反義詞？',options:["單純", "成熟", "可愛", "天真"],answer:1},
      {poem:'【詞義辨析】',text:'「傲慢」的反義詞？',options:["自大", "自私", "謙虛", "驕傲"],answer:2},
      {poem:'【詞義辨析】',text:'「靈巧」的近義詞？',options:["遲鈍", "機靈", "笨拙", "呆板"],answer:1},
      {poem:'【詞義辨析】',text:'「厭惡」的反義詞？',options:["憎恨", "喜愛", "反感", "討厭"],answer:1},
      {poem:'【詞義辨析】',text:'「狹隘」的反義詞？',options:["狹窄", "窄小", "開闊", "微小"],answer:2},
      {poem:'【詞義辨析】',text:'「腐敗」的反義詞？',options:["腐朽", "腐化", "清廉", "墮落"],answer:2},
      {poem:'【詞義辨析】',text:'「浮躁」的反義詞？',options:["急躁", "輕浮", "沉穩", "衝動"],answer:2},
      {poem:'【詞義辨析】',text:'「嚴厲」的近義詞？',options:["嚴格", "慈祥", "溫柔", "溫和"],answer:0},
      {poem:'【成語運用】',text:'「專心致志」形容？',options:["害怕退縮", "做事專注", "三心兩意", "馬虎了事"],answer:1},
      {poem:'【成語運用】',text:'「畫蛇添足」比喻？',options:["畫得很好", "完美無缺", "錦上添花", "多此一舉"],answer:3},
      {poem:'【成語運用】',text:'「津津有味」形容？',options:["吃很飽", "很有滋味", "吃很快", "味很淡"],answer:1},
      {poem:'【成語運用】',text:'「負荊請罪」指？',options:["負擔責任", "請求寬恕", "誠心道歉", "背荊棘"],answer:2},
      {poem:'【成語運用】',text:'「掩耳盜鈴」比喻？',options:["偷鈴鐺", "自欺欺人", "很聰明", "掩耳朵"],answer:1},
      {poem:'【成語運用】',text:'「葉公好龍」比喻？',options:["葉先生", "表面喜歡實際害怕", "喜歡動物", "愛龍人士"],answer:1},
      {poem:'【成語運用】',text:'「刻舟求劍」比喻？',options:["在舟上刻字", "劍掉水裡", "死守教條", "找寶劍"],answer:2},
      {poem:'【成語運用】',text:'「杯弓蛇影」比喻？',options:["杯子弓", "蛇的影子", "疑神疑鬼", "喝酒"],answer:2},
      {poem:'【成語運用】',text:'「愚公移山」比喻？',options:["愚笨的人", "移走山脈", "老人搬山", "有恆心毅力"],answer:3},
      {poem:'【成語運用】',text:'「聞雞起舞」形容？',options:["勤奮早起", "養雞", "跳舞", "聽到雞叫"],answer:0},
      {poem:'【成語運用】',text:'「懸樑刺股」形容？',options:["很痛", "刻苦學習", "刺大腿", "掛在樑上"],answer:1},
      {poem:'【成語運用】',text:'「鑿壁偷光」形容？',options:["偷光", "偷東西", "刻苦讀書", "鑿牆壁"],answer:2},
      {poem:'【成語運用】',text:'「囊螢映雪」形容？',options:["勤學苦讀", "雪地", "寒冷", "螢火蟲"],answer:0},
      {poem:'【成語運用】',text:'「破釜沉舟」比喻？',options:["打破鍋", "下定決心", "沉船", "很大聲"],answer:1},
      {poem:'【成語運用】',text:'「如魚得水」比喻？',options:["魚在水", "游泳", "得到合適環境", "水很清"],answer:2},
      {poem:'【成語運用】',text:'「錦上添花」比喻？',options:["錦緞加花", "衣服漂亮", "好上加好", "花很美"],answer:2},
      {poem:'【成語運用】',text:'「雪中送炭」比喻？',options:["送炭火", "很冷", "雪中燒炭", "及時幫助"],answer:3},
      {poem:'【成語運用】',text:'「一箭雙鵰」比喻？',options:["射兩隻鳥", "射箭", "打獵", "一舉兩得"],answer:3},
      {poem:'【成語運用】',text:'「亡羊補牢」比喻？',options:["修補", "牢破了", "羊死了", "事後補救"],answer:3},
      {poem:'【成語運用】',text:'「鶴立雞群」比喻？',options:["雞很矮", "出類拔萃", "鶴站雞中", "很高"],answer:1},
      {poem:'【成語運用】',text:'「班門弄斧」比喻？',options:["班師傅", "弄斧頭", "不自量力", "在門前"],answer:2},
      {poem:'【成語運用】',text:'「天衣無縫」比喻？',options:["天造的衣服", "沒有縫", "完美無缺", "衣服破"],answer:2},
      {poem:'【成語運用】',text:'「浮光掠影」比喻？',options:["影子", "水上光", "觀察不深入", "光影"],answer:2},
      {poem:'【成語運用】',text:'「一針見血」比喻？',options:["很痛", "見血", "針刺血", "說話切中要害"],answer:3},
      {poem:'【成語運用】',text:'「左右逢源」比喻？',options:["兩邊", "做事順利", "左右", "找出源頭"],answer:1},
      {poem:'【成語運用】',text:'「千篇一律」比喻？',options:["很多篇", "毫無變化", "文章", "一樣"],answer:1},
      {poem:'【成語運用】',text:'「百折不撓」形容？',options:["彎曲", "折斷", "一百次", "意志堅毅"],answer:3},
      {poem:'【成語運用】',text:'「耳濡目染」指？',options:["環境", "眼睛染", "潛移默化", "耳朵濕"],answer:2},
      {poem:'【成語運用】',text:'「異口同聲」形容？',options:["同聲", "意見一致", "唱歌", "不同口"],answer:1},
      {poem:'【成語運用】',text:'「舉足輕重」形容？',options:["走路", "地位重要", "很重要", "舉腳輕"],answer:1},
      {poem:'【詞語填充】',text:'面對困難要＿＿不輕言放棄。',options:["堅持", "退縮", "逃避", "抱怨"],answer:0},
      {poem:'【詞語填充】',text:'這篇文章條理＿＿。',options:["雜亂", "模糊", "清晰", "混亂"],answer:2},
      {poem:'【詞語填充】',text:'他經常幫助同學十分＿＿。',options:["懶惰", "自私", "熱心", "冷漠"],answer:2},
      {poem:'【詞語填充】',text:'大家要＿＿合作才能完成任務。',options:["各自", "分裂", "分散", "團結"],answer:3},
      {poem:'【詞語填充】',text:'這位科學家的＿＿精神令人敬佩。',options:["退縮", "探索", "放棄", "逃避"],answer:1},
      {poem:'【詞語填充】',text:'我們應該＿＿學習永不言倦。',options:["勤奮", "懶惰", "隨便", "馬虎"],answer:0},
      {poem:'【詞語填充】',text:'經過努力他＿＿了所有困難。',options:["逃避", "放棄", "克服", "投降"],answer:2},
      {poem:'【詞語填充】',text:'這個＿＿的決定很重要。',options:["無關", "次要", "關鍵", "輕微"],answer:2},
      {poem:'【詞語填充】',text:'她用＿＿的笑容迎接客人。',options:["親切", "嚴肅", "兇惡", "冷漠"],answer:0},
      {poem:'【詞語填充】',text:'暑假我要＿＿地享受每一天。',options:["浪費", "空虛", "充實", "虛度"],answer:2},
      {poem:'【詞語填充】',text:'同學們＿＿討論專題報告。',options:["沉默", "冷淡", "安靜", "熱烈"],answer:3},
      {poem:'【詞語填充】',text:'這位畫家的作品十分＿＿。',options:["普通", "平凡", "平庸", "出色"],answer:3},
      {poem:'【詞語填充】',text:'我們要保護＿＿的自然環境。',options:["平凡", "普通", "珍貴", "常見"],answer:2},
      {poem:'【詞語填充】',text:'運動員每天進行＿＿訓練。',options:["簡單", "輕鬆", "容易", "艱苦"],answer:3},
      {poem:'【詞語填充】',text:'她輕聲＿＿了一首動聽的歌。',options:["哼唱", "呼喊", "怒吼", "大叫"],answer:0},
      {poem:'【詞語填充】',text:'這套電影情節＿＿引人入勝。',options:["無聊", "緊湊", "沉悶", "鬆散"],answer:1},
      {poem:'【詞語填充】',text:'交通意外現場一片＿＿。',options:["整齊", "寧靜", "混亂", "有序"],answer:2},
      {poem:'【詞語填充】',text:'我們要養成＿＿飲食的習慣。',options:["偏食", "均衡", "挑食", "暴飲暴食"],answer:1},
      {poem:'【詞語填充】',text:'他向觀眾＿＿了一個笑話。',options:["遮蓋", "講述", "隱瞞", "收藏"],answer:1},
      {poem:'【詞語填充】',text:'大海在風暴中波濤＿＿。',options:["平靜", "洶湧", "溫柔", "輕柔"],answer:1},
      {poem:'【詞語填充】',text:'團隊＿＿地完成了任務。',options:["辛苦", "困難", "順利", "艱難"],answer:2},
      {poem:'【詞語填充】',text:'這些文物＿＿了幾百年的歷史。',options:["見證", "消失", "埋沒", "遺忘"],answer:0},
      {poem:'【詞語填充】',text:'他＿＿著對家鄉的思念。',options:["拋開", "滿懷", "忘記", "遺棄"],answer:1},
      {poem:'【詞語填充】',text:'長輩的＿＿讓我們受益匪淺。',options:["隱瞞", "欺騙", "誤導", "教導"],answer:3},
      {poem:'【詞語填充】',text:'她在比賽中＿＿了出色的表現。',options:["遮蓋", "隱藏", "收斂", "展現"],answer:3},
      {poem:'【詞語填充】',text:'我們應懷著＿＿的心感恩。',options:["感激", "怨恨", "討厭", "憎惡"],answer:0},
      {poem:'【詞語填充】',text:'這個＿＿的決定令大家滿意。',options:["明智", "愚蠢", "糊里糊塗", "糊塗"],answer:0},
      {poem:'【詞語填充】',text:'孩子們＿＿地玩著遊戲。',options:["痛苦", "憂愁", "愉快", "悲傷"],answer:2},
      {poem:'【詞語填充】',text:'他＿＿地解決了難題。',options:["粗略", "笨拙", "馬虎", "巧妙"],answer:3},
      {poem:'【詞語填充】',text:'我們應以＿＿態度面對挑戰。',options:["積極", "消極", "懶散", "被動"],answer:0},
      {poem:'【修辭辨識】',text:'「書是良師益友明燈」修辭？',options:["設問", "排比", "反問", "對偶"],answer:1},
      {poem:'【修辭辨識】',text:'「天對地雨對風」修辭？',options:["比喻", "對偶", "排比", "擬人"],answer:1},
      {poem:'【修辭辨識】',text:'「誰不想做好呢」修辭？',options:["設問", "比喻", "排比", "反問"],answer:3},
      {poem:'【修辭辨識】',text:'「甚麼是勇氣跌倒再站起」修辭？',options:["比喻", "反問", "設問", "排比"],answer:2},
      {poem:'【修辭辨識】',text:'「盼望著盼望著春天來了」修辭？',options:["比喻", "排比", "反覆", "誇張"],answer:2},
      {poem:'【修辭辨識】',text:'「時光如流水般逝去」修辭？',options:["比喻", "反問", "排比", "擬人"],answer:0},
      {poem:'【修辭辨識】',text:'「小草從泥土探出頭來」修辭？',options:["誇張", "擬人", "排比", "比喻"],answer:1},
      {poem:'【修辭辨識】',text:'「他的愛像海一樣深」修辭？',options:["擬人", "比喻", "排比", "誇張"],answer:1},
      {poem:'【修辭辨識】',text:'「這條路長得沒有盡頭」修辭？',options:["反問", "誇張", "排比", "比喻"],answer:1},
      {poem:'【修辭辨識】',text:'「我們要愛國愛港愛家」修辭？',options:["設問", "對偶", "排比", "比喻"],answer:2},
      {poem:'【修辭辨識】',text:'「是誰讓我們成功是努力」修辭？',options:["設問", "對偶", "排比", "反問"],answer:0},
      {poem:'【修辭辨識】',text:'「快點快點要遲到了」修辭？',options:["對偶", "排比", "比喻", "反覆"],answer:3},
      {poem:'【修辭辨識】',text:'「白日依山盡黃河入海流」修辭？',options:["擬人", "排比", "對偶", "比喻"],answer:2},
      {poem:'【修辭辨識】',text:'「你不覺得可惜嗎」修辭？',options:["比喻", "排比", "反問", "設問"],answer:2},
      {poem:'【修辭辨識】',text:'「湖水像一面鏡子」修辭？',options:["誇張", "比喻", "排比", "擬人"],answer:1},
      {poem:'【修辭辨識】',text:'「風兒在樹梢跳舞」修辭？',options:["排比", "比喻", "設問", "擬人"],answer:3},
      {poem:'【修辭辨識】',text:'「他高得像一座山」修辭？',options:["誇張", "比喻", "排比", "對偶"],answer:0},
      {poem:'【修辭辨識】',text:'「要有夢想有決心有行動」修辭？',options:["比喻", "排比", "反問", "設問"],answer:1},
      {poem:'【修辭辨識】',text:'「這還不夠明顯嗎」修辭？',options:["排比", "反問", "設問", "比喻"],answer:1},
      {poem:'【修辭辨識】',text:'「甚麼是成功堅持到底」修辭？',options:["設問", "反問", "排比", "誇張"],answer:0},
      {poem:'【修辭辨識】',text:'「加油加油我們能做到」修辭？',options:["比喻", "排比", "反覆", "對偶"],answer:2},
      {poem:'【修辭辨識】',text:'「青山對綠水藍天襯白雲」修辭？',options:["擬人", "排比", "對偶", "比喻"],answer:2},
      {poem:'【修辭辨識】',text:'「友誼如酒愈久愈醇」修辭？',options:["反問", "排比", "比喻", "擬人"],answer:2},
      {poem:'【修辭辨識】',text:'「花朵向太陽微笑」修辭？',options:["比喻", "排比", "擬人", "誇張"],answer:2},
      {poem:'【修辭辨識】',text:'「她哭得像下雨一樣」修辭？',options:["排比", "誇張", "比喻", "設問"],answer:1},
      {poem:'【修辭辨識】',text:'「讀書明理寫字養心畫畫怡情」修辭？',options:["對偶", "排比", "比喻", "反問"],answer:1},
      {poem:'【修辭辨識】',text:'「難道你不想進步嗎」修辭？',options:["比喻", "設問", "排比", "反問"],answer:3},
      {poem:'【修辭辨識】',text:'「青春是甚麼追逐夢想的勇氣」修辭？',options:["反問", "排比", "對偶", "設問"],answer:3},
      {poem:'【修辭辨識】',text:'「努力努力一定成功」修辭？',options:["反覆", "排比", "對偶", "比喻"],answer:0},
      {poem:'【修辭辨識】',text:'「鳥鳴深澗水流幽谷」修辭？',options:["擬人", "比喻", "排比", "對偶"],answer:3},
      {poem:'【唐詩理解】',text:'「欲窮千里目」下一句？',options:["低頭思故鄉", "千山鳥飛絕", "黃河入海流", "更上一層樓"],answer:3},
      {poem:'【唐詩理解】',text:'《黃鶴樓送孟浩然》作者？',options:["李白", "孟浩然", "杜甫", "王維"],answer:0},
      {poem:'【唐詩理解】',text:'「一行白鷺上青天」前句？',options:["千山鳥飛絕", "飛流直下三千尺", "兩個黃鸝鳴翠柳", "孤帆遠影碧空盡"],answer:2},
      {poem:'【唐詩理解】',text:'《江雪》作者？',options:["杜甫", "王之渙", "柳宗元", "李白"],answer:2},
      {poem:'【唐詩理解】',text:'「千山鳥飛絕」下一句？',options:["一行白鷺上青天", "孤舟說立翁", "獨釣寒江雪", "萬徑人蹤滅"],answer:3},
      {poem:'【唐詩理解】',text:'《涼州詞》作者？',options:["王翰", "王之渙", "李白", "杜甫"],answer:0},
      {poem:'【唐詩理解】',text:'《遊子吟》「慈母手中線」作者？',options:["孟郊", "杜甫", "李白", "王維"],answer:0},
      {poem:'【唐詩理解】',text:'「誰言寸草心」下一句？',options:["意恐遲遲歸", "臨行密密縫", "報得三春暉", "慈母手中線"],answer:2},
      {poem:'【唐詩理解】',text:'《回鄉偶書》作者？',options:["賀知章", "王維", "李白", "杜甫"],answer:0},
      {poem:'【唐詩理解】',text:'「鄉音無改鬢毛衰」前句？',options:["笑問客從何處來", "離離原上草", "少小離家老大回", "兒童相見不相識"],answer:2},
      {poem:'【唐詩理解】',text:'《絕句》「窗含西嶺」作者？',options:["杜牧", "李白", "杜甫", "王維"],answer:2},
      {poem:'【唐詩理解】',text:'《楓橋夜泊》作者？',options:["王之渙", "杜甫", "張繼", "李白"],answer:2},
      {poem:'【唐詩理解】',text:'「月落烏啼霜滿天」出自？',options:["《江雪》", "《靜夜思》", "《楓橋夜泊》", "《絕句》"],answer:2},
      {poem:'【唐詩理解】',text:'《送杜少府之任蜀州》作者？',options:["王維", "杜甫", "王勃", "李白"],answer:2},
      {poem:'【唐詩理解】',text:'「海上生明月」下一句？',options:["床前明月光", "低頭思故鄉", "疑是地上霜", "天涯共此時"],answer:3},
      {poem:'【唐詩理解】',text:'《望天門山》作者？',options:["王維", "王之渙", "李白", "杜甫"],answer:2},
      {poem:'【唐詩理解】',text:'「孤帆一片日邊來」前句？',options:["飛流直下三千尺", "千里江陵一日還", "兩岸青山相對出", "一行白鷺上青天"],answer:2},
      {poem:'【唐詩理解】',text:'《涼州詞》「黃河遠上」作者？',options:["王之渙", "王翰", "李白", "杜甫"],answer:0},
      {poem:'【唐詩理解】',text:'「羌笛何須怨楊柳」下一句？',options:["春風不度玉門關", "黃河遠上白雲間", "千里江陵一日還", "一片孤城萬仞山"],answer:0},
      {poem:'【唐詩理解】',text:'《出塞》作者？',options:["杜甫", "王昌齡", "李白", "王之渙"],answer:1},
      {poem:'【唐詩理解】',text:'「秦時明月漢時關」下一句？',options:["一片孤城萬仞山", "萬里長征人未還", "千里江陵一日還", "黃河遠上白雲間"],answer:1},
      {poem:'【唐詩理解】',text:'《九月九日憶山東兄弟》作者？',options:["王維", "杜甫", "李白", "杜牧"],answer:0},
      {poem:'【唐詩理解】',text:'「獨在異鄉為異客」下一句？',options:["遍插茱萸少一人", "月是故鄉明", "每逢佳節倍思親", "遙知兄弟登高處"],answer:2},
      {poem:'【唐詩理解】',text:'《芙蓉樓送辛漸》作者？',options:["杜甫", "王昌齡", "王維", "李白"],answer:1},
      {poem:'【唐詩理解】',text:'「洛陽親友如相問」下一句？',options:["一片冰心在玉壺", "寒雨連江夜入吳", "平明送客楚山孤", "千里江陵一日還"],answer:0},
      {poem:'【唐詩理解】',text:'《送元二使安西》作者？',options:["王維", "杜甫", "李白", "王之渙"],answer:0},
      {poem:'【唐詩理解】',text:'「寒雨連江夜入吳」出自？',options:["《黃鶴樓》", "《出塞》", "《送元二使安西》", "《芙蓉樓送辛漸》"],answer:3},
      {poem:'【唐詩理解】',text:'《詠柳》作者？',options:["杜甫", "賀知章", "李白", "王維"],answer:1},
      {poem:'【唐詩理解】',text:'「二月春風似剪刀」前句？',options:["萬條垂下綠絲絛", "不知細葉誰裁出", "春眠不覺曉", "碧玉妝成一樹高"],answer:1},
      {poem:'【唐詩理解】',text:'《憫農》其二作者？',options:["杜甫", "王維", "李紳", "李白"],answer:2},
      {poem:'【標點符號】',text:'你去不去圖書館＿＿',options:["？", "！", "，", "。"],answer:0},
      {poem:'【標點符號】',text:'鉛筆＿＿擦膠＿＿尺 兩空格？',options:["，和，", "；和：", "，和。", "、和、"],answer:3},
      {poem:'【標點符號】',text:'老師說＿＿「做功課要用心」',options:["。", "！", "：", "，"],answer:2},
      {poem:'【標點符號】',text:'《西遊記》外應加？',options:["冒號", "引號", "括號", "書名號"],answer:3},
      {poem:'【標點符號】',text:'他說＿＿「明天見」',options:["？", "，", "：", "。"],answer:2},
      {poem:'【標點符號】',text:'我喜歡＿＿看書＿＿畫畫和唱歌',options:["，和，", "，和。", "、和、", "；和："],answer:2},
      {poem:'【標點符號】',text:'真的嗎＿＿',options:["：", "？", "！", "。"],answer:1},
      {poem:'【標點符號】',text:'小明＿＿小華＿＿和小強',options:["；和：", "、和、", "，和，", "，和。"],answer:1},
      {poem:'【標點符號】',text:'《三國演義》加甚麼標點？',options:["引號", "書名號", "括號", "破折號"],answer:1},
      {poem:'【標點符號】',text:'加油＿＿',options:["！", "。", "？", "："],answer:0},
      {poem:'【標點符號】',text:'她問＿＿「你在做甚麼」',options:["，", "！", "。", "："],answer:3},
      {poem:'【標點符號】',text:'早餐有＿＿麵包＿＿牛奶和雞蛋',options:["，和。", "，和，", "、和、", "；和："],answer:2},
      {poem:'【標點符號】',text:'「紅樓夢」應加？',options:["書名號", "括號", "引號", "冒號"],answer:0},
      {poem:'【標點符號】',text:'怎麼可能＿＿',options:["。", "：", "？", "！"],answer:2},
      {poem:'【標點符號】',text:'太厲害了＿＿',options:["！", "：", "？", "。"],answer:0},
      {poem:'【標點符號】',text:'校長宣布＿＿「明天放假」',options:["？", "。", "：", "，"],answer:2},
      {poem:'【標點符號】',text:'語文＿＿數學＿＿常識和音樂',options:["、和、", "；和：", "，和，", "，和。"],answer:0},
      {poem:'【標點符號】',text:'《水滸傳》加甚麼？',options:["括號", "引號", "省略號", "書名號"],answer:3},
      {poem:'【標點符號】',text:'誰在叫我＿＿',options:["。", "？", "！", "："],answer:1},
      {poem:'【標點符號】',text:'好美啊＿＿',options:["？", "：", "！", "。"],answer:2},
      {poem:'【標點符號】',text:'她笑說＿＿「謝謝」',options:["：", "，", "。", "？"],answer:0},
      {poem:'【標點符號】',text:'紅色＿＿藍色＿＿黃色和綠色',options:["，和，", "、和、", "；和：", "，和。"],answer:1},
      {poem:'【標點符號】',text:'《西遊記》加甚麼標點？',options:["冒號", "書名號", "括號", "引號"],answer:1},
      {poem:'【標點符號】',text:'你確定＿＿',options:["？", "。", "：", "！"],answer:0},
      {poem:'【標點符號】',text:'太好了＿＿',options:["？", "。", "！", "："],answer:2},
      {poem:'【標點符號】',text:'媽媽說＿＿「快點起床」',options:["？", "，", "：", "。"],answer:2},
      {poem:'【標點符號】',text:'中文＿＿英文＿＿數學和常識',options:["；和：", "、和、", "，和，", "，和。"],answer:1},
      {poem:'【標點符號】',text:'《論語》加甚麼標點？',options:["書名號", "引號", "冒號", "括號"],answer:0},
      {poem:'【標點符號】',text:'真的假的＿＿',options:["：", "。", "？", "！"],answer:2},
      {poem:'【標點符號】',text:'恭喜恭喜＿＿',options:["！", "。", "：", "？"],answer:0},
      {poem:'【找錯字】',text:'「遵敬師長」改正？',options:["師→帥", "遵→尊", "敬→警", "愛→受"],answer:1},
      {poem:'【找錯字】',text:'「鼓厉」改正？',options:["試→式", "鼓→古", "厉→勵", "嘗→賞"],answer:2},
      {poem:'【找錯字】',text:'「堅恃」改正？',options:["堅→豎", "機→幾", "功→攻", "恃→持"],answer:3},
      {poem:'【找錯字】',text:'「忘想」改正？',options:["想→相", "人→入", "忘→妄", "井→弓"],answer:2},
      {poem:'【找錯字】',text:'「己錄」改正？',options:["錄→綠", "人→入", "井→弓", "己→紀"],answer:3},
      {poem:'【找錯字】',text:'「辛運」改正？',options:["運→遠", "井→弓", "辛→幸", "人→入"],answer:2},
      {poem:'【找錯字】',text:'「考盧」改正？',options:["人→入", "井→弓", "盧→慮", "考→老"],answer:2},
      {poem:'【找錯字】',text:'「即然」改正？',options:["然→燃", "即→既", "井→弓", "人→入"],answer:1},
      {poem:'【找錯字】',text:'「浪慢」改正？',options:["井→弓", "浪→朗", "人→入", "慢→漫"],answer:3},
      {poem:'【找錯字】',text:'「祕蜜」改正？',options:["祕→秘", "蜜→密", "人→入", "井→弓"],answer:0},
      {poem:'【找錯字】',text:'「反回」改正？',options:["反→返", "井→弓", "人→入", "回→迴"],answer:0},
      {poem:'【找錯字】',text:'「成攻」改正？',options:["人→入", "攻→功", "井→弓", "成→城"],answer:1},
      {poem:'【找錯字】',text:'「辨公室」改正？',options:["井→弓", "公→工", "室→實", "辨→辦"],answer:3},
      {poem:'【找錯字】',text:'「富欲」改正？',options:["欲→裕", "富→福", "井→弓", "人→入"],answer:0},
      {poem:'【找錯字】',text:'「顏利」改正？',options:["井→弓", "顏→嚴", "利→厲", "人→入"],answer:1},
      {poem:'【找錯字】',text:'「實淺」改正？',options:["淺→踐", "實→室", "井→弓", "人→入"],answer:0},
      {poem:'【找錯字】',text:'「根原」改正？',options:["井→弓", "根→跟", "原→源", "人→入"],answer:2},
      {poem:'【找錯字】',text:'「形像」改正？',options:["人→入", "像→象", "形→型", "井→弓"],answer:1},
      {poem:'【找錯字】',text:'「介召」改正？',options:["井→弓", "介→界", "人→入", "召→紹"],answer:3},
      {poem:'【找錯字】',text:'「磨擦」改正？',options:["井→弓", "擦→察", "人→入", "磨→摩"],answer:3},
      {poem:'【找錯字】',text:'「會義」改正？',options:["義→議", "人→入", "會→匯", "井→弓"],answer:0},
      {poem:'【找錯字】',text:'「積畜」改正？',options:["井→弓", "畜→蓄", "積→集", "人→入"],answer:1},
      {poem:'【找錯字】',text:'「連洛」改正？',options:["連→聯", "洛→絡", "人→入", "井→弓"],answer:1},
      {poem:'【找錯字】',text:'「組力」改正？',options:["組→阻", "人→入", "井→弓", "力→立"],answer:0},
      {poem:'【找錯字】',text:'「表準」改正？',options:["人→入", "表→標", "準→准", "井→弓"],answer:1},
      {poem:'【找錯字】',text:'「資原」改正？',options:["井→弓", "原→源", "資→姿", "人→入"],answer:1},
      {poem:'【找錯字】',text:'「擔誤」改正？',options:["擔→膽", "人→入", "誤→耽", "井→弓"],answer:2},
      {poem:'【找錯字】',text:'「透路」改正？',options:["井→弓", "透→秀", "路→露", "人→入"],answer:2},
      {poem:'【找錯字】',text:'「減單」改正？',options:["井→弓", "人→入", "減→鹹", "單→簡"],answer:3},
      {poem:'【找錯字】',text:'「記綠」改正？',options:["記→紀", "綠→錄", "井→弓", "人→入"],answer:1}
    ],
    P6: [
      {poem:'【部首】',text:'「籍」的部首是甚麼？',options:["米", "木", "耒", "竹"],answer:3},
      {poem:'【部首】',text:'「警」的部首是甚麼？',options:["口", "言", "敬", "心"],answer:1},
      {poem:'【部首】',text:'「顧」的部首是甚麼？',options:["目", "見", "頁", "戶"],answer:2},
      {poem:'【部首】',text:'「鑑」的部首是甚麼？',options:["金", "木", "石", "竹"],answer:0},
      {poem:'【部首】',text:'「轟」的部首是甚麼？',options:["木", "口", "雨", "車"],answer:3},
      {poem:'【部首】',text:'「驟」的部首是甚麼？',options:["木", "聚", "馬", "口"],answer:2},
      {poem:'【部首】',text:'「霸」的部首是甚麼？',options:["雨", "口", "月", "革"],answer:0},
      {poem:'【部首】',text:'「魔」的部首是甚麼？',options:["麻", "木", "鬼", "口"],answer:2},
      {poem:'【部首】',text:'「弊」的部首是甚麼？',options:["敝", "廾", "木", "口"],answer:1},
      {poem:'【部首】',text:'「曬」的部首是甚麼？',options:["日", "口", "麗", "木"],answer:0},
      {poem:'【部首】',text:'「驚」的部首是甚麼？',options:["馬", "口", "心", "敬"],answer:0},
      {poem:'【部首】',text:'「譽」的部首是甚麼？',options:["言", "木", "與", "口"],answer:0},
      {poem:'【部首】',text:'「辭」的部首是甚麼？',options:["辛", "舌", "口", "木"],answer:0},
      {poem:'【部首】',text:'「襲」的部首是甚麼？',options:["木", "衣", "龍", "口"],answer:1},
      {poem:'【部首】',text:'「驗」的部首是甚麼？',options:["僉", "馬", "口", "心"],answer:1},
      {poem:'【部首】',text:'「籌」的部首是甚麼？',options:["口", "竹", "壽", "木"],answer:1},
      {poem:'【部首】',text:'「闢」的部首是甚麼？',options:["口", "木", "門", "辟"],answer:2},
      {poem:'【部首】',text:'「躊」的部首是甚麼？',options:["足", "木", "壽", "口"],answer:0},
      {poem:'【部首】',text:'「龐」的部首是甚麼？',options:["口", "龍", "广", "木"],answer:2},
      {poem:'【部首】',text:'「竊」的部首是甚麼？',options:["切", "口", "穴", "米"],answer:2},
      {poem:'【部首】',text:'「籲」的部首是甚麼？',options:["木", "竹", "口", "頁"],answer:1},
      {poem:'【部首】',text:'「囊」的部首是甚麼？',options:["石", "木", "衣", "口"],answer:3},
      {poem:'【部首】',text:'「灘」的部首是甚麼？',options:["口", "氵", "鳥", "難"],answer:1},
      {poem:'【部首】',text:'「廳」的部首是甚麼？',options:["木", "聽", "广", "口"],answer:2},
      {poem:'【部首】',text:'「艷」的部首是甚麼？',options:["口", "豆", "色", "豐"],answer:1},
      {poem:'【部首】',text:'「鬱」的部首是甚麼？',options:["木", "鬯", "林", "心"],answer:1},
      {poem:'【部首】',text:'「釁」的部首是甚麼？',options:["酉", "分", "皿", "口"],answer:0},
      {poem:'【部首】',text:'「蠶」的部首是甚麼？',options:["天", "口", "木", "虫"],answer:3},
      {poem:'【部首】',text:'「鑒」的部首是甚麼？',options:["口", "金", "木", "石"],answer:1},
      {poem:'【部首】',text:'「籬」的部首是甚麼？',options:["口", "竹", "離", "木"],answer:1},
      {poem:'【詞義辨析】',text:'「堅毅」的近義詞？',options:["膽小", "猶豫", "堅定", "軟弱"],answer:2},
      {poem:'【詞義辨析】',text:'「慷慨」的反義詞？',options:["吝嗇", "大方", "貧窮", "富有"],answer:0},
      {poem:'【詞義辨析】',text:'「敏捷」的近義詞？',options:["緩慢", "笨拙", "猶豫", "迅捷"],answer:3},
      {poem:'【詞義辨析】',text:'「剎那」的近義詞？',options:["瞬間", "永恆", "永久", "長久"],answer:0},
      {poem:'【詞義辨析】',text:'「剝削」的近義詞？',options:["幫助", "壓榨", "扶持", "保護"],answer:1},
      {poem:'【詞義辨析】',text:'「頹廢」的反義詞？',options:["沮喪", "消沉", "振奮", "墮落"],answer:2},
      {poem:'【詞義辨析】',text:'「細膩」的反義詞？',options:["精細", "粗糙", "仔細", "精緻"],answer:1},
      {poem:'【詞義辨析】',text:'「豁達」的近義詞？',options:["狹隘", "開朗", "憂鬱", "悲觀"],answer:1},
      {poem:'【詞義辨析】',text:'「孤僻」的反義詞？',options:["開朗", "孤獨", "內向", "安靜"],answer:0},
      {poem:'【詞義辨析】',text:'「莽撞」的反義詞？',options:["衝動", "謹慎", "大膽", "勇猛"],answer:1},
      {poem:'【詞義辨析】',text:'「艱鉅」的近義詞？',options:["簡單", "困難", "容易", "輕鬆"],answer:1},
      {poem:'【詞義辨析】',text:'「猖獗」的反義詞？',options:["瘋狂", "式微", "猖狂", "旺盛"],answer:1},
      {poem:'【詞義辨析】',text:'「駁斥」的近義詞？',options:["同意", "支持", "贊成", "反駁"],answer:3},
      {poem:'【詞義辨析】',text:'「朦朧」的反義詞？',options:["模糊", "清晰", "昏暗", "隱約"],answer:1},
      {poem:'【詞義辨析】',text:'「乾涸」的反義詞？',options:["枯竭", "乾燥", "荒蕪", "濕潤"],answer:3},
      {poem:'【詞義辨析】',text:'「婉轉」的近義詞？',options:["直接", "直率", "粗魯", "含蓄"],answer:3},
      {poem:'【詞義辨析】',text:'「懈怠」的反義詞？',options:["隨便", "馬虎", "勤勉", "懶惰"],answer:2},
      {poem:'【詞義辨析】',text:'「攏絡」的近義詞？',options:["拒絕", "排斥", "拉攏", "疏遠"],answer:2},
      {poem:'【詞義辨析】',text:'「匱乏」的反義詞？',options:["缺乏", "不足", "貧困", "充裕"],answer:3},
      {poem:'【詞義辨析】',text:'「瀟灑」的近義詞？',options:["拘謹", "灑脫", "呆板", "嚴肅"],answer:1},
      {poem:'【詞義辨析】',text:'「深邃」的反義詞？',options:["深遠", "淺薄", "黑暗", "深刻"],answer:1},
      {poem:'【詞義辨析】',text:'「倔強」的近義詞？',options:["軟弱", "剛強", "溫順", "柔和"],answer:1},
      {poem:'【詞義辨析】',text:'「晦澀」的反義詞？',options:["複雜", "模糊", "黑暗", "淺白"],answer:3},
      {poem:'【詞義辨析】',text:'「怠慢」的反義詞？',options:["馬虎", "緩慢", "殷勤", "懶惰"],answer:2},
      {poem:'【詞義辨析】',text:'「急遽」的近義詞？',options:["慢慢", "緩慢", "徐徐", "驟然"],answer:3},
      {poem:'【詞義辨析】',text:'「放肆」的反義詞？',options:["規矩", "任性", "自由", "隨意"],answer:0},
      {poem:'【詞義辨析】',text:'「煎熬」的近義詞？',options:["舒適", "折磨", "享受", "安逸"],answer:1},
      {poem:'【詞義辨析】',text:'「渺小」的反義詞？',options:["細小", "狹窄", "偉大", "微小"],answer:2},
      {poem:'【詞義辨析】',text:'「狡辯」的近義詞？',options:["直率", "誠實", "坦白", "詭辯"],answer:3},
      {poem:'【詞義辨析】',text:'「惡劣」的反義詞？',options:["壞", "差", "糟糕", "優良"],answer:3},
      {poem:'【成語運用】',text:'「胸有成竹」比喻？',options:["沒有計劃", "做事前有周詳打算", "很緊張", "喜歡畫畫"],answer:1},
      {poem:'【成語運用】',text:'「實事求是」指？',options:["誇大其詞", "不求甚解", "只講不做", "按實際情況處理"],answer:3},
      {poem:'【成語運用】',text:'「堅持不懈」形容？',options:["半途而廢", "持續努力不放棄", "隨隨便便", "懶懶散散"],answer:1},
      {poem:'【成語運用】',text:'「舉一反三」指？',options:["能觸類旁通", "三個例子", "舉例", "反覆練習"],answer:0},
      {poem:'【成語運用】',text:'「持之以恆」形容？',options:["隨意而為", "堅持不間斷", "半途而廢", "時做時停"],answer:1},
      {poem:'【成語運用】',text:'「循序漸進」指？',options:["按步驟逐步前進", "一次完成", "急於求成", "跳步前進"],answer:0},
      {poem:'【成語運用】',text:'「見微知著」指？',options:["知道著作", "微小不重要", "看微小東西", "從小事看出大道理"],answer:3},
      {poem:'【成語運用】',text:'「居安思危」指？',options:["害怕", "思考危險", "安樂時不忘危險", "住安全地方"],answer:2},
      {poem:'【成語運用】',text:'「未雨綢繆」指？',options:["綢緞", "織布", "下雨前", "事先做好準備"],answer:3},
      {poem:'【成語運用】',text:'「飲水思源」指？',options:["不忘本來根源", "喝水", "想源頭", "水從哪裡來"],answer:0},
      {poem:'【成語運用】',text:'「孤注一擲」比喻？',options:["下注", "冒險做最後一試", "孤獨", "擲東西"],answer:1},
      {poem:'【成語運用】',text:'「目空一切」形容？',options:["天空", "驕傲自大", "眼睛", "看不見"],answer:1},
      {poem:'【成語運用】',text:'「紙上談兵」比喻？',options:["空談理論", "紙上畫圖", "書寫", "談軍隊"],answer:0},
      {poem:'【成語運用】',text:'「裹足不前」形容？',options:["走路慢", "裹在被子裡", "腳受傷", "猶豫不敢前進"],answer:3},
      {poem:'【成語運用】',text:'「獨樹一幟」比喻？',options:["獨立", "一棵樹", "旗幟", "自成一格"],answer:3},
      {poem:'【成語運用】',text:'「如火如荼」形容？',options:["燒茶", "很熱", "火和茶", "氣勢旺盛"],answer:3},
      {poem:'【成語運用】',text:'「一氣呵成」形容？',options:["生氣地完成", "呵氣", "一生氣", "連貫完成"],answer:3},
      {poem:'【成語運用】',text:'「一絲不苟」形容？',options:["不苟且", "一根絲", "絲線", "做事很認真"],answer:3},
      {poem:'【成語運用】',text:'「另眼相看」指？',options:["看眼睛", "看法", "另一隻眼", "特別看待"],answer:3},
      {poem:'【成語運用】',text:'「深謀遠慮」形容？',options:["謀略", "想很遠", "很深", "考慮長遠周密"],answer:3},
      {poem:'【成語運用】',text:'「再接再厲」表示？',options:["繼續努力", "嚴厲", "厲害", "再次"],answer:0},
      {poem:'【成語運用】',text:'「潛移默化」指？',options:["不知不覺受影響", "移東西", "變化", "潛水"],answer:0},
      {poem:'【成語運用】',text:'「不恥下問」指？',options:["不害羞", "向下問", "不覺得恥辱", "虛心向人請教"],answer:3},
      {poem:'【成語運用】',text:'「同舟共濟」比喻？',options:["團結互助", "渡河", "一起坐船", "同條船"],answer:0},
      {poem:'【成語運用】',text:'「恰如其分」表示？',options:["恰巧", "分數", "如其分", "剛好適當"],answer:3},
      {poem:'【成語運用】',text:'「因地制宜」指？',options:["制度", "按情況辦事", "合適", "因地方"],answer:1},
      {poem:'【成語運用】',text:'「一視同仁」指？',options:["同樣仁愛", "一次看", "看仁", "平等對待"],answer:3},
      {poem:'【成語運用】',text:'「以身作則」指？',options:["規則", "以自己", "自己做榜樣", "身體"],answer:2},
      {poem:'【成語運用】',text:'「相得益彰」指？',options:["彰顯", "互相", "相互配合更出色", "得到好處"],answer:2},
      {poem:'【成語運用】',text:'「脫穎而出」比喻？',options:["才能顯露出來", "脫衣服", "冒出", "脫穎"],answer:0},
      {poem:'【詞語填充】',text:'成功沒有捷徑只有長期＿＿。',options:["積累", "偷懶", "放棄", "等待"],answer:0},
      {poem:'【詞語填充】',text:'面對不同意見保持＿＿討論。',options:["冷靜", "憤怒", "急躁", "激動"],answer:0},
      {poem:'【詞語填充】',text:'研習資料＿＿分析很深入。',options:["貧乏", "簡陋", "充實", "雜亂"],answer:2},
      {poem:'【詞語填充】',text:'他＿＿地完成了最後的任務。',options:["隨便", "失敗", "馬虎", "出色"],answer:3},
      {poem:'【詞語填充】',text:'我們要＿＿傳統文化。',options:["弘揚", "忘記", "遺棄", "破壞"],answer:0},
      {poem:'【詞語填充】',text:'這個＿＿值得我們深思。',options:["課題", "容易", "簡單", "輕視"],answer:0},
      {poem:'【詞語填充】',text:'科學家＿＿了新的藥物。',options:["放棄", "研發", "破壞", "忘記"],answer:1},
      {poem:'【詞語填充】',text:'她＿＿地照顧年邁的祖母。',options:["忽略", "孝順", "冷漠", "疏忽"],answer:1},
      {poem:'【詞語填充】',text:'同學們＿＿地聽學長分享。',options:["隨便", "散漫", "專注", "分心"],answer:2},
      {poem:'【詞語填充】',text:'這個時代變化＿＿。',options:["停止", "停滯", "緩慢", "迅速"],answer:3},
      {poem:'【詞語填充】',text:'我們要＿＿信心迎接挑戰。',options:["喪失", "放棄", "滿懷", "失去"],answer:2},
      {poem:'【詞語填充】',text:'老師＿＿我們要獨立思考。',options:["鼓勵", "打擊", "阻止", "壓抑"],answer:0},
      {poem:'【詞語填充】',text:'她的歌聲＿＿了全場觀眾。',options:["征服", "敗壞", "失望", "沮喪"],answer:0},
      {poem:'【詞語填充】',text:'社會需要更多＿＿的聲音。',options:["錯誤", "正義", "邪惡", "不公"],answer:1},
      {poem:'【詞語填充】',text:'他＿＿了自己的錯誤。',options:["承認", "掩飾", "隱瞞", "否認"],answer:0},
      {poem:'【詞語填充】',text:'這座城市發展＿＿。',options:["蓬勃", "萎縮", "衰退", "蕭條"],answer:0},
      {poem:'【詞語填充】',text:'她＿＿地找出問題所在。',options:["馬虎", "大意", "隨便", "仔細"],answer:3},
      {poem:'【詞語填充】',text:'我們要培養＿＿的品格。',options:["軟弱", "懦弱", "猶豫", "堅毅"],answer:3},
      {poem:'【詞語填充】',text:'老師＿＿我們的學習進度。',options:["忽視", "漠視", "不理", "關注"],answer:3},
      {poem:'【詞語填充】',text:'童年記憶依然＿＿。',options:["鮮明", "模糊", "黑暗", "黯淡"],answer:0},
      {poem:'【詞語填充】',text:'他對音樂＿＿濃厚興趣。',options:["失去", "懷有", "沒有", "缺乏"],answer:1},
      {poem:'【詞語填充】',text:'我們要＿＿地使用資源。',options:["珍惜", "浪費", "濫用", "揮霍"],answer:0},
      {poem:'【詞語填充】',text:'同學應該互相＿＿。',options:["鄙視", "看不起", "輕視", "尊重"],answer:3},
      {poem:'【詞語填充】',text:'這件事＿＿了我的想法。',options:["穩固", "牢固", "固定", "改變"],answer:3},
      {poem:'【詞語填充】',text:'大家要＿＿合作精神。',options:["抑制", "發揮", "隱藏", "壓制"],answer:1},
      {poem:'【詞語填充】',text:'長遠＿＿需要大家努力。',options:["破壞", "擾亂", "規劃", "混亂"],answer:2},
      {poem:'【詞語填充】',text:'他＿＿了整件事的經過。',options:["隱瞞", "闡述", "掩飾", "遮蓋"],answer:1},
      {poem:'【詞語填充】',text:'我們要＿＿面對未來。',options:["退縮", "膽小", "勇敢", "害怕"],answer:2},
      {poem:'【詞語填充】',text:'困難只是＿＿的考驗。',options:["長期", "永久", "永遠", "暫時"],answer:3},
      {poem:'【詞語填充】',text:'她以行動＿＿了自己的決心。',options:["證明", "否定", "推翻", "質疑"],answer:0},
      {poem:'【修辭辨識】',text:'「燕子去了楊柳枯了桃花謝了」修辭？',options:["設問", "比喻", "反問", "排比"],answer:3},
      {poem:'【修辭辨識】',text:'「學如逆水行舟不進則退」修辭？',options:["排比", "比喻", "設問", "反問"],answer:1},
      {poem:'【修辭辨識】',text:'「你怎能說與你無關」修辭？',options:["比喻", "設問", "排比", "反問"],answer:3},
      {poem:'【修辭辨識】',text:'「甚麼是責任把事做好」修辭？',options:["排比", "設問", "比喻", "反問"],answer:1},
      {poem:'【修辭辨識】',text:'「盼啊盼啊畢業旅行到了」修辭？',options:["排比", "誇張", "比喻", "反覆"],answer:3},
      {poem:'【修辭辨識】',text:'「人生如夢夢如人生」修辭？',options:["排比", "反問", "對偶", "比喻"],answer:3},
      {poem:'【修辭辨識】',text:'「狂風怒吼海浪咆哮」修辭？',options:["擬人", "反問", "排比", "比喻"],answer:0},
      {poem:'【修辭辨識】',text:'「他瘦得像一根竹竿」修辭？',options:["對偶", "誇張", "排比", "比喻"],answer:1},
      {poem:'【修辭辨識】',text:'「愛是付出愛是包容愛是犧牲」修辭？',options:["設問", "對偶", "比喻", "排比"],answer:3},
      {poem:'【修辭辨識】',text:'「這樣的錯誤能原諒嗎」修辭？',options:["反問", "比喻", "設問", "排比"],answer:0},
      {poem:'【修辭辨識】',text:'「誠信是甚麼是做人的根本」修辭？',options:["反問", "設問", "排比", "對偶"],answer:1},
      {poem:'【修辭辨識】',text:'「前進前進永不放棄」修辭？',options:["反覆", "排比", "比喻", "對偶"],answer:0},
      {poem:'【修辭辨識】',text:'「天連水水連天」修辭？',options:["比喻", "對偶", "回文", "排比"],answer:1},
      {poem:'【修辭辨識】',text:'「時間就是金錢」修辭？',options:["排比", "比喻", "反問", "擬人"],answer:1},
      {poem:'【修辭辨識】',text:'「太陽羞澀地藏在雲層後」修辭？',options:["比喻", "擬人", "排比", "誇張"],answer:1},
      {poem:'【修辭辨識】',text:'「這條裙子比彩虹還美」修辭？',options:["比喻", "對偶", "排比", "誇張"],answer:3},
      {poem:'【修辭辨識】',text:'「有志者事竟成有心人事必成」修辭？',options:["反問", "對偶", "排比", "比喻"],answer:2},
      {poem:'【修辭辨識】',text:'「難道真理不值得追求嗎」修辭？',options:["設問", "比喻", "反問", "排比"],answer:2},
      {poem:'【修辭辨識】',text:'「何謂友誼患難見真情」修辭？',options:["反問", "比喻", "排比", "設問"],answer:3},
      {poem:'【修辭辨識】',text:'「奔跑奔跑向著目標衝」修辭？',options:["排比", "對偶", "反覆", "誇張"],answer:2},
      {poem:'【修辭辨識】',text:'「善有善報惡有惡報」修辭？',options:["比喻", "排比", "擬人", "對偶"],answer:3},
      {poem:'【修辭辨識】',text:'「知識就是力量」修辭？',options:["對偶", "反問", "比喻", "排比"],answer:2},
      {poem:'【修辭辨識】',text:'「春天用畫筆染綠了大地」修辭？',options:["擬人", "比喻", "誇張", "排比"],answer:0},
      {poem:'【修辭辨識】',text:'「她的眼淚流成河」修辭？',options:["比喻", "對偶", "誇張", "排比"],answer:2},
      {poem:'【修辭辨識】',text:'「讀書使人明智寫作使人精確」修辭？',options:["對偶", "比喻", "反問", "排比"],answer:3},
      {poem:'【修辭辨識】',text:'「你不覺得這樣做不對嗎」修辭？',options:["比喻", "設問", "排比", "反問"],answer:3},
      {poem:'【修辭辨識】',text:'「甚麼是自信相信自己」修辭？',options:["對偶", "排比", "設問", "反問"],answer:2},
      {poem:'【修辭辨識】',text:'「等待等待黎明終會來」修辭？',options:["排比", "比喻", "對偶", "反覆"],answer:3},
      {poem:'【修辭辨識】',text:'「雲對月星對日」修辭？',options:["排比", "對偶", "比喻", "擬人"],answer:1},
      {poem:'【修辭辨識】',text:'「希望是黑暗中的一盞燈」修辭？',options:["反問", "擬人", "比喻", "排比"],answer:2},
      {poem:'【唐詩理解】',text:'《送元二使安西》作者？',options:["王維", "杜甫", "李白", "柳宗元"],answer:0},
      {poem:'【唐詩理解】',text:'「西出陽關無故人」前句？',options:["煙花三月下揚州", "孤帆遠影碧空盡", "千里江陵一日還", "勸君更盡一杯酒"],answer:3},
      {poem:'【唐詩理解】',text:'《望廬山瀑布》作者？',options:["王維", "李白", "王之渙", "杜甫"],answer:1},
      {poem:'【唐詩理解】',text:'「疑是銀河落九天」前句？',options:["一行白鷺上青天", "千里江陵一日還", "兩岸青山相對出", "飛流直下三千尺"],answer:3},
      {poem:'【唐詩理解】',text:'《春望》作者？',options:["杜甫", "柳宗元", "王維", "李白"],answer:0},
      {poem:'【唐詩理解】',text:'「國破山河在」下一句？',options:["恨別鳥驚心", "烽火連三月", "感時花濺淚", "城春草木深"],answer:3},
      {poem:'【唐詩理解】',text:'《泊秦淮》作者？',options:["杜甫", "李白", "王維", "杜牧"],answer:3},
      {poem:'【唐詩理解】',text:'《江南春》作者？',options:["杜甫", "王維", "李白", "杜牧"],answer:3},
      {poem:'【唐詩理解】',text:'「南朝四百八十寺」下一句？',options:["水村山郭酒旗風", "煙籠寒水月籠沙", "多少樓臺煙雨中", "千里鶯啼綠映紅"],answer:2},
      {poem:'【唐詩理解】',text:'《山行》作者？',options:["杜甫", "杜牧", "王維", "李白"],answer:1},
      {poem:'【唐詩理解】',text:'「霜葉紅於二月花」前句？',options:["遠上寒山石徑斜", "停車坐愛楓林晚", "千里鶯啼綠映紅", "白雲生處有人家"],answer:1},
      {poem:'【唐詩理解】',text:'《樂遊原》作者？',options:["李商隱", "杜牧", "李白", "杜甫"],answer:0},
      {poem:'【唐詩理解】',text:'「夕陽無限好」下一句？',options:["向晚意不適", "只是已惘然", "只是近黃昏", "驅車登古原"],answer:2},
      {poem:'【唐詩理解】',text:'《烏衣巷》作者？',options:["李白", "劉禹錫", "杜甫", "杜牧"],answer:1},
      {poem:'【唐詩理解】',text:'「舊時王謝堂前燕」下一句？',options:["飛入尋常百姓家", "烏衣巷口夕陽斜", "一行白鷺上青天", "朱雀橋邊野草花"],answer:0},
      {poem:'【唐詩理解】',text:'《望洞庭》作者？',options:["李白", "杜甫", "劉禹錫", "王之渙"],answer:2},
      {poem:'【唐詩理解】',text:'「白銀盤裡一青螺」前句？',options:["遙望洞庭山水翠", "潭面無風鏡未磨", "千里鶯啼綠映紅", "湖光秋月兩相和"],answer:0},
      {poem:'【唐詩理解】',text:'《贈汪倫》作者？',options:["李白", "杜甫", "王維", "杜牧"],answer:0},
      {poem:'【唐詩理解】',text:'「不及汪倫送我情」前句？',options:["桃花潭水深千尺", "忽聞岸上踏歌聲", "千里江陵一日還", "李白乘舟將欲行"],answer:0},
      {poem:'【唐詩理解】',text:'《早發白帝城》作者？',options:["王維", "杜牧", "杜甫", "李白"],answer:3},
      {poem:'【唐詩理解】',text:'「輕舟已過萬重山」前句？',options:["千里江陵一日還", "兩岸猿聲啼不盡", "孤帆遠影碧空盡", "朝辭白帝彩雲間"],answer:1},
      {poem:'【唐詩理解】',text:'《飲湖上初晴後雨》作者？',options:["杜甫", "蘇軾", "杜牧", "李白"],answer:1},
      {poem:'【唐詩理解】',text:'「淡妝濃抹總相宜」前句？',options:["欲把西湖比西子", "山色空濛雨亦奇", "千里鶯啼綠映紅", "水光瀲灩晴方好"],answer:0},
      {poem:'【唐詩理解】',text:'《題西林壁》作者？',options:["杜甫", "蘇軾", "李白", "杜牧"],answer:1},
      {poem:'【唐詩理解】',text:'「不識廬山真面目」下一句？',options:["遠近高低各不同", "飛流直下三千尺", "只緣身在此山中", "橫看成嶺側成峰"],answer:2},
      {poem:'【唐詩理解】',text:'《春夜喜雨》作者？',options:["李白", "杜甫", "王維", "杜牧"],answer:1},
      {poem:'【唐詩理解】',text:'「隨風潛入夜」下一句？',options:["好雨知時節", "野徑雲俱黑", "潤物細無聲", "當春乃發生"],answer:2},
      {poem:'【唐詩理解】',text:'《登高》作者？',options:["李白", "杜牧", "杜甫", "王維"],answer:2},
      {poem:'【唐詩理解】',text:'《靜夜思》「疑是地上霜」作者？',options:["孟浩然", "王維", "杜甫", "李白"],answer:3},
      {poem:'【唐詩理解】',text:'《九月九日憶山東兄弟》佳節？',options:["重陽節", "中秋節", "元宵節", "端午節"],answer:0},
      {poem:'【標點符號】',text:'閱讀＿＿因為能擴闊視野；寫作＿＿因為能整理思想 空格？',options:["；和：", "，和，", "，和。", "。和！"],answer:1},
      {poem:'【標點符號】',text:'《西遊記》外應加？',options:["冒號", "引號", "括號", "書名號"],answer:3},
      {poem:'【標點符號】',text:'哥哥說＿＿「我先完成報告」',options:["：", "。", "，", "！"],answer:0},
      {poem:'【標點符號】',text:'《三國演義》外應加？',options:["書名號", "引號", "括號", "冒號"],answer:0},
      {poem:'【標點符號】',text:'他反問＿＿「這算甚麼道理」',options:["：", "。", "，", "？"],answer:0},
      {poem:'【標點符號】',text:'游泳＿＿跑步＿＿打球和跳繩',options:["；和：", "，和。", "，和，", "、和、"],answer:3},
      {poem:'【標點符號】',text:'《水滸傳》加標點？',options:["省略號", "括號", "書名號", "引號"],answer:2},
      {poem:'【標點符號】',text:'難道你忘了＿＿後天是考試',options:["？", "。", "！", "："],answer:0},
      {poem:'【標點符號】',text:'《紅樓夢》外應加？',options:["冒號", "書名號", "括號", "引號"],answer:1},
      {poem:'【標點符號】',text:'太好了我們贏了＿＿',options:["。", "！", "：", "？"],answer:1},
      {poem:'【標點符號】',text:'爸爸叮囑＿＿「路上小心」',options:["：", "？", "，", "。"],answer:0},
      {poem:'【標點符號】',text:'春天＿＿夏天＿＿秋天和冬天',options:["，和。", "，和，", "；和：", "、和、"],answer:3},
      {poem:'【標點符號】',text:'《論語》外應加？',options:["冒號", "括號", "書名號", "引號"],answer:2},
      {poem:'【標點符號】',text:'你確定要這樣做＿＿',options:["？", "。", "！", "："],answer:0},
      {poem:'【標點符號】',text:'終於完成了＿＿',options:["？", "：", "。", "！"],answer:3},
      {poem:'【標點符號】',text:'老師說＿＿「大家要努力」',options:["：", "？", "，", "。"],answer:0},
      {poem:'【標點符號】',text:'開心＿＿快樂＿＿幸福和滿足',options:["、和、", "，和，", "；和：", "，和。"],answer:0},
      {poem:'【標點符號】',text:'《史記》加標點？',options:["書名號", "冒號", "括號", "引號"],answer:0},
      {poem:'【標點符號】',text:'為甚麼會這樣＿＿',options:["？", "：", "！", "。"],answer:0},
      {poem:'【標點符號】',text:'好漂亮啊＿＿',options:["！", "？", "：", "。"],answer:0},
      {poem:'【標點符號】',text:'她說＿＿「我相信你」',options:["，", "？", "：", "。"],answer:2},
      {poem:'【標點符號】',text:'勤奮＿＿堅毅＿＿智慧和勇氣',options:["、和、", "，和。", "，和，", "；和："],answer:0},
      {poem:'【標點符號】',text:'《孫子兵法》加標點？',options:["引號", "括號", "冒號", "書名號"],answer:3},
      {poem:'【標點符號】',text:'你還記得我嗎＿＿',options:["？", "。", "：", "！"],answer:0},
      {poem:'【標點符號】',text:'太感動了＿＿',options:["！", "？", "。", "："],answer:0},
      {poem:'【標點符號】',text:'校長說＿＿「恭喜大家」',options:["。", "？", "，", "："],answer:3},
      {poem:'【標點符號】',text:'香港＿＿東京＿＿紐約和倫敦',options:["，和，", "，和。", "；和：", "、和、"],answer:3},
      {poem:'【標點符號】',text:'《唐詩三百首》加標點？',options:["引號", "括號", "冒號", "書名號"],answer:3},
      {poem:'【標點符號】',text:'你覺得對嗎＿＿',options:["！", "。", "？", "："],answer:2},
      {poem:'【標點符號】',text:'成功了＿＿',options:["：", "！", "。", "？"],answer:1},
      {poem:'【找錯字】',text:'「辨論」改正？',options:["題→提", "進→近", "論→倫", "辨→辯"],answer:3},
      {poem:'【找錯字】',text:'「關建」改正？',options:["關→開", "方→放", "定→訂", "建→鍵"],answer:3},
      {poem:'【找錯字】',text:'「段鍊」改正？',options:["鍊→練", "體→休", "段→鍛", "運→遠"],answer:2},
      {poem:'【找錯字】',text:'「泛監」改正？',options:["木→目", "泛→乏", "口→日", "監→濫"],answer:3},
      {poem:'【找錯字】',text:'「掩益」改正？',options:["口→日", "益→蓋", "掩→淹", "木→目"],answer:1},
      {poem:'【找錯字】',text:'「衰求」改正？',options:["口→日", "求→救", "衰→哀", "木→目"],answer:2},
      {poem:'【找錯字】',text:'「骨幹」改正？',options:["木→目", "幹→干", "口→日", "骨→骨"],answer:3},
      {poem:'【找錯字】',text:'「班發」改正？',options:["木→目", "班→頒", "口→日", "發→法"],answer:1},
      {poem:'【找錯字】',text:'「維一」改正？',options:["口→日", "維→唯", "木→目", "一→獨"],answer:1},
      {poem:'【找錯字】',text:'「污辱」改正？',options:["污→侮", "口→日", "木→目", "辱→魯"],answer:0},
      {poem:'【找錯字】',text:'「歷厲」改正？',options:["口→日", "木→目", "厲→勵", "歷→力"],answer:2},
      {poem:'【找錯字】',text:'「密方」改正？',options:["密→秘", "方→放", "口→日", "木→目"],answer:0},
      {poem:'【找錯字】',text:'「原全」改正？',options:["原→完", "口→日", "木→目", "全→泉"],answer:0},
      {poem:'【找錯字】',text:'「仿腦」改正？',options:["腦→惱", "仿→煩", "木→目", "口→日"],answer:1},
      {poem:'【找錯字】',text:'「表楊」改正？',options:["口→日", "木→目", "楊→揚", "表→標"],answer:2},
      {poem:'【找錯字】',text:'「模形」改正？',options:["模→莫", "形→型", "口→日", "木→目"],answer:1},
      {poem:'【找錯字】',text:'「報服」改正？',options:["木→目", "服→復", "報→抱", "口→日"],answer:1},
      {poem:'【找錯字】',text:'「連合」改正？',options:["合→和", "木→目", "連→聯", "口→日"],answer:2},
      {poem:'【找錯字】',text:'「規責」改正？',options:["口→日", "規→歸", "責→則", "木→目"],answer:2},
      {poem:'【找錯字】',text:'「需然」改正？',options:["木→目", "口→日", "需→雖", "然→燃"],answer:2},
      {poem:'【找錯字】',text:'「但白」改正？',options:["但→坦", "白→百", "口→日", "木→目"],answer:0},
      {poem:'【找錯字】',text:'「原亮」改正？',options:["原→源", "木→目", "亮→諒", "口→日"],answer:2},
      {poem:'【找錯字】',text:'「錯拆」改正？',options:["木→目", "口→日", "拆→折", "錯→挫"],answer:2},
      {poem:'【找錯字】',text:'「攻勞」改正？',options:["口→日", "木→目", "攻→功", "勞→牢"],answer:2},
      {poem:'【找錯字】',text:'「磨練」改正？',options:["木→目", "練→煉", "口→日", "磨→摩"],answer:1},
      {poem:'【找錯字】',text:'「罪惡」改正？',options:["口→日", "木→目", "惡→悟", "罪→非"],answer:2},
      {poem:'【找錯字】',text:'「忘記」改正？',options:["記→紀", "忘→記", "木→目", "口→日"],answer:1},
      {poem:'【找錯字】',text:'「情緒」改正？',options:["緒→緒", "口→日", "木→目", "情→清"],answer:0},
      {poem:'【找錯字】',text:'「費物」改正？',options:["口→日", "木→目", "物→務", "費→廢"],answer:3},
      {poem:'【找錯字】',text:'「認承」改正？',options:["口→日", "木→目", "承→認", "認→承"],answer:3}
    ],
  };
  const qs = [...(BANK[grade] || BANK.P4)];
  for (let i = qs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [qs[i], qs[j]] = [qs[j], qs[i]]; }
  return qs;
}

async function handleLBPost(request, env, CORS) {
  try {
    const e = await request.json();
    if (!e.grade || !e.className || e.score == null) return Response.json({ success: false, error: 'Missing fields' }, { status: 400, headers: CORS });
    if (!['P4', 'P5', 'P6'].includes(e.grade)) return Response.json({ success: false, error: 'Invalid grade' }, { status: 400, headers: CORS });
    const score = Number(e.score);
    if (isNaN(score) || score < 0) return Response.json({ success: false, error: 'Invalid score' }, { status: 400, headers: CORS });
    const rec = { grade: e.grade, className: String(e.className).slice(0, 20), studentNo: String(e.studentNo || '').slice(0, 10), score, time: new Date().toISOString() };
    const lb = (await env.LEADERBOARD.get('top20', 'json')) || [];
    lb.push(rec); lb.sort((a, b) => b.score - a.score || new Date(a.time) - new Date(b.time));
    await env.LEADERBOARD.put('top20', JSON.stringify(lb.slice(0, 50)));
    return Response.json({ success: true, leaderboard: lb.slice(0, 20) }, { headers: CORS });
  } catch (_) { return Response.json({ success: false, error: 'Invalid JSON' }, { status: 400, headers: CORS }); }
}
