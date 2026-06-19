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
      {poem:'【部首】',text:'「湖」的部首是甚麼？',options:["艹", "氵", "火", "辛"],answer:1},
      {poem:'【部首】',text:'「橋」的部首是甚麼？',options:["竹", "辶", "食", "木"],answer:3},
      {poem:'【部首】',text:'「跑」的部首是甚麼？',options:["行", "足", "月", "艹"],answer:1},
      {poem:'【部首】',text:'「唱」的部首是甚麼？',options:["頁", "大", "口", "月"],answer:2},
      {poem:'【部首】',text:'「校」的部首是甚麼？',options:["口", "火", "糸", "木"],answer:3},
      {poem:'【部首】',text:'「海」的部首是甚麼？',options:["竹", "子", "氵", "月"],answer:2},
      {poem:'【部首】',text:'「燈」的部首是甚麼？',options:["殳", "寸", "木", "火"],answer:3},
      {poem:'【部首】',text:'「問」的部首是甚麼？',options:["足", "辛", "頁", "門"],answer:3},
      {poem:'【部首】',text:'「姐」的部首是甚麼？',options:["頁", "竹", "攴", "女"],answer:3},
      {poem:'【部首】',text:'「想」的部首是甚麼？',options:["食", "酉", "心", "大"],answer:2},
      {poem:'【部首】',text:'「遠」的部首是甚麼？',options:["辶", "糸", "女", "氵"],answer:0},
      {poem:'【部首】',text:'「船」的部首是甚麼？',options:["食", "舟", "扌", "疒"],answer:1},
      {poem:'【部首】',text:'「跳」的部首是甚麼？',options:["子", "疒", "足", "月"],answer:2},
      {poem:'【部首】',text:'「飯」的部首是甚麼？',options:["王", "月", "食", "日"],answer:2},
      {poem:'【部首】',text:'「樹」的部首是甚麼？',options:["殳", "木", "舟", "目"],answer:1},
      {poem:'【部首】',text:'「房」的部首是甚麼？',options:["火", "戶", "刂", "頁"],answer:1},
      {poem:'【部首】',text:'「狗」的部首是甚麼？',options:["犬", "金", "王", "日"],answer:0},
      {poem:'【部首】',text:'「語」的部首是甚麼？',options:["辛", "田", "戶", "言"],answer:3},
      {poem:'【部首】',text:'「星」的部首是甚麼？',options:["士", "見", "日", "衣"],answer:2},
      {poem:'【部首】',text:'「藍」的部首是甚麼？',options:["火", "艹", "心", "人"],answer:1},
      {poem:'【部首】',text:'「課」的部首是甚麼？',options:["戶", "貝", "言", "竹"],answer:2},
      {poem:'【部首】',text:'「媽」的部首是甚麼？',options:["月", "女", "日", "竹"],answer:1},
      {poem:'【部首】',text:'「清」的部首是甚麼？',options:["刂", "食", "氵", "王"],answer:2},
      {poem:'【部首】',text:'「筆」的部首是甚麼？',options:["女", "辛", "竹", "衣"],answer:2},
      {poem:'【部首】',text:'「院」的部首是甚麼？',options:["目", "人", "衣", "阝"],answer:3},
      {poem:'【部首】',text:'「病」的部首是甚麼？',options:["舟", "行", "疒", "貝"],answer:2},
      {poem:'【部首】',text:'「睡」的部首是甚麼？',options:["尸", "目", "殳", "心"],answer:1},
      {poem:'【部首】',text:'「第」的部首是甚麼？',options:["女", "竹", "頁", "辛"],answer:1},
      {poem:'【部首】',text:'「裝」的部首是甚麼？',options:["女", "竹", "刂", "衣"],answer:3},
      {poem:'【部首】',text:'「跑道」中「跑」的部首是甚麼？',options:["食", "王", "足", "辛"],answer:2},
      {poem:'【詞義辨析】',text:'「高興」的近義詞是甚麼？',options:["以上皆非", "無從判斷", "開心", "視情況而定"],answer:2},
      {poem:'【詞義辨析】',text:'「美麗」的近義詞是甚麼？',options:["漂亮", "視情況而定", "以上皆非", "無從判斷"],answer:0},
      {poem:'【詞義辨析】',text:'「安靜」的反義詞是甚麼？',options:["吵鬧", "無從判斷", "以上皆非", "視情況而定"],answer:0},
      {poem:'【詞義辨析】',text:'「勇敢」的反義詞是甚麼？',options:["無從判斷", "膽小", "以上皆非", "視情況而定"],answer:1},
      {poem:'【詞義辨析】',text:'「快速」的近義詞是甚麼？',options:["無從判斷", "以上皆非", "迅速", "視情況而定"],answer:2},
      {poem:'【詞義辨析】',text:'「寒冷」的反義詞是甚麼？',options:["無從判斷", "視情況而定", "炎熱", "以上皆非"],answer:2},
      {poem:'【詞義辨析】',text:'「明亮」的反義詞是甚麼？',options:["無從判斷", "視情況而定", "黑暗", "以上皆非"],answer:2},
      {poem:'【詞義辨析】',text:'「幫助」的近義詞是甚麼？',options:["視情況而定", "無從判斷", "以上皆非", "協助"],answer:3},
      {poem:'【詞義辨析】',text:'「仔細」的反義詞是甚麼？',options:["以上皆非", "馬虎", "視情況而定", "無從判斷"],answer:1},
      {poem:'【詞義辨析】',text:'「誠實」的反義詞是甚麼？',options:["視情況而定", "無從判斷", "以上皆非", "說謊"],answer:3},
      {poem:'【詞義辨析】',text:'「傷心」的近義詞是甚麼？',options:["難過", "以上皆非", "無從判斷", "視情況而定"],answer:0},
      {poem:'【詞義辨析】',text:'「整齊」的反義詞是甚麼？',options:["無從判斷", "凌亂", "視情況而定", "以上皆非"],answer:1},
      {poem:'【詞義辨析】',text:'「聰明」的近義詞是甚麼？',options:["以上皆非", "機靈", "無從判斷", "視情況而定"],answer:1},
      {poem:'【詞義辨析】',text:'「溫暖」的反義詞是甚麼？',options:["視情況而定", "寒冷", "無從判斷", "以上皆非"],answer:1},
      {poem:'【詞義辨析】',text:'「寬闊」的反義詞是甚麼？',options:["視情況而定", "狹窄", "以上皆非", "無從判斷"],answer:1},
      {poem:'【詞義辨析】',text:'「專心」的近義詞是甚麼？',options:["以上皆非", "無從判斷", "視情況而定", "用心"],answer:3},
      {poem:'【詞義辨析】',text:'「和平」的反義詞是甚麼？',options:["戰亂", "以上皆非", "無從判斷", "視情況而定"],answer:0},
      {poem:'【詞義辨析】',text:'「新鮮」的反義詞是甚麼？',options:["無從判斷", "以上皆非", "視情況而定", "陳舊"],answer:3},
      {poem:'【詞義辨析】',text:'「熱鬧」的反義詞是甚麼？',options:["以上皆非", "無從判斷", "視情況而定", "冷清"],answer:3},
      {poem:'【詞義辨析】',text:'「簡單」的反義詞是甚麼？',options:["困難", "以上皆非", "無從判斷", "視情況而定"],answer:0},
      {poem:'【詞義辨析】',text:'「安全」的反義詞是甚麼？',options:["危險", "以上皆非", "無從判斷", "視情況而定"],answer:0},
      {poem:'【詞義辨析】',text:'「進步」的反義詞是甚麼？',options:["視情況而定", "無從判斷", "以上皆非", "退步"],answer:3},
      {poem:'【詞義辨析】',text:'「勤勞」的反義詞是甚麼？',options:["無從判斷", "視情況而定", "懶惰", "以上皆非"],answer:2},
      {poem:'【詞義辨析】',text:'「清楚」的近義詞是甚麼？',options:["以上皆非", "明白", "無從判斷", "視情況而定"],answer:1},
      {poem:'【詞義辨析】',text:'「容易」的反義詞是甚麼？',options:["視情況而定", "困難", "以上皆非", "無從判斷"],answer:1},
      {poem:'【詞義辨析】',text:'「友善」的近義詞是甚麼？',options:["無從判斷", "親切", "以上皆非", "視情況而定"],answer:1},
      {poem:'【詞義辨析】',text:'「節省」的反義詞是甚麼？',options:["浪費", "以上皆非", "無從判斷", "視情況而定"],answer:0},
      {poem:'【詞義辨析】',text:'「平靜」的反義詞是甚麼？',options:["激動", "視情況而定", "以上皆非", "無從判斷"],answer:0},
      {poem:'【詞義辨析】',text:'「喜歡」的反義詞是甚麼？',options:["以上皆非", "視情況而定", "無從判斷", "討厭"],answer:3},
      {poem:'【詞義辨析】',text:'「認真」的近義詞是甚麼？',options:["無從判斷", "用功", "視情況而定", "以上皆非"],answer:1},
      {poem:'【成語運用】',text:'「一心一意」是形容甚麼？',options:["以上皆非", "無從判斷", "視情況而定", "專心做事"],answer:3},
      {poem:'【成語運用】',text:'「井底之蛙」比喻甚麼人？',options:["視情況而定", "以上皆非", "見識短淺的人", "無從判斷"],answer:2},
      {poem:'【成語運用】',text:'「畫龍點睛」比喻甚麼？',options:["以上皆非", "視情況而定", "無從判斷", "在關鍵地方加上精彩一筆"],answer:3},
      {poem:'【成語運用】',text:'「全神貫注」形容甚麼？',options:["無從判斷", "非常專心", "視情況而定", "以上皆非"],answer:1},
      {poem:'【成語運用】',text:'「自言自語」是甚麼意思？',options:["以上皆非", "視情況而定", "無從判斷", "自己跟自己說話"],answer:3},
      {poem:'【成語運用】',text:'「七上八下」形容甚麼心情？',options:["視情況而定", "心情不安", "以上皆非", "無從判斷"],answer:1},
      {poem:'【成語運用】',text:'「有條有理」形容甚麼？',options:["視情況而定", "無從判斷", "做事或說話有次序", "以上皆非"],answer:2},
      {poem:'【成語運用】',text:'「心直口快」形容甚麼？',options:["視情況而定", "性格直率，說話爽快", "以上皆非", "無從判斷"],answer:1},
      {poem:'【成語運用】',text:'「大吃一驚」表示甚麼？',options:["無從判斷", "以上皆非", "視情況而定", "非常驚訝"],answer:3},
      {poem:'【成語運用】',text:'「目不轉睛」形容甚麼？',options:["以上皆非", "無從判斷", "視情況而定", "專心地看"],answer:3},
      {poem:'【成語運用】',text:'「一五一十」是甚麼意思？',options:["以上皆非", "視情況而定", "無從判斷", "完整而詳細地說出來"],answer:3},
      {poem:'【成語運用】',text:'「不約而同」是甚麼意思？',options:["視情況而定", "無從判斷", "以上皆非", "沒有事先約定而做出同樣行動"],answer:3},
      {poem:'【成語運用】',text:'「千方百計」形容甚麼？',options:["無從判斷", "以上皆非", "視情況而定", "想盡各種辦法"],answer:3},
      {poem:'【成語運用】',text:'「東張西望」形容甚麼？',options:["視情況而定", "以上皆非", "到處張望", "無從判斷"],answer:2},
      {poem:'【成語運用】',text:'「三心兩意」形容甚麼？',options:["無從判斷", "做事不專心", "視情況而定", "以上皆非"],answer:1},
      {poem:'【成語運用】',text:'「一見如故」是甚麼意思？',options:["視情況而定", "以上皆非", "無從判斷", "初次見面卻像老朋友一樣"],answer:3},
      {poem:'【成語運用】',text:'「半信半疑」形容甚麼？',options:["有些相信又有些懷疑", "視情況而定", "以上皆非", "無從判斷"],answer:0},
      {poem:'【成語運用】',text:'「津津有味」通常形容甚麼？',options:["吃得或讀得很有味道", "視情況而定", "以上皆非", "無從判斷"],answer:0},
      {poem:'【成語運用】',text:'「手忙腳亂」形容甚麼？',options:["做事慌亂", "以上皆非", "視情況而定", "無從判斷"],answer:0},
      {poem:'【成語運用】',text:'「自作自受」是甚麼意思？',options:["無從判斷", "自己做錯事，自己承受後果", "以上皆非", "視情況而定"],answer:1},
      {poem:'【成語運用】',text:'「理直氣壯」形容甚麼？',options:["視情況而定", "理由充分，說話有氣勢", "以上皆非", "無從判斷"],answer:1},
      {poem:'【成語運用】',text:'「左思右想」是甚麼意思？',options:["以上皆非", "視情況而定", "無從判斷", "反覆思考"],answer:3},
      {poem:'【成語運用】',text:'「一乾二淨」形容甚麼？',options:["無從判斷", "視情況而定", "非常乾淨", "以上皆非"],answer:2},
      {poem:'【成語運用】',text:'「來之不易」表示甚麼？',options:["得來很不容易", "無從判斷", "視情況而定", "以上皆非"],answer:0},
      {poem:'【成語運用】',text:'「名列前茅」是甚麼意思？',options:["排名靠前", "視情況而定", "以上皆非", "無從判斷"],answer:0},
      {poem:'【成語運用】',text:'「不慌不忙」形容甚麼？',options:["無從判斷", "以上皆非", "視情況而定", "沉着鎮定"],answer:3},
      {poem:'【成語運用】',text:'「守口如瓶」是甚麼意思？',options:["以上皆非", "視情況而定", "非常保守秘密", "無從判斷"],answer:2},
      {poem:'【成語運用】',text:'「力不從心」形容甚麼？',options:["心裡想做卻沒有能力做到", "視情況而定", "無從判斷", "以上皆非"],answer:0},
      {poem:'【成語運用】',text:'「一模一樣」表示甚麼？',options:["完全相同", "視情況而定", "無從判斷", "以上皆非"],answer:0},
      {poem:'【成語運用】',text:'「念念不忘」形容甚麼？',options:["視情況而定", "一直記着，不會忘記", "以上皆非", "無從判斷"],answer:1},
      {poem:'【詞語填充】',text:'同學發言時，我們要＿＿聆聽。',options:["專心", "繼續", "仔細", "穩定"],answer:0},
      {poem:'【詞語填充】',text:'爸爸做事很＿＿，所以大家都信任他。',options:["熱心", "保持", "穩定", "可靠"],answer:3},
      {poem:'【詞語填充】',text:'這本故事書內容十分＿＿。',options:["繼續", "尊重", "精彩", "清晰"],answer:2},
      {poem:'【詞語填充】',text:'我們要＿＿公物，不可隨便破壞。',options:["愛護", "清楚", "仔細", "保持"],answer:0},
      {poem:'【詞語填充】',text:'天氣十分＿＿，適合到郊外活動。',options:["積極", "保持", "晴朗", "冷靜"],answer:2},
      {poem:'【詞語填充】',text:'她做事很＿＿，所以很少出錯。',options:["清晰", "仔細", "細心", "積極"],answer:2},
      {poem:'【詞語填充】',text:'遇到困難時，我們要＿＿面對。',options:["熱心", "努力", "勇敢", "冷靜"],answer:2},
      {poem:'【詞語填充】',text:'學校舉行運動會，同學們都很＿＿。',options:["興奮", "仔細", "專心", "保持"],answer:0},
      {poem:'【詞語填充】',text:'這篇文章條理＿＿，容易明白。',options:["冷靜", "仔細", "清晰", "友善"],answer:2},
      {poem:'【詞語填充】',text:'哥哥每天都＿＿溫習，所以成績不錯。',options:["冷靜", "積極", "努力", "仔細"],answer:2},
      {poem:'【詞語填充】',text:'老師常常＿＿我們多閱讀課外書。',options:["熱心", "鼓勵", "保持", "認真"],answer:1},
      {poem:'【詞語填充】',text:'圖書館裡要保持＿＿。',options:["認真", "安靜", "熱心", "積極"],answer:1},
      {poem:'【詞語填充】',text:'這份禮物雖然簡單，卻很有＿＿。',options:["心意", "穩定", "積極", "友善"],answer:0},
      {poem:'【詞語填充】',text:'經過反覆練習，她的朗誦技巧明顯＿＿了。',options:["進步", "主動", "仔細", "認真"],answer:0},
      {poem:'【詞語填充】',text:'這位同學十分＿＿，常主動幫助別人。',options:["穩定", "專心", "熱心", "保持"],answer:2},
      {poem:'【詞語填充】',text:'我們應該＿＿時間，不要浪費光陰。',options:["珍惜", "穩定", "友善", "專心"],answer:0},
      {poem:'【詞語填充】',text:'面對失敗，不應灰心，要＿＿再試。',options:["尊重", "冷靜", "熱心", "繼續"],answer:3},
      {poem:'【詞語填充】',text:'班長做事公平，深受同學＿＿。',options:["熱心", "積極", "繼續", "信任"],answer:3},
      {poem:'【詞語填充】',text:'校園裡種了很多花草，環境十分＿＿。',options:["熱心", "穩定", "優美", "保持"],answer:2},
      {poem:'【詞語填充】',text:'他回答問題時聲音＿＿，大家都聽不見。',options:["專心", "仔細", "微弱", "冷靜"],answer:2},
      {poem:'【詞語填充】',text:'這篇童話故事非常＿＿，小朋友都喜歡看。',options:["有趣", "清楚", "冷靜", "繼續"],answer:0},
      {poem:'【詞語填充】',text:'過馬路前要先看清楚，注意＿＿。',options:["清楚", "繼續", "冷靜", "安全"],answer:3},
      {poem:'【詞語填充】',text:'小明上課不專心，常常＿＿窗外。',options:["認真", "冷靜", "望向", "積極"],answer:2},
      {poem:'【詞語填充】',text:'經過老師解釋後，我終於＿＿了這道題目。',options:["努力", "主動", "保持", "明白"],answer:3},
      {poem:'【詞語填充】',text:'下課鐘聲一響，同學們便＿＿地走出課室。',options:["主動", "積極", "清晰", "有秩序"],answer:3},
      {poem:'【詞語填充】',text:'這幅圖畫色彩＿＿，十分吸引。',options:["鮮明", "穩定", "熱心", "冷靜"],answer:0},
      {poem:'【詞語填充】',text:'同學們互相合作，終於＿＿完成任務。',options:["友善", "專心", "清晰", "順利"],answer:3},
      {poem:'【詞語填充】',text:'爸爸提醒我做事要有＿＿，不要急躁。',options:["尊重", "清楚", "熱心", "耐性"],answer:3},
      {poem:'【詞語填充】',text:'我們要＿＿別人的意見，學會尊重。',options:["清晰", "尊重", "繼續", "積極"],answer:1},
      {poem:'【詞語填充】',text:'媽媽把房間整理得十分＿＿。',options:["專心", "保持", "清晰", "整潔"],answer:3},
      {poem:'【修辭辨識】',text:'「月亮像一隻彎彎的小船。」用了甚麼修辭？',options:["反問", "擬人", "比喻", "設問"],answer:2},
      {poem:'【修辭辨識】',text:'「花兒在風中點頭微笑。」用了甚麼修辭？',options:["對偶", "對比", "擬人", "比喻"],answer:2},
      {poem:'【修辭辨識】',text:'「他跑得比風還快。」用了甚麼修辭？',options:["比喻", "反覆", "誇張", "排比"],answer:2},
      {poem:'【修辭辨識】',text:'「我愛閱讀，愛思考，愛寫作。」用了甚麼修辭？',options:["比喻", "反問", "對比", "排比"],answer:3},
      {poem:'【修辭辨識】',text:'「這樣的景色，怎能不叫人喜愛呢？」用了甚麼修辭？',options:["對比", "排比", "反問", "誇張"],answer:2},
      {poem:'【修辭辨識】',text:'「甚麼是真正的勇氣？真正的勇氣是跌倒後再站起來。」用了甚麼修辭？',options:["擬人", "誇張", "設問", "對偶"],answer:2},
      {poem:'【修辭辨識】',text:'「盼呀，盼呀，春天終於來了。」用了甚麼修辭？',options:["誇張", "設問", "反覆", "比喻"],answer:2},
      {poem:'【修辭辨識】',text:'「書像一把鑰匙，打開知識的大門。」用了甚麼修辭？',options:["擬人", "排比", "比喻", "對偶"],answer:2},
      {poem:'【修辭辨識】',text:'「小鳥在枝頭唱歌。」用了甚麼修辭？',options:["擬人", "排比", "反覆", "對偶"],answer:0},
      {poem:'【修辭辨識】',text:'「教室裡安靜得連一根針掉下來也聽得見。」用了甚麼修辭？',options:["誇張", "比喻", "排比", "擬人"],answer:0},
      {poem:'【修辭辨識】',text:'「天更藍了，草更綠了，花更紅了。」用了甚麼修辭？',options:["比喻", "設問", "擬人", "排比"],answer:3},
      {poem:'【修辭辨識】',text:'「誰不想把事情做好呢？」用了甚麼修辭？',options:["反問", "反覆", "設問", "比喻"],answer:0},
      {poem:'【修辭辨識】',text:'「甚麼是幸福？幸福是和家人一起吃晚飯。」用了甚麼修辭？',options:["設問", "對比", "反問", "擬人"],answer:0},
      {poem:'【修辭辨識】',text:'「想啊，想啊，我終於想出答案了。」用了甚麼修辭？',options:["比喻", "對偶", "反覆", "誇張"],answer:2},
      {poem:'【修辭辨識】',text:'「太陽公公露出了笑臉。」用了甚麼修辭？',options:["誇張", "對比", "擬人", "比喻"],answer:2},
      {poem:'【修辭辨識】',text:'「母愛像陽光一樣溫暖。」用了甚麼修辭？',options:["誇張", "對偶", "比喻", "排比"],answer:2},
      {poem:'【修辭辨識】',text:'「這條路長得走也走不完。」用了甚麼修辭？',options:["比喻", "誇張", "設問", "反覆"],answer:1},
      {poem:'【修辭辨識】',text:'「他愛看書，愛畫畫，愛旅行。」用了甚麼修辭？',options:["對比", "誇張", "擬人", "排比"],answer:3},
      {poem:'【修辭辨識】',text:'「難道我們不應珍惜時間嗎？」用了甚麼修辭？',options:["設問", "反問", "對偶", "對比"],answer:1},
      {poem:'【修辭辨識】',text:'「甚麼叫努力？努力就是每天進步一點點。」用了甚麼修辭？',options:["反問", "比喻", "誇張", "設問"],answer:3},
      {poem:'【修辭辨識】',text:'「看啊，看啊，煙花升上天空了。」用了甚麼修辭？',options:["比喻", "對比", "設問", "反覆"],answer:3},
      {poem:'【修辭辨識】',text:'「白雲像棉花糖。」用了甚麼修辭？',options:["對偶", "誇張", "比喻", "設問"],answer:2},
      {poem:'【修辭辨識】',text:'「風兒輕輕地唱着歌。」用了甚麼修辭？',options:["擬人", "對偶", "反覆", "反問"],answer:0},
      {poem:'【修辭辨識】',text:'「餓得可以吃下一頭牛。」用了甚麼修辭？',options:["對偶", "排比", "對比", "誇張"],answer:3},
      {poem:'【修辭辨識】',text:'「老師是園丁，學生是花朵。」用了甚麼修辭？',options:["比喻", "排比", "反覆", "反問"],answer:0},
      {poem:'【修辭辨識】',text:'「山朗潤起來了，水漲起來了，太陽的臉紅起來了。」用了甚麼修辭？',options:["反覆", "誇張", "反問", "排比"],answer:3},
      {poem:'【修辭辨識】',text:'「這點小事，怎會難倒我呢？」用了甚麼修辭？',options:["對比", "反問", "反覆", "對偶"],answer:1},
      {poem:'【修辭辨識】',text:'「為甚麼要讀書？因為讀書能增長知識。」用了甚麼修辭？',options:["排比", "反覆", "誇張", "設問"],answer:3},
      {poem:'【修辭辨識】',text:'「等啊，等啊，巴士終於來了。」用了甚麼修辭？',options:["對比", "反覆", "設問", "排比"],answer:1},
      {poem:'【修辭辨識】',text:'「雨點在窗上跳舞。」用了甚麼修辭？',options:["對比", "誇張", "擬人", "反問"],answer:2},
      {poem:'【唐詩理解】',text:'《靜夜思》的作者是誰？',options:["楊萬里", "李商隱", "陸游", "李白"],answer:3},
      {poem:'【唐詩理解】',text:'「舉頭望明月」的下一句是甚麼？',options:["以上皆非", "低頭思故鄉", "另有所指", "無從判斷"],answer:1},
      {poem:'【唐詩理解】',text:'「白日依山盡」的下一句是甚麼？',options:["另有所指", "無從判斷", "以上皆非", "黃河入海流"],answer:3},
      {poem:'【唐詩理解】',text:'《登鸛雀樓》的作者是誰？',options:["柳宗元", "王維", "王勃", "王之渙"],answer:3},
      {poem:'【唐詩理解】',text:'「春眠不覺曉」出自哪一首詩？',options:["以上皆非", "另有所指", "無從判斷", "《春曉》"],answer:3},
      {poem:'【唐詩理解】',text:'《春曉》的作者是誰？',options:["孟浩然", "李清照", "杜甫", "王昌齡"],answer:0},
      {poem:'【唐詩理解】',text:'「夜來風雨聲」的下一句是甚麼？',options:["另有所指", "花落知多少", "無從判斷", "以上皆非"],answer:1},
      {poem:'【唐詩理解】',text:'《鹿柴》的作者是誰？',options:["王維", "李白", "蘇軾", "李清照"],answer:0},
      {poem:'【唐詩理解】',text:'「空山不見人」的下一句是甚麼？',options:["另有所指", "但聞人語響", "以上皆非", "無從判斷"],answer:1},
      {poem:'【唐詩理解】',text:'《梅花》的作者是誰？',options:["王安石", "陳子昂", "蘇軾", "高適"],answer:0},
      {poem:'【唐詩理解】',text:'「牆角數枝梅」的下一句是甚麼？',options:["凌寒獨自開", "以上皆非", "另有所指", "無從判斷"],answer:0},
      {poem:'【唐詩理解】',text:'《江雪》的作者是誰？',options:["陸游", "柳宗元", "王勃", "李白"],answer:1},
      {poem:'【唐詩理解】',text:'「千山鳥飛絕」的下一句是甚麼？',options:["無從判斷", "萬徑人蹤滅", "以上皆非", "另有所指"],answer:1},
      {poem:'【唐詩理解】',text:'《憫農》的作者是誰？',options:["杜牧", "葉紹翁", "駱賓王", "李紳"],answer:3},
      {poem:'【唐詩理解】',text:'「鋤禾日當午」的下一句是甚麼？',options:["無從判斷", "汗滴禾下土", "以上皆非", "另有所指"],answer:1},
      {poem:'【唐詩理解】',text:'「誰知盤中餐」的下一句是甚麼？',options:["無從判斷", "以上皆非", "另有所指", "粒粒皆辛苦"],answer:3},
      {poem:'【唐詩理解】',text:'《夜宿山寺》的作者是誰？',options:["李白", "蘇軾", "王之渙", "劉禹錫"],answer:0},
      {poem:'【唐詩理解】',text:'「危樓高百尺」的下一句是甚麼？',options:["手可摘星辰", "以上皆非", "另有所指", "無從判斷"],answer:0},
      {poem:'【唐詩理解】',text:'《尋隱者不遇》的作者是誰？',options:["王維", "張繼", "賈島", "李清照"],answer:2},
      {poem:'【唐詩理解】',text:'「松下問童子」的下一句是甚麼？',options:["無從判斷", "另有所指", "以上皆非", "言師採藥去"],answer:3},
      {poem:'【唐詩理解】',text:'《池上》的作者是誰？',options:["李白", "陸游", "白居易", "杜牧"],answer:2},
      {poem:'【唐詩理解】',text:'「小娃撐小艇」的下一句是甚麼？',options:["無從判斷", "另有所指", "以上皆非", "偷採白蓮回"],answer:3},
      {poem:'【唐詩理解】',text:'《早發白帝城》的作者是誰？',options:["李白", "劉禹錫", "張繼", "王之渙"],answer:0},
      {poem:'【唐詩理解】',text:'「朝辭白帝彩雲間」的下一句是甚麼？',options:["另有所指", "千里江陵一日還", "無從判斷", "以上皆非"],answer:1},
      {poem:'【唐詩理解】',text:'《絕句》「兩個黃鸝鳴翠柳」的作者是誰？',options:["王之渙", "崔顥", "杜甫", "王勃"],answer:2},
      {poem:'【唐詩理解】',text:'「一行白鷺上青天」的上一句是甚麼？',options:["兩個黃鸝鳴翠柳", "以上皆非", "另有所指", "無從判斷"],answer:0},
      {poem:'【唐詩理解】',text:'《山行》的作者是誰？',options:["杜牧", "王之渙", "崔顥", "杜甫"],answer:0},
      {poem:'【唐詩理解】',text:'「遠上寒山石徑斜」的下一句是甚麼？',options:["以上皆非", "白雲生處有人家", "另有所指", "無從判斷"],answer:1},
      {poem:'【唐詩理解】',text:'《回鄉偶書》的作者是誰？',options:["陸游", "賀知章", "李商隱", "王維"],answer:1},
      {poem:'【唐詩理解】',text:'「少小離家老大回」的下一句是甚麼？',options:["鄉音無改鬢毛衰", "無從判斷", "以上皆非", "另有所指"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：妹妹最喜歡吃平果。',options:["不需改正", "平→蘋", "蘋→平", "以上皆非"],answer:1},
      {poem:'【找錯字】',text:'句子中有一個錯字：同學們在操塲上做早操。',options:["塲→場", "以上皆非", "場→塲", "不需改正"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：圖書館裡十分安靖。',options:["不需改正", "靖→靜", "以上皆非", "靜→靖"],answer:1},
      {poem:'【找錯字】',text:'句子中有一個錯字：今天的天氣很晴郎。',options:["郎→朗", "不需改正", "以上皆非", "朗→郎"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：他做事十分認貞。',options:["不需改正", "貞→真", "真→貞", "以上皆非"],answer:1},
      {poem:'【找錯字】',text:'句子中有一個錯字：我們要遵首規則。',options:["首→守", "守→首", "以上皆非", "不需改正"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：妹妹專心聆聼老師講課。',options:["不需改正", "聼→聽", "聽→聼", "以上皆非"],answer:1},
      {poem:'【找錯字】',text:'句子中有一個錯字：同學們互相古勵。',options:["不需改正", "以上皆非", "鼓→古", "古→鼓"],answer:3},
      {poem:'【找錯字】',text:'句子中有一個錯字：弟弟喜歡看童話固事。',options:["故→固", "不需改正", "以上皆非", "固→故"],answer:3},
      {poem:'【找錯字】',text:'句子中有一個錯字：媽媽把房間收拾得很整其。',options:["其→齊", "齊→其", "以上皆非", "不需改正"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：這條小路十分完曲。',options:["以上皆非", "彎→完", "不需改正", "完→彎"],answer:3},
      {poem:'【找錯字】',text:'句子中有一個錯字：他常常忘記帶手冊子。',options:["冊子→冊", "不需改正", "以上皆非", "冊→冊子"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：請你保恃課室清潔。',options:["恃→持", "持→恃", "不需改正", "以上皆非"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：校園裡種滿了花草樹木，環境很優羙。',options:["美→羙", "以上皆非", "羙→美", "不需改正"],answer:2},
      {poem:'【找錯字】',text:'句子中有一個錯字：老師稱贊我們表現良好。',options:["讚→贊", "以上皆非", "不需改正", "贊→讚"],answer:3},
      {poem:'【找錯字】',text:'句子中有一個錯字：這本書非常精采。',options:["采→彩", "彩→采", "以上皆非", "不需改正"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：同學們在禮堂參加表演比塞。',options:["塞→賽", "以上皆非", "不需改正", "賽→塞"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：我每天都準時番學。',options:["以上皆非", "不需改正", "返→番", "番→返"],answer:3},
      {poem:'【找錯字】',text:'句子中有一個錯字：媽媽煮的湯十分鮮甛。',options:["不需改正", "以上皆非", "甛→甜", "甜→甛"],answer:2},
      {poem:'【找錯字】',text:'句子中有一個錯字：他把地上掉落的垃極拾起。',options:["圾→極", "不需改正", "極→圾", "以上皆非"],answer:2},
      {poem:'【找錯字】',text:'句子中有一個錯字：我會把今天的事情牢牢記着，不會忘紀。',options:["紀→記", "不需改正", "記→紀", "以上皆非"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：她的歌聲很柔和，十分月耳。',options:["月→悅", "不需改正", "悅→月", "以上皆非"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：爸爸工作很芒，所以很晚才回家。',options:["芒→忙", "忙→芒", "不需改正", "以上皆非"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：校長在台上至詞。',options:["以上皆非", "至→致", "致→至", "不需改正"],answer:1},
      {poem:'【找錯字】',text:'句子中有一個錯字：他把作業薄交給老師。',options:["薄→簿", "簿→薄", "不需改正", "以上皆非"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：這個答安非常清楚。',options:["不需改正", "案→安", "以上皆非", "安→案"],answer:3}
    ],
    P5: [
      {poem:'【部首】',text:'「懶」的部首是甚麼？',options:["犬", "刂", "火", "忄"],answer:3},
      {poem:'【部首】',text:'「鋼」的部首是甚麼？',options:["尸", "王", "貝", "金"],answer:3},
      {poem:'【部首】',text:'「裁」的部首是甚麼？',options:["手", "衣", "扌", "火"],answer:1},
      {poem:'【部首】',text:'「穩」的部首是甚麼？',options:["士", "艹", "手", "禾"],answer:3},
      {poem:'【部首】',text:'「劇」的部首是甚麼？',options:["刂", "糸", "阝", "月"],answer:0},
      {poem:'【部首】',text:'「懷」的部首是甚麼？',options:["寸", "月", "酉", "忄"],answer:3},
      {poem:'【部首】',text:'「鍾」的部首是甚麼？',options:["女", "攴", "氵", "金"],answer:3},
      {poem:'【部首】',text:'「靠」的部首是甚麼？',options:["尸", "心", "非", "扌"],answer:2},
      {poem:'【部首】',text:'「燃」的部首是甚麼？',options:["火", "疒", "非", "舟"],answer:0},
      {poem:'【部首】',text:'「慶」的部首是甚麼？',options:["广", "王", "行", "殳"],answer:0},
      {poem:'【部首】',text:'「誠」的部首是甚麼？',options:["日", "言", "尸", "疒"],answer:1},
      {poem:'【部首】',text:'「搬」的部首是甚麼？',options:["頁", "衣", "手", "行"],answer:2},
      {poem:'【部首】',text:'「醒」的部首是甚麼？',options:["手", "辛", "犬", "酉"],answer:3},
      {poem:'【部首】',text:'「疑」的部首是甚麼？',options:["火", "土", "疋", "殳"],answer:2},
      {poem:'【部首】',text:'「獎」的部首是甚麼？',options:["犬", "辛", "竹", "心"],answer:0},
      {poem:'【部首】',text:'「箭」的部首是甚麼？',options:["子", "竹", "戶", "行"],answer:1},
      {poem:'【部首】',text:'「遍」的部首是甚麼？',options:["辶", "日", "月", "糸"],answer:0},
      {poem:'【部首】',text:'「導」的部首是甚麼？',options:["糸", "月", "寸", "辛"],answer:2},
      {poem:'【部首】',text:'「壓」的部首是甚麼？',options:["木", "女", "土", "戶"],answer:2},
      {poem:'【部首】',text:'「願」的部首是甚麼？',options:["口", "火", "頁", "犬"],answer:2},
      {poem:'【部首】',text:'「醒目」中「醒」的部首是甚麼？',options:["酉", "目", "食", "疒"],answer:0},
      {poem:'【部首】',text:'「額」的部首是甚麼？',options:["攴", "竹", "扌", "頁"],answer:3},
      {poem:'【部首】',text:'「縮」的部首是甚麼？',options:["士", "糸", "彡", "土"],answer:1},
      {poem:'【部首】',text:'「讀」的部首是甚麼？',options:["行", "女", "足", "言"],answer:3},
      {poem:'【部首】',text:'「環」的部首是甚麼？',options:["言", "日", "見", "王"],answer:3},
      {poem:'【部首】',text:'「影」的部首是甚麼？',options:["彡", "衣", "行", "見"],answer:0},
      {poem:'【部首】',text:'「腦」的部首是甚麼？',options:["月", "手", "辶", "大"],answer:0},
      {poem:'【部首】',text:'「藝」的部首是甚麼？',options:["艹", "刂", "竹", "女"],answer:0},
      {poem:'【部首】',text:'「整」的部首是甚麼？',options:["攴", "辶", "刂", "辛"],answer:0},
      {poem:'【部首】',text:'「郵」的部首是甚麼？',options:["氵", "阝", "貝", "辶"],answer:1},
      {poem:'【詞義辨析】',text:'「珍貴」的近義詞是甚麼？',options:["以上皆非", "視情況而定", "無從判斷", "寶貴"],answer:3},
      {poem:'【詞義辨析】',text:'「炎熱」的反義詞是甚麼？',options:["寒冷", "視情況而定", "以上皆非", "無從判斷"],answer:0},
      {poem:'【詞義辨析】',text:'「清楚」的近義詞是甚麼？',options:["以上皆非", "明白", "無從判斷", "視情況而定"],answer:1},
      {poem:'【詞義辨析】',text:'「迅速」的近義詞是甚麼？',options:["以上皆非", "快捷", "視情況而定", "無從判斷"],answer:1},
      {poem:'【詞義辨析】',text:'「誠實」的反義詞是甚麼？',options:["以上皆非", "視情況而定", "虛假", "無從判斷"],answer:2},
      {poem:'【詞義辨析】',text:'「困難」的反義詞是甚麼？',options:["無從判斷", "容易", "以上皆非", "視情況而定"],answer:1},
      {poem:'【詞義辨析】',text:'「溫暖」的近義詞是甚麼？',options:["視情況而定", "暖和", "以上皆非", "無從判斷"],answer:1},
      {poem:'【詞義辨析】',text:'「簡單」的反義詞是甚麼？',options:["無從判斷", "視情況而定", "以上皆非", "複雜"],answer:3},
      {poem:'【詞義辨析】',text:'「熱誠」的近義詞是甚麼？',options:["無從判斷", "視情況而定", "以上皆非", "熱心"],answer:3},
      {poem:'【詞義辨析】',text:'「擔心」的近義詞是甚麼？',options:["以上皆非", "視情況而定", "無從判斷", "憂慮"],answer:3},
      {poem:'【詞義辨析】',text:'「勝利」的反義詞是甚麼？',options:["失敗", "視情況而定", "無從判斷", "以上皆非"],answer:0},
      {poem:'【詞義辨析】',text:'「欣賞」的近義詞是甚麼？',options:["以上皆非", "讚賞", "無從判斷", "視情況而定"],answer:1},
      {poem:'【詞義辨析】',text:'「節省」的反義詞是甚麼？',options:["浪費", "以上皆非", "無從判斷", "視情況而定"],answer:0},
      {poem:'【詞義辨析】',text:'「模糊」的反義詞是甚麼？',options:["清晰", "視情況而定", "無從判斷", "以上皆非"],answer:0},
      {poem:'【詞義辨析】',text:'「堅持」的近義詞是甚麼？',options:["以上皆非", "無從判斷", "堅守", "視情況而定"],answer:2},
      {poem:'【詞義辨析】',text:'「慷慨」的反義詞是甚麼？',options:["無從判斷", "視情況而定", "以上皆非", "吝嗇"],answer:3},
      {poem:'【詞義辨析】',text:'「普通」的反義詞是甚麼？',options:["以上皆非", "特別", "無從判斷", "視情況而定"],answer:1},
      {poem:'【詞義辨析】',text:'「善良」的近義詞是甚麼？',options:["無從判斷", "以上皆非", "視情況而定", "仁慈"],answer:3},
      {poem:'【詞義辨析】',text:'「危險」的反義詞是甚麼？',options:["以上皆非", "安全", "無從判斷", "視情況而定"],answer:1},
      {poem:'【詞義辨析】',text:'「慌張」的近義詞是甚麼？',options:["視情況而定", "緊張", "無從判斷", "以上皆非"],answer:1},
      {poem:'【詞義辨析】',text:'「整潔」的反義詞是甚麼？',options:["凌亂", "無從判斷", "視情況而定", "以上皆非"],answer:0},
      {poem:'【詞義辨析】',text:'「耐心」的反義詞是甚麼？',options:["急躁", "視情況而定", "無從判斷", "以上皆非"],answer:0},
      {poem:'【詞義辨析】',text:'「穩定」的反義詞是甚麼？',options:["以上皆非", "視情況而定", "無從判斷", "動盪"],answer:3},
      {poem:'【詞義辨析】',text:'「豐富」的反義詞是甚麼？',options:["無從判斷", "以上皆非", "視情況而定", "貧乏"],answer:3},
      {poem:'【詞義辨析】',text:'「聰敏」的近義詞是甚麼？',options:["機智", "視情況而定", "以上皆非", "無從判斷"],answer:0},
      {poem:'【詞義辨析】',text:'「開始」的反義詞是甚麼？',options:["以上皆非", "視情況而定", "無從判斷", "結束"],answer:3},
      {poem:'【詞義辨析】',text:'「柔和」的反義詞是甚麼？',options:["以上皆非", "視情況而定", "無從判斷", "強烈"],answer:3},
      {poem:'【詞義辨析】',text:'「積極」的反義詞是甚麼？',options:["無從判斷", "消極", "視情況而定", "以上皆非"],answer:1},
      {poem:'【詞義辨析】',text:'「清閒」的反義詞是甚麼？',options:["視情況而定", "無從判斷", "忙碌", "以上皆非"],answer:2},
      {poem:'【詞義辨析】',text:'「鼓勵」的近義詞是甚麼？',options:["勉勵", "無從判斷", "視情況而定", "以上皆非"],answer:0},
      {poem:'【成語運用】',text:'「專心致志」是形容甚麼？',options:["視情況而定", "以上皆非", "專心投入", "無從判斷"],answer:2},
      {poem:'【成語運用】',text:'「畫蛇添足」比喻甚麼？',options:["視情況而定", "無從判斷", "以上皆非", "多此一舉"],answer:3},
      {poem:'【成語運用】',text:'「津津有味」通常形容甚麼？',options:["很有味道、很有興趣", "以上皆非", "視情況而定", "無從判斷"],answer:0},
      {poem:'【成語運用】',text:'「半途而廢」是甚麼意思？',options:["無從判斷", "視情況而定", "以上皆非", "事情做到一半就放棄"],answer:3},
      {poem:'【成語運用】',text:'「一舉兩得」是甚麼意思？',options:["視情況而定", "以上皆非", "做一件事得到兩種好處", "無從判斷"],answer:2},
      {poem:'【成語運用】',text:'「目不轉睛」形容甚麼？',options:["以上皆非", "視情況而定", "無從判斷", "專注地看"],answer:3},
      {poem:'【成語運用】',text:'「異口同聲」形容甚麼？',options:["以上皆非", "視情況而定", "無從判斷", "大家說同樣的話"],answer:3},
      {poem:'【成語運用】',text:'「不慌不忙」形容甚麼態度？',options:["視情況而定", "以上皆非", "無從判斷", "沉着鎮定"],answer:3},
      {poem:'【成語運用】',text:'「守株待兔」比喻甚麼？',options:["視情況而定", "以上皆非", "不主動努力，只想僥倖成功", "無從判斷"],answer:2},
      {poem:'【成語運用】',text:'「自相矛盾」是甚麼意思？',options:["無從判斷", "以上皆非", "視情況而定", "自己說的話前後不一致"],answer:3},
      {poem:'【成語運用】',text:'「胸有成竹」比喻甚麼？',options:["做事前已有打算", "視情況而定", "無從判斷", "以上皆非"],answer:0},
      {poem:'【成語運用】',text:'「有備無患」是甚麼意思？',options:["事先準備，就可避免憂患", "視情況而定", "無從判斷", "以上皆非"],answer:0},
      {poem:'【成語運用】',text:'「日新月異」形容甚麼？',options:["以上皆非", "視情況而定", "無從判斷", "進步很快，天天都有變化"],answer:3},
      {poem:'【成語運用】',text:'「全力以赴」是甚麼意思？',options:["無從判斷", "用盡全部力量去做", "視情況而定", "以上皆非"],answer:1},
      {poem:'【成語運用】',text:'「名副其實」是甚麼意思？',options:["視情況而定", "名稱或名聲和實際情況相符", "以上皆非", "無從判斷"],answer:1},
      {poem:'【成語運用】',text:'「自力更生」形容甚麼？',options:["視情況而定", "以上皆非", "依靠自己的力量生活", "無從判斷"],answer:2},
      {poem:'【成語運用】',text:'「手不釋卷」形容甚麼？',options:["勤奮讀書", "視情況而定", "無從判斷", "以上皆非"],answer:0},
      {poem:'【成語運用】',text:'「對答如流」形容甚麼？',options:["以上皆非", "回答問題流利", "無從判斷", "視情況而定"],answer:1},
      {poem:'【成語運用】',text:'「水落石出」比喻甚麼？',options:["事情真相大白", "視情況而定", "以上皆非", "無從判斷"],answer:0},
      {poem:'【成語運用】',text:'「精打細算」形容甚麼？',options:["做事仔細計算，不浪費", "視情況而定", "以上皆非", "無從判斷"],answer:0},
      {poem:'【成語運用】',text:'「一絲不苟」形容甚麼？',options:["視情況而定", "以上皆非", "做事認真仔細", "無從判斷"],answer:2},
      {poem:'【成語運用】',text:'「不言而喻」是甚麼意思？',options:["視情況而定", "無從判斷", "以上皆非", "不用說也能明白"],answer:3},
      {poem:'【成語運用】',text:'「無微不至」形容甚麼？',options:["無從判斷", "視情況而定", "照顧得非常周到", "以上皆非"],answer:2},
      {poem:'【成語運用】',text:'「入木三分」原指甚麼，現多比喻甚麼？',options:["無從判斷", "以上皆非", "視情況而定", "見解或描寫深刻有力"],answer:3},
      {poem:'【成語運用】',text:'「再接再厲」形容甚麼？',options:["以上皆非", "視情況而定", "無從判斷", "繼續努力"],answer:3},
      {poem:'【成語運用】',text:'「得心應手」形容甚麼？',options:["視情況而定", "做事很順手", "無從判斷", "以上皆非"],answer:1},
      {poem:'【成語運用】',text:'「理所當然」是甚麼意思？',options:["無從判斷", "視情況而定", "以上皆非", "按道理本來就應該這樣"],answer:3},
      {poem:'【成語運用】',text:'「豁然開朗」形容甚麼？',options:["無從判斷", "以上皆非", "視情況而定", "一下子明白過來"],answer:3},
      {poem:'【成語運用】',text:'「迫不及待」形容甚麼？',options:["以上皆非", "急切得不能再等待", "視情況而定", "無從判斷"],answer:1},
      {poem:'【成語運用】',text:'「振振有詞」是甚麼意思？',options:["無從判斷", "說話似乎很有理由", "以上皆非", "視情況而定"],answer:1},
      {poem:'【詞語填充】',text:'面對困難，我們要＿＿，不要輕易放棄。',options:["友善", "堅持", "冷靜", "保持"],answer:1},
      {poem:'【詞語填充】',text:'這篇文章條理＿＿，很容易明白。',options:["主動", "積極", "清晰", "仔細"],answer:2},
      {poem:'【詞語填充】',text:'他經常幫助同學，十分＿＿。',options:["熱心", "積極", "努力", "繼續"],answer:0},
      {poem:'【詞語填充】',text:'這次活動安排得很＿＿，大家都很滿意。',options:["繼續", "周到", "尊重", "清楚"],answer:1},
      {poem:'【詞語填充】',text:'面對壓力時，我們要學會＿＿自己的情緒。',options:["保持", "專心", "調整", "尊重"],answer:2},
      {poem:'【詞語填充】',text:'她的分析很有＿＿，說服了不少同學。',options:["條理", "穩定", "尊重", "冷靜"],answer:0},
      {poem:'【詞語填充】',text:'經過討論後，大家終於達成＿＿。',options:["主動", "穩定", "積極", "共識"],answer:3},
      {poem:'【詞語填充】',text:'這位義工十分＿＿，經常主動幫助別人。',options:["冷靜", "努力", "主動", "熱誠"],answer:3},
      {poem:'【詞語填充】',text:'老師的講解十分＿＿，令我很快掌握重點。',options:["尊重", "清晰", "友善", "清楚"],answer:3},
      {poem:'【詞語填充】',text:'這份報告內容＿＿，資料很充足。',options:["繼續", "主動", "友善", "充實"],answer:3},
      {poem:'【詞語填充】',text:'班長做事公正，能夠＿＿同學之間的意見。',options:["穩定", "協調", "積極", "保持"],answer:1},
      {poem:'【詞語填充】',text:'他說話態度＿＿，讓人感到親切。',options:["仔細", "主動", "溫和", "積極"],answer:2},
      {poem:'【詞語填充】',text:'要完成這項任務，大家必須＿＿合作。',options:["仔細", "冷靜", "互相", "清晰"],answer:2},
      {poem:'【詞語填充】',text:'在比賽前，選手都在＿＿準備。',options:["熱心", "專心", "冷靜", "積極"],answer:3},
      {poem:'【詞語填充】',text:'媽媽做事十分＿＿，把一切都安排好了。',options:["妥善", "尊重", "仔細", "清晰"],answer:0},
      {poem:'【詞語填充】',text:'同學們對老師的教導充滿＿＿。',options:["冷靜", "繼續", "努力", "感激"],answer:3},
      {poem:'【詞語填充】',text:'他在台上演講時表現＿＿，毫不膽怯。',options:["專心", "自信", "保持", "冷靜"],answer:1},
      {poem:'【詞語填充】',text:'我們要＿＿公共地方的清潔。',options:["保持", "仔細", "繼續", "專心"],answer:0},
      {poem:'【詞語填充】',text:'這篇故事情節＿＿，吸引讀者一直看下去。',options:["清晰", "清楚", "緊湊", "積極"],answer:2},
      {poem:'【詞語填充】',text:'遇到誤會時，應先＿＿對方，不要急於責怪。',options:["清晰", "了解", "熱心", "專心"],answer:1},
      {poem:'【詞語填充】',text:'這位運動員經過長期練習，技術愈來愈＿＿。',options:["純熟", "主動", "努力", "專心"],answer:0},
      {poem:'【詞語填充】',text:'他的回答十分＿＿，沒有偏離主題。',options:["積極", "冷靜", "努力", "貼切"],answer:3},
      {poem:'【詞語填充】',text:'老師鼓勵我們培養＿＿思考的能力。',options:["獨立", "友善", "清晰", "清楚"],answer:0},
      {poem:'【詞語填充】',text:'經過反覆檢查，這篇作文已經相當＿＿。',options:["完整", "認真", "熱心", "清晰"],answer:0},
      {poem:'【詞語填充】',text:'同學們對新同學十分＿＿，很快便成為朋友。',options:["清晰", "友善", "穩定", "專心"],answer:1},
      {poem:'【詞語填充】',text:'大家分工＿＿，所以很快完成佈置工作。',options:["合作", "尊重", "仔細", "繼續"],answer:0},
      {poem:'【詞語填充】',text:'他一向做事＿＿，所以深得信任。',options:["熱心", "認真", "努力", "冷靜"],answer:1},
      {poem:'【詞語填充】',text:'我們要＿＿別人的努力，學會欣賞。',options:["主動", "冷靜", "積極", "尊重"],answer:3},
      {poem:'【詞語填充】',text:'這次旅行不但輕鬆，而且十分＿＿。',options:["穩定", "認真", "努力", "愉快"],answer:3},
      {poem:'【詞語填充】',text:'閱讀可以＿＿視野，增長知識。',options:["清晰", "認真", "開闊", "友善"],answer:2},
      {poem:'【修辭辨識】',text:'「書，是良師；書，是益友；書，是明燈。」用了甚麼修辭？',options:["設問", "擬人", "反問", "排比"],answer:3},
      {poem:'【修辭辨識】',text:'「天對地，雨對風。」用了甚麼修辭？',options:["誇張", "對偶", "擬人", "設問"],answer:1},
      {poem:'【修辭辨識】',text:'「誰不想把事情做好呢？」用了甚麼修辭？',options:["反問", "排比", "設問", "對比"],answer:0},
      {poem:'【修辭辨識】',text:'「甚麼是真正的勇氣？真正的勇氣，是跌倒後再站起來。」用了甚麼修辭？',options:["反問", "對比", "設問", "比喻"],answer:2},
      {poem:'【修辭辨識】',text:'「盼望着，盼望着，春天終於來了。」用了甚麼修辭？',options:["反覆", "排比", "對偶", "比喻"],answer:0},
      {poem:'【修辭辨識】',text:'「樹上的葉子你擠我碰，熱鬧極了。」用了甚麼修辭？',options:["誇張", "對比", "比喻", "擬人"],answer:3},
      {poem:'【修辭辨識】',text:'「母愛像陽光，溫暖着我的心。」用了甚麼修辭？',options:["設問", "反問", "擬人", "比喻"],answer:3},
      {poem:'【修辭辨識】',text:'「這件事我怎會忘記呢？」用了甚麼修辭？',options:["反覆", "比喻", "擬人", "反問"],answer:3},
      {poem:'【修辭辨識】',text:'「山更綠了，水更清了，天更藍了。」用了甚麼修辭？',options:["排比", "擬人", "反覆", "對比"],answer:0},
      {poem:'【修辭辨識】',text:'「風把窗簾輕輕地掀起。」用了甚麼修辭？',options:["反問", "對偶", "擬人", "誇張"],answer:2},
      {poem:'【修辭辨識】',text:'「教室熱得像蒸籠一樣。」用了甚麼修辭？',options:["對偶", "誇張", "比喻", "排比"],answer:2},
      {poem:'【修辭辨識】',text:'「他高興得一跳三尺高。」用了甚麼修辭？',options:["對比", "排比", "比喻", "誇張"],answer:3},
      {poem:'【修辭辨識】',text:'「為甚麼要守時？因為守時是尊重別人。」用了甚麼修辭？',options:["排比", "反問", "設問", "對偶"],answer:2},
      {poem:'【修辭辨識】',text:'「看啊，看啊，彩虹出現了！」用了甚麼修辭？',options:["誇張", "比喻", "反覆", "對偶"],answer:2},
      {poem:'【修辭辨識】',text:'「海內存知己，天涯若比鄰。」用了甚麼修辭？',options:["對偶", "對比", "設問", "擬人"],answer:0},
      {poem:'【修辭辨識】',text:'「誰能否認閱讀的好處呢？」用了甚麼修辭？',options:["對比", "反問", "反覆", "對偶"],answer:1},
      {poem:'【修辭辨識】',text:'「時間像流水，一去不回。」用了甚麼修辭？',options:["比喻", "反問", "對偶", "反覆"],answer:0},
      {poem:'【修辭辨識】',text:'「小溪唱着歌向前流去。」用了甚麼修辭？',options:["擬人", "對比", "對偶", "反問"],answer:0},
      {poem:'【修辭辨識】',text:'「他忙得腳不沾地。」用了甚麼修辭？',options:["對比", "排比", "反問", "誇張"],answer:3},
      {poem:'【修辭辨識】',text:'「我愛閱讀，愛寫作，愛觀察生活。」用了甚麼修辭？',options:["反覆", "設問", "排比", "反問"],answer:2},
      {poem:'【修辭辨識】',text:'「甚麼叫責任？責任就是把該做的事做好。」用了甚麼修辭？',options:["排比", "比喻", "誇張", "設問"],answer:3},
      {poem:'【修辭辨識】',text:'「想呀，想呀，我終於明白了。」用了甚麼修辭？',options:["誇張", "反覆", "對比", "排比"],answer:1},
      {poem:'【修辭辨識】',text:'「黑髮不知勤學早，白首方悔讀書遲。」用了甚麼修辭？',options:["對比", "設問", "對偶", "比喻"],answer:2},
      {poem:'【修辭辨識】',text:'「難道我們可以浪費糧食嗎？」用了甚麼修辭？',options:["反覆", "反問", "對偶", "設問"],answer:1},
      {poem:'【修辭辨識】',text:'「她的笑容像春風一樣柔和。」用了甚麼修辭？',options:["對偶", "擬人", "比喻", "反問"],answer:2},
      {poem:'【修辭辨識】',text:'「星星在夜空中眨着眼睛。」用了甚麼修辭？',options:["誇張", "擬人", "排比", "比喻"],answer:1},
      {poem:'【修辭辨識】',text:'「這本書厚得像一塊磚頭。」用了甚麼修辭？',options:["反問", "誇張", "排比", "比喻"],answer:1},
      {poem:'【修辭辨識】',text:'「校園裡有花香，有笑聲，有朗朗書聲。」用了甚麼修辭？',options:["排比", "反問", "擬人", "對偶"],answer:0},
      {poem:'【修辭辨識】',text:'「說到做到，言出必行。」用了甚麼修辭？',options:["對比", "對偶", "設問", "反覆"],answer:1},
      {poem:'【修辭辨識】',text:'「怎能因為一次失敗就放棄呢？」用了甚麼修辭？',options:["對偶", "設問", "反問", "對比"],answer:2},
      {poem:'【唐詩理解】',text:'「欲窮千里目」的下一句是甚麼？',options:["以上皆非", "更上一層樓", "另有所指", "無從判斷"],answer:1},
      {poem:'【唐詩理解】',text:'《黃鶴樓送孟浩然之廣陵》的作者是誰？',options:["杜牧", "柳宗元", "崔顥", "李白"],answer:3},
      {poem:'【唐詩理解】',text:'「兩個黃鸝鳴翠柳」的下一句是甚麼？',options:["以上皆非", "另有所指", "一行白鷺上青天", "無從判斷"],answer:2},
      {poem:'【唐詩理解】',text:'《江雪》的作者是誰？',options:["杜牧", "柳宗元", "陸游", "崔顥"],answer:1},
      {poem:'【唐詩理解】',text:'「千山鳥飛絕」的下一句是甚麼？',options:["無從判斷", "萬徑人蹤滅", "以上皆非", "另有所指"],answer:1},
      {poem:'【唐詩理解】',text:'《九月九日憶山東兄弟》的作者是誰？',options:["李清照", "白居易", "王維", "陸游"],answer:2},
      {poem:'【唐詩理解】',text:'「獨在異鄉為異客」的下一句是甚麼？',options:["每逢佳節倍思親", "無從判斷", "另有所指", "以上皆非"],answer:0},
      {poem:'【唐詩理解】',text:'《絕句》的作者是誰？',options:["王翰", "杜甫", "蘇軾", "王勃"],answer:1},
      {poem:'【唐詩理解】',text:'「窗含西嶺千秋雪」的下一句是甚麼？',options:["無從判斷", "另有所指", "門泊東吳萬里船", "以上皆非"],answer:2},
      {poem:'【唐詩理解】',text:'《憫農》「誰知盤中餐」的下一句是甚麼？',options:["粒粒皆辛苦", "另有所指", "以上皆非", "無從判斷"],answer:0},
      {poem:'【唐詩理解】',text:'《送元二使安西》的作者是誰？',options:["陳子昂", "賀知章", "王勃", "王維"],answer:3},
      {poem:'【唐詩理解】',text:'「渭城朝雨浥輕塵」的下一句是甚麼？',options:["無從判斷", "另有所指", "客舍青青柳色新", "以上皆非"],answer:2},
      {poem:'【唐詩理解】',text:'「勸君更盡一杯酒」的下一句是甚麼？',options:["另有所指", "西出陽關無故人", "以上皆非", "無從判斷"],answer:1},
      {poem:'【唐詩理解】',text:'《望廬山瀑布》的作者是誰？',options:["孟浩然", "賀知章", "李白", "高適"],answer:2},
      {poem:'【唐詩理解】',text:'「日照香爐生紫煙」的下一句是甚麼？',options:["無從判斷", "遙看瀑布掛前川", "以上皆非", "另有所指"],answer:1},
      {poem:'【唐詩理解】',text:'「飛流直下三千尺」的下一句是甚麼？',options:["無從判斷", "另有所指", "疑是銀河落九天", "以上皆非"],answer:2},
      {poem:'【唐詩理解】',text:'《山行》的作者是誰？',options:["杜牧", "楊萬里", "張繼", "蘇軾"],answer:0},
      {poem:'【唐詩理解】',text:'「停車坐愛楓林晚」的下一句是甚麼？',options:["霜葉紅於二月花", "以上皆非", "無從判斷", "另有所指"],answer:0},
      {poem:'【唐詩理解】',text:'《早發白帝城》的作者是誰？',options:["李白", "賈島", "柳宗元", "杜甫"],answer:0},
      {poem:'【唐詩理解】',text:'「兩岸猿聲啼不住」的下一句是甚麼？',options:["另有所指", "輕舟已過萬重山", "以上皆非", "無從判斷"],answer:1},
      {poem:'【唐詩理解】',text:'《回鄉偶書》的作者是誰？',options:["李商隱", "賀知章", "高適", "陸游"],answer:1},
      {poem:'【唐詩理解】',text:'「兒童相見不相識」的下一句是甚麼？',options:["笑問客從何處來", "無從判斷", "以上皆非", "另有所指"],answer:0},
      {poem:'【唐詩理解】',text:'《夜書所見》的作者是誰？',options:["柳宗元", "葉紹翁", "駱賓王", "王之渙"],answer:1},
      {poem:'【唐詩理解】',text:'「知有兒童挑促織」的下一句是甚麼？',options:["夜深籬落一燈明", "無從判斷", "另有所指", "以上皆非"],answer:0},
      {poem:'【唐詩理解】',text:'《賦得古原草送別》的作者是誰？',options:["李商隱", "白居易", "王之渙", "崔顥"],answer:1},
      {poem:'【唐詩理解】',text:'「離離原上草」的下一句是甚麼？',options:["另有所指", "無從判斷", "以上皆非", "一歲一枯榮"],answer:3},
      {poem:'【唐詩理解】',text:'「野火燒不盡」的下一句是甚麼？',options:["春風吹又生", "無從判斷", "另有所指", "以上皆非"],answer:0},
      {poem:'【唐詩理解】',text:'《池上》的作者是誰？',options:["駱賓王", "李清照", "白居易", "柳宗元"],answer:2},
      {poem:'【唐詩理解】',text:'「不解藏蹤跡」的下一句是甚麼？',options:["以上皆非", "浮萍一道開", "無從判斷", "另有所指"],answer:1},
      {poem:'【唐詩理解】',text:'《小池》的作者是誰？',options:["白居易", "杜甫", "楊萬里", "王勃"],answer:2},
      {poem:'【找錯字】',text:'句子中有一個錯字：我們應該遵敬師長，友愛同學。',options:["尊→遵", "以上皆非", "不需改正", "遵→尊"],answer:3},
      {poem:'【找錯字】',text:'句子中有一個錯字：老師常常鼓厉我們勇敢嘗試。',options:["厉→勵", "不需改正", "勵→厉", "以上皆非"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：只要堅恃到底，就有成功的機會。',options:["不需改正", "恃→持", "以上皆非", "持→恃"],answer:1},
      {poem:'【找錯字】',text:'句子中有一個錯字：這篇文章條李分明。',options:["以上皆非", "李→理", "理→李", "不需改正"],answer:1},
      {poem:'【找錯字】',text:'句子中有一個錯字：同學們正在操塲上練習接力跑。',options:["以上皆非", "不需改正", "場→塲", "塲→場"],answer:3},
      {poem:'【找錯字】',text:'句子中有一個錯字：老師的分析十分精僻。',options:["僻→闢", "闢→僻", "以上皆非", "不需改正"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：我們應以理性方試解決問題。',options:["不需改正", "試→式", "以上皆非", "式→試"],answer:1},
      {poem:'【找錯字】',text:'句子中有一個錯字：這本書的內容很豊富。',options:["不需改正", "豐→豊", "以上皆非", "豊→豐"],answer:3},
      {poem:'【找錯字】',text:'句子中有一個錯字：校方已經公佈比塞結果。',options:["賽→塞", "不需改正", "以上皆非", "塞→賽"],answer:3},
      {poem:'【找錯字】',text:'句子中有一個錯字：他說話態度很成懇。',options:["以上皆非", "誠→成", "成→誠", "不需改正"],answer:2},
      {poem:'【找錯字】',text:'句子中有一個錯字：大家要互相體量和包容。',options:["不需改正", "諒→量", "以上皆非", "量→諒"],answer:3},
      {poem:'【找錯字】',text:'句子中有一個錯字：媽媽把房間佈置得很溫磬。',options:["磬→馨", "馨→磬", "以上皆非", "不需改正"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：這項安排十分週到。',options:["週→周", "周→週", "以上皆非", "不需改正"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：我們要遵首交通規則。',options:["以上皆非", "不需改正", "首→守", "守→首"],answer:2},
      {poem:'【找錯字】',text:'句子中有一個錯字：他在台上至詞，感謝大家支持。',options:["不需改正", "至→致", "致→至", "以上皆非"],answer:1},
      {poem:'【找錯字】',text:'句子中有一個錯字：這個建議值得慎種考慮。',options:["不需改正", "以上皆非", "重→種", "種→重"],answer:3},
      {poem:'【找錯字】',text:'句子中有一個錯字：我已把資料存入電惱。',options:["腦→惱", "以上皆非", "惱→腦", "不需改正"],answer:2},
      {poem:'【找錯字】',text:'句子中有一個錯字：這份報告十分詳盡，內容毫不空侗。',options:["以上皆非", "不需改正", "洞→侗", "侗→洞"],answer:3},
      {poem:'【找錯字】',text:'句子中有一個錯字：大家對這消息都感到振驚。',options:["不需改正", "以上皆非", "震→振", "振→震"],answer:3},
      {poem:'【找錯字】',text:'句子中有一個錯字：老師稱贊他的表現有顯著進步。',options:["讚→贊", "不需改正", "以上皆非", "贊→讚"],answer:3},
      {poem:'【找錯字】',text:'句子中有一個錯字：我會盡快回覆你的電郵，不會廷誤。',options:["廷→延", "不需改正", "延→廷", "以上皆非"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：他做事一向很付責。',options:["以上皆非", "責→責任心", "不需改正", "責任心→責"],answer:1},
      {poem:'【找錯字】',text:'句子中有一個錯字：這位義工十分熱成，常常幫助長者。',options:["誠→成", "以上皆非", "成→誠", "不需改正"],answer:2},
      {poem:'【找錯字】',text:'句子中有一個錯字：面對挑戰，我們要保持冷婧。',options:["以上皆非", "不需改正", "婧→靜", "靜→婧"],answer:2},
      {poem:'【找錯字】',text:'句子中有一個錯字：只要大家同心協力，就能刻服困難。',options:["刻→克", "克→刻", "不需改正", "以上皆非"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：她的表達能力很出息。',options:["以上皆非", "不需改正", "色→息", "息→色"],answer:3},
      {poem:'【找錯字】',text:'句子中有一個錯字：校園生活令我留下深刻影像。',options:["以上皆非", "像→象", "不需改正", "象→像"],answer:1},
      {poem:'【找錯字】',text:'句子中有一個錯字：我們要按步就班地完成每個步驟，不可急燥。',options:["以上皆非", "燥→躁", "躁→燥", "不需改正"],answer:1},
      {poem:'【找錯字】',text:'句子中有一個錯字：同學們對這次活動充滿期特。',options:["以上皆非", "不需改正", "待→特", "特→待"],answer:3}
    ],
    P6: [
      {poem:'【部首】',text:'「籍」的部首是甚麼？',options:["士", "攴", "見", "竹"],answer:3},
      {poem:'【部首】',text:'「警」的部首是甚麼？',options:["言", "木", "手", "辛"],answer:0},
      {poem:'【部首】',text:'「顧」的部首是甚麼？',options:["土", "食", "頁", "辛"],answer:2},
      {poem:'【部首】',text:'「衡」的部首是甚麼？',options:["戶", "刂", "辛", "行"],answer:3},
      {poem:'【部首】',text:'「辯」的部首是甚麼？',options:["行", "辛", "竹", "王"],answer:1},
      {poem:'【部首】',text:'「贏」的部首是甚麼？',options:["心", "貝", "酉", "戶"],answer:1},
      {poem:'【部首】',text:'「懼」的部首是甚麼？',options:["行", "女", "口", "忄"],answer:3},
      {poem:'【部首】',text:'「譽」的部首是甚麼？',options:["言", "酉", "攴", "非"],answer:0},
      {poem:'【部首】',text:'「縮」的部首是甚麼？',options:["阝", "糸", "人", "刂"],answer:1},
      {poem:'【部首】',text:'「燃」的部首是甚麼？',options:["火", "阝", "殳", "女"],answer:0},
      {poem:'【部首】',text:'「覽」的部首是甚麼？',options:["王", "見", "疒", "犬"],answer:1},
      {poem:'【部首】',text:'「辨」的部首是甚麼？',options:["艹", "目", "辛", "手"],answer:2},
      {poem:'【部首】',text:'「疆」的部首是甚麼？',options:["田", "月", "犬", "頁"],answer:0},
      {poem:'【部首】',text:'「額」的部首是甚麼？',options:["竹", "金", "酉", "頁"],answer:3},
      {poem:'【部首】',text:'「壯」的部首是甚麼？',options:["舟", "竹", "糸", "士"],answer:3},
      {poem:'【部首】',text:'「謙」的部首是甚麼？',options:["口", "扌", "月", "言"],answer:3},
      {poem:'【部首】',text:'「奮」的部首是甚麼？',options:["衣", "大", "食", "見"],answer:1},
      {poem:'【部首】',text:'「毅」的部首是甚麼？',options:["彡", "女", "殳", "竹"],answer:2},
      {poem:'【部首】',text:'「謹」的部首是甚麼？',options:["言", "士", "人", "阝"],answer:0},
      {poem:'【部首】',text:'「臨」的部首是甚麼？',options:["女", "非", "手", "丨"],answer:3},
      {poem:'【部首】',text:'「鏡」的部首是甚麼？',options:["刂", "犬", "金", "手"],answer:2},
      {poem:'【部首】',text:'「懲」的部首是甚麼？',options:["木", "心", "手", "月"],answer:1},
      {poem:'【部首】',text:'「擴」的部首是甚麼？',options:["酉", "手", "王", "寸"],answer:1},
      {poem:'【部首】',text:'「覽」的部首是甚麼？',options:["士", "見", "人", "竹"],answer:1},
      {poem:'【部首】',text:'「辭」的部首是甚麼？',options:["疒", "辛", "口", "食"],answer:1},
      {poem:'【部首】',text:'「策」的部首是甚麼？',options:["手", "竹", "尸", "殳"],answer:1},
      {poem:'【部首】',text:'「譬」的部首是甚麼？',options:["行", "非", "言", "戶"],answer:2},
      {poem:'【部首】',text:'「顯」的部首是甚麼？',options:["月", "氵", "土", "頁"],answer:3},
      {poem:'【部首】',text:'「屬」的部首是甚麼？',options:["艹", "攴", "尸", "辶"],answer:2},
      {poem:'【部首】',text:'「鑑」的部首是甚麼？',options:["金", "衣", "彡", "火"],answer:0},
      {poem:'【詞義辨析】',text:'「堅毅」的近義詞是甚麼？',options:["堅定", "以上皆非", "視情況而定", "無從判斷"],answer:0},
      {poem:'【詞義辨析】',text:'「慷慨」的反義詞是甚麼？',options:["無從判斷", "視情況而定", "以上皆非", "吝嗇"],answer:3},
      {poem:'【詞義辨析】',text:'「敏捷」的近義詞是甚麼？',options:["視情況而定", "以上皆非", "迅捷", "無從判斷"],answer:2},
      {poem:'【詞義辨析】',text:'「沉着」的近義詞是甚麼？',options:["冷靜", "視情況而定", "以上皆非", "無從判斷"],answer:0},
      {poem:'【詞義辨析】',text:'「模糊」的反義詞是甚麼？',options:["清晰", "視情況而定", "無從判斷", "以上皆非"],answer:0},
      {poem:'【詞義辨析】',text:'「嚴謹」的近義詞是甚麼？',options:["無從判斷", "視情況而定", "周密", "以上皆非"],answer:2},
      {poem:'【詞義辨析】',text:'「吝嗇」的反義詞是甚麼？',options:["以上皆非", "無從判斷", "視情況而定", "慷慨"],answer:3},
      {poem:'【詞義辨析】',text:'「短暫」的反義詞是甚麼？',options:["長久", "以上皆非", "視情況而定", "無從判斷"],answer:0},
      {poem:'【詞義辨析】',text:'「坦然」的近義詞是甚麼？',options:["無從判斷", "以上皆非", "從容", "視情況而定"],answer:2},
      {poem:'【詞義辨析】',text:'「複雜」的反義詞是甚麼？',options:["無從判斷", "簡單", "以上皆非", "視情況而定"],answer:1},
      {poem:'【詞義辨析】',text:'「誠懇」的近義詞是甚麼？',options:["真誠", "視情況而定", "以上皆非", "無從判斷"],answer:0},
      {poem:'【詞義辨析】',text:'「穩重」的反義詞是甚麼？',options:["無從判斷", "輕浮", "以上皆非", "視情況而定"],answer:1},
      {poem:'【詞義辨析】',text:'「豐富」的近義詞是甚麼？',options:["以上皆非", "視情況而定", "充實", "無從判斷"],answer:2},
      {poem:'【詞義辨析】',text:'「狹窄」的反義詞是甚麼？',options:["寬闊", "視情況而定", "無從判斷", "以上皆非"],answer:0},
      {poem:'【詞義辨析】',text:'「果斷」的近義詞是甚麼？',options:["視情況而定", "無從判斷", "決斷", "以上皆非"],answer:2},
      {poem:'【詞義辨析】',text:'「猶豫」的反義詞是甚麼？',options:["視情況而定", "果斷", "無從判斷", "以上皆非"],answer:1},
      {poem:'【詞義辨析】',text:'「融洽」的近義詞是甚麼？',options:["視情況而定", "和諧", "以上皆非", "無從判斷"],answer:1},
      {poem:'【詞義辨析】',text:'「虛心」的反義詞是甚麼？',options:["驕傲", "視情況而定", "以上皆非", "無從判斷"],answer:0},
      {poem:'【詞義辨析】',text:'「貧乏」的反義詞是甚麼？',options:["以上皆非", "無從判斷", "視情況而定", "豐富"],answer:3},
      {poem:'【詞義辨析】',text:'「穩定」的近義詞是甚麼？',options:["無從判斷", "視情況而定", "以上皆非", "平穩"],answer:3},
      {poem:'【詞義辨析】',text:'「冷淡」的反義詞是甚麼？',options:["無從判斷", "以上皆非", "視情況而定", "熱情"],answer:3},
      {poem:'【詞義辨析】',text:'「積極」的近義詞是甚麼？',options:["無從判斷", "主動", "視情況而定", "以上皆非"],answer:1},
      {poem:'【詞義辨析】',text:'「疲倦」的反義詞是甚麼？',options:["視情況而定", "無從判斷", "以上皆非", "精神"],answer:3},
      {poem:'【詞義辨析】',text:'「明顯」的反義詞是甚麼？',options:["隱約", "以上皆非", "無從判斷", "視情況而定"],answer:0},
      {poem:'【詞義辨析】',text:'「欣慰」的近義詞是甚麼？',options:["視情況而定", "安慰", "無從判斷", "以上皆非"],answer:1},
      {poem:'【詞義辨析】',text:'「嚴厲」的反義詞是甚麼？',options:["無從判斷", "溫和", "以上皆非", "視情況而定"],answer:1},
      {poem:'【詞義辨析】',text:'「迅猛」的近義詞是甚麼？',options:["無從判斷", "視情況而定", "以上皆非", "迅速"],answer:3},
      {poem:'【詞義辨析】',text:'「珍惜」的反義詞是甚麼？',options:["以上皆非", "無從判斷", "浪費", "視情況而定"],answer:2},
      {poem:'【詞義辨析】',text:'「尊重」的近義詞是甚麼？',options:["視情況而定", "敬重", "無從判斷", "以上皆非"],answer:1},
      {poem:'【詞義辨析】',text:'「退縮」的反義詞是甚麼？',options:["無從判斷", "勇進", "以上皆非", "視情況而定"],answer:1},
      {poem:'【成語運用】',text:'「胸有成竹」比喻甚麼？',options:["視情況而定", "無從判斷", "做事前已有周詳打算", "以上皆非"],answer:2},
      {poem:'【成語運用】',text:'「實事求是」是指甚麼？',options:["按實際情況處理，不誇大不虛假", "無從判斷", "視情況而定", "以上皆非"],answer:0},
      {poem:'【成語運用】',text:'「堅持不懈」是形容怎樣的態度？',options:["持續努力，不輕易放棄", "以上皆非", "無從判斷", "視情況而定"],answer:0},
      {poem:'【成語運用】',text:'「迎刃而解」比喻甚麼？',options:["問題順利解決", "視情況而定", "以上皆非", "無從判斷"],answer:0},
      {poem:'【成語運用】',text:'「舉一反三」是甚麼意思？',options:["無從判斷", "以上皆非", "視情況而定", "從一件事類推到其他事"],answer:3},
      {poem:'【成語運用】',text:'「精益求精」形容甚麼？',options:["以上皆非", "無從判斷", "視情況而定", "已經很好還要更好"],answer:3},
      {poem:'【成語運用】',text:'「當機立斷」形容甚麼？',options:["視情況而定", "在關鍵時刻果斷決定", "無從判斷", "以上皆非"],answer:1},
      {poem:'【成語運用】',text:'「名列前茅」是甚麼意思？',options:["以上皆非", "視情況而定", "無從判斷", "成績或表現名次靠前"],answer:3},
      {poem:'【成語運用】',text:'「集思廣益」是甚麼意思？',options:["以上皆非", "無從判斷", "視情況而定", "集中大家的意見和智慧"],answer:3},
      {poem:'【成語運用】',text:'「見多識廣」形容甚麼？',options:["經驗多，見識廣", "以上皆非", "無從判斷", "視情況而定"],answer:0},
      {poem:'【成語運用】',text:'「循序漸進」是甚麼意思？',options:["無從判斷", "按一定次序逐步前進", "以上皆非", "視情況而定"],answer:1},
      {poem:'【成語運用】',text:'「鍥而不捨」形容甚麼？',options:["視情況而定", "無從判斷", "有恆心，不放棄", "以上皆非"],answer:2},
      {poem:'【成語運用】',text:'「觸類旁通」是甚麼意思？',options:["視情況而定", "以上皆非", "掌握一類知識後推及其他方面", "無從判斷"],answer:2},
      {poem:'【成語運用】',text:'「不屈不撓」形容甚麼？',options:["意志堅強，不向困難低頭", "無從判斷", "視情況而定", "以上皆非"],answer:0},
      {poem:'【成語運用】',text:'「博覽群書」形容甚麼？',options:["讀過很多書", "視情況而定", "以上皆非", "無從判斷"],answer:0},
      {poem:'【成語運用】',text:'「融會貫通」是甚麼意思？',options:["無從判斷", "視情況而定", "把各方面知識理解並聯繫起來", "以上皆非"],answer:2},
      {poem:'【成語運用】',text:'「按部就班」形容甚麼？',options:["無從判斷", "依照一定次序做事", "以上皆非", "視情況而定"],answer:1},
      {poem:'【成語運用】',text:'「力爭上游」形容甚麼？',options:["努力求進步", "以上皆非", "視情況而定", "無從判斷"],answer:0},
      {poem:'【成語運用】',text:'「水到渠成」比喻甚麼？',options:["條件成熟，事情自然成功", "以上皆非", "視情況而定", "無從判斷"],answer:0},
      {poem:'【成語運用】',text:'「刻苦耐勞」形容甚麼？',options:["無從判斷", "能吃苦，能忍勞", "以上皆非", "視情況而定"],answer:1},
      {poem:'【成語運用】',text:'「理直氣壯」形容甚麼？',options:["視情況而定", "理由充分，說話有氣勢", "以上皆非", "無從判斷"],answer:1},
      {poem:'【成語運用】',text:'「見義勇為」是甚麼意思？',options:["無從判斷", "視情況而定", "以上皆非", "看到正義的事就勇敢去做"],answer:3},
      {poem:'【成語運用】',text:'「一絲不苟」形容甚麼？',options:["無從判斷", "以上皆非", "做事非常認真仔細", "視情況而定"],answer:2},
      {poem:'【成語運用】',text:'「出類拔萃」形容甚麼？',options:["比同類特別優秀", "無從判斷", "視情況而定", "以上皆非"],answer:0},
      {poem:'【成語運用】',text:'「未雨綢繆」是甚麼意思？',options:["以上皆非", "視情況而定", "事先做好準備", "無從判斷"],answer:2},
      {poem:'【成語運用】',text:'「有條不紊」形容甚麼？',options:["做事有次序，不紊亂", "視情況而定", "無從判斷", "以上皆非"],answer:0},
      {poem:'【成語運用】',text:'「豁然開朗」形容甚麼？',options:["無從判斷", "以上皆非", "視情況而定", "一下子明白過來"],answer:3},
      {poem:'【成語運用】',text:'「各抒己見」是甚麼意思？',options:["無從判斷", "視情況而定", "以上皆非", "各人發表自己的意見"],answer:3},
      {poem:'【成語運用】',text:'「孜孜不倦」形容甚麼？',options:["視情況而定", "勤勉不懈怠", "以上皆非", "無從判斷"],answer:1},
      {poem:'【成語運用】',text:'「融洽無間」形容甚麼？',options:["無從判斷", "關係和諧密切", "視情況而定", "以上皆非"],answer:1},
      {poem:'【詞語填充】',text:'成功沒有捷徑，只有靠長期＿＿和努力。',options:["努力", "繼續", "積累", "尊重"],answer:2},
      {poem:'【詞語填充】',text:'面對不同意見，我們應保持＿＿，理性討論。',options:["清晰", "冷靜", "保持", "清楚"],answer:1},
      {poem:'【詞語填充】',text:'這次專題研習資料＿＿，分析也很深入。',options:["主動", "充實", "繼續", "熱心"],answer:1},
      {poem:'【詞語填充】',text:'這篇演講不但觀點鮮明，而且論證十分＿＿。',options:["繼續", "保持", "嚴密", "主動"],answer:2},
      {poem:'【詞語填充】',text:'他在比賽失利後仍能＿＿面對，值得欣賞。',options:["尊重", "坦然", "努力", "積極"],answer:1},
      {poem:'【詞語填充】',text:'做研究時，我們必須保持＿＿態度，不能憑空猜測。',options:["專心", "求實", "認真", "尊重"],answer:1},
      {poem:'【詞語填充】',text:'這位主持人反應＿＿，能即時化解尷尬場面。',options:["敏捷", "繼續", "友善", "積極"],answer:0},
      {poem:'【詞語填充】',text:'同學們經過多番討論，終於整理出清晰的＿＿。',options:["保持", "積極", "認真", "脈絡"],answer:3},
      {poem:'【詞語填充】',text:'這份建議書內容完整，結構也很＿＿。',options:["清楚", "嚴謹", "保持", "冷靜"],answer:1},
      {poem:'【詞語填充】',text:'要提升語文能力，平日必須多＿＿和多思考。',options:["保持", "閱讀", "繼續", "尊重"],answer:1},
      {poem:'【詞語填充】',text:'面對挑戰時，他總能＿＿自若，不輕易慌張。',options:["清晰", "積極", "清楚", "鎮定"],answer:3},
      {poem:'【詞語填充】',text:'老師要求我們引用資料時要註明＿＿，不可抄襲。',options:["清晰", "積極", "仔細", "出處"],answer:3},
      {poem:'【詞語填充】',text:'做事前若有周詳計劃，便較容易＿＿目標。',options:["清楚", "穩定", "主動", "達成"],answer:3},
      {poem:'【詞語填充】',text:'這位同學說話有＿＿，分析問題很有層次。',options:["清晰", "冷靜", "條理", "努力"],answer:2},
      {poem:'【詞語填充】',text:'只要持續＿＿，能力自然會逐步提升。',options:["專心", "鍛鍊", "繼續", "熱心"],answer:1},
      {poem:'【詞語填充】',text:'他待人＿＿，因此深受同學尊重。',options:["仔細", "誠懇", "認真", "專心"],answer:1},
      {poem:'【詞語填充】',text:'校方希望同學能培養＿＿精神，主動解決問題。',options:["冷靜", "自主", "熱心", "尊重"],answer:1},
      {poem:'【詞語填充】',text:'這篇文章立意＿＿，值得細心品味。',options:["清楚", "深刻", "認真", "友善"],answer:1},
      {poem:'【詞語填充】',text:'我們應以＿＿態度面對批評，從中改進自己。',options:["專心", "清晰", "冷靜", "虛心"],answer:3},
      {poem:'【詞語填充】',text:'經過反覆修訂，這份作品終於更趨＿＿。',options:["完善", "保持", "積極", "專心"],answer:0},
      {poem:'【詞語填充】',text:'他雖然年紀不大，卻有十分＿＿的處事方式。',options:["保持", "友善", "專心", "成熟"],answer:3},
      {poem:'【詞語填充】',text:'面對突發情況，最重要是先＿＿情緒。',options:["努力", "友善", "專心", "穩定"],answer:3},
      {poem:'【詞語填充】',text:'與人合作時，要學會＿＿和包容。',options:["熱心", "冷靜", "尊重", "體諒"],answer:3},
      {poem:'【詞語填充】',text:'一篇好文章除了內容充實，也要語句＿＿。',options:["友善", "專心", "流暢", "穩定"],answer:2},
      {poem:'【詞語填充】',text:'導師提醒大家發言前先整理＿＿，才更有說服力。',options:["冷靜", "友善", "思路", "尊重"],answer:2},
      {poem:'【詞語填充】',text:'經過一番努力，團隊終於＿＿完成任務。',options:["專心", "穩定", "順利", "認真"],answer:2},
      {poem:'【詞語填充】',text:'學習新知識時，應該多作＿＿，不要死記硬背。',options:["思考", "友善", "積極", "繼續"],answer:0},
      {poem:'【詞語填充】',text:'這位作者觀察生活十分＿＿，因此作品很有感染力。',options:["清楚", "繼續", "細緻", "積極"],answer:2},
      {poem:'【詞語填充】',text:'想提升寫作能力，必須累積詞彙，並加強＿＿。',options:["認真", "冷靜", "努力", "練習"],answer:3},
      {poem:'【詞語填充】',text:'真正的自信不是驕傲，而是對自己有＿＿的認識。',options:["熱心", "清晰", "清楚", "繼續"],answer:2},
      {poem:'【修辭辨識】',text:'「燕子去了，有再來的時候；楊柳枯了，有再青的時候；桃花謝了，有再開的時候。」用了甚麼修辭？',options:["反覆", "對比", "比喻", "排比"],answer:3},
      {poem:'【修辭辨識】',text:'「學如逆水行舟，不進則退。」用了甚麼修辭？',options:["反問", "反覆", "排比", "比喻"],answer:3},
      {poem:'【修辭辨識】',text:'「你怎能說這件事和你完全無關？」用了甚麼修辭？',options:["設問", "反問", "擬人", "反覆"],answer:1},
      {poem:'【修辭辨識】',text:'「甚麼是責任？責任就是把應做的事做好。」用了甚麼修辭？',options:["設問", "對偶", "反問", "比喻"],answer:0},
      {poem:'【修辭辨識】',text:'「盼啊，盼啊，我們終於等到畢業旅行了。」用了甚麼修辭？',options:["反覆", "比喻", "對比", "反問"],answer:0},
      {poem:'【修辭辨識】',text:'「書籍是橫渡時間大海的航船。」用了甚麼修辭？',options:["排比", "對比", "比喻", "擬人"],answer:2},
      {poem:'【修辭辨識】',text:'「風，輕輕地翻動了窗邊的書頁。」用了甚麼修辭？',options:["擬人", "對偶", "對比", "反覆"],answer:0},
      {poem:'【修辭辨識】',text:'「這巴掌大的地方，怎容得下這麼多人？」用了甚麼修辭？',options:["擬人", "設問", "誇張", "對偶"],answer:2},
      {poem:'【修辭辨識】',text:'「有的人活着，他已經死了；有的人死了，他還活着。」用了甚麼修辭？',options:["設問", "對偶", "對比", "比喻"],answer:2},
      {poem:'【修辭辨識】',text:'「海內存知己，天涯若比鄰。」用了甚麼修辭？',options:["對偶", "誇張", "反問", "反覆"],answer:0},
      {poem:'【修辭辨識】',text:'「難道我們可以對錯誤視而不見嗎？」用了甚麼修辭？',options:["反問", "排比", "比喻", "對比"],answer:0},
      {poem:'【修辭辨識】',text:'「甚麼叫成長？成長就是一次次跌倒後再站起來。」用了甚麼修辭？',options:["設問", "擬人", "比喻", "反問"],answer:0},
      {poem:'【修辭辨識】',text:'「看吧，看吧，黎明快要到了。」用了甚麼修辭？',options:["排比", "反問", "反覆", "比喻"],answer:2},
      {poem:'【修辭辨識】',text:'「他的聲音像洪鐘一樣響亮。」用了甚麼修辭？',options:["反問", "反覆", "排比", "比喻"],answer:3},
      {poem:'【修辭辨識】',text:'「月光悄悄地爬上窗台。」用了甚麼修辭？',options:["對比", "擬人", "反問", "比喻"],answer:1},
      {poem:'【修辭辨識】',text:'「他忙得連喝水的時間也沒有。」用了甚麼修辭？',options:["比喻", "擬人", "反問", "誇張"],answer:3},
      {poem:'【修辭辨識】',text:'「春風又綠江南岸，明月何時照我還。」其中「春風又綠江南岸」可視作甚麼修辭？',options:["設問", "反問", "比喻", "擬人"],answer:3},
      {poem:'【修辭辨識】',text:'「知識改變命運，閱讀開拓人生，思考提升深度。」用了甚麼修辭？',options:["排比", "反問", "擬人", "對比"],answer:0},
      {poem:'【修辭辨識】',text:'「有志者事竟成，苦心人天不負。」用了甚麼修辭？',options:["誇張", "對偶", "反問", "反覆"],answer:1},
      {poem:'【修辭辨識】',text:'「這不是很清楚嗎？」用了甚麼修辭？',options:["對比", "反覆", "反問", "對偶"],answer:2},
      {poem:'【修辭辨識】',text:'「甚麼是自由？自由是懂得自律。」用了甚麼修辭？',options:["擬人", "誇張", "對偶", "設問"],answer:3},
      {poem:'【修辭辨識】',text:'「想啊，想啊，他終於找到突破點。」用了甚麼修辭？',options:["反覆", "設問", "擬人", "對偶"],answer:0},
      {poem:'【修辭辨識】',text:'「老師像燈塔，指引我們前進。」用了甚麼修辭？',options:["排比", "比喻", "反問", "擬人"],answer:1},
      {poem:'【修辭辨識】',text:'「夜空中的星星眨着眼睛。」用了甚麼修辭？',options:["對比", "擬人", "誇張", "設問"],answer:1},
      {poem:'【修辭辨識】',text:'「他一口氣跑了一萬里。」用了甚麼修辭？',options:["反覆", "對比", "誇張", "設問"],answer:2},
      {poem:'【修辭辨識】',text:'「讀書使人充實，思考使人深刻，交流使人清醒。」用了甚麼修辭？',options:["對比", "排比", "誇張", "比喻"],answer:1},
      {poem:'【修辭辨識】',text:'「你怎能不為這份情誼感動呢？」用了甚麼修辭？',options:["擬人", "反覆", "反問", "設問"],answer:2},
      {poem:'【修辭辨識】',text:'「為甚麼要誠實？因為誠實是做人的根本。」用了甚麼修辭？',options:["對比", "誇張", "對偶", "設問"],answer:3},
      {poem:'【修辭辨識】',text:'「等啊，等啊，答案終於揭曉了。」用了甚麼修辭？',options:["反覆", "排比", "對偶", "對比"],answer:0},
      {poem:'【修辭辨識】',text:'「他瘦得像一根竹竿。」用了甚麼修辭？',options:["對比", "比喻", "排比", "對偶"],answer:1},
      {poem:'【唐詩理解】',text:'《送元二使安西》的作者是誰？',options:["崔顥", "張繼", "王勃", "王維"],answer:3},
      {poem:'【唐詩理解】',text:'「勸君更盡一杯酒」的下一句是甚麼？',options:["另有所指", "西出陽關無故人", "以上皆非", "無從判斷"],answer:1},
      {poem:'【唐詩理解】',text:'《望廬山瀑布》的作者是誰？',options:["楊萬里", "李清照", "李白", "陸游"],answer:2},
      {poem:'【唐詩理解】',text:'「飛流直下三千尺」的下一句是甚麼？',options:["無從判斷", "另有所指", "疑是銀河落九天", "以上皆非"],answer:2},
      {poem:'【唐詩理解】',text:'《春望》的作者是誰？',options:["駱賓王", "王翰", "杜甫", "王昌齡"],answer:2},
      {poem:'【唐詩理解】',text:'「國破山河在」的下一句是甚麼？',options:["以上皆非", "城春草木深", "另有所指", "無從判斷"],answer:1},
      {poem:'【唐詩理解】',text:'《泊船瓜洲》的作者是誰？',options:["王安石", "柳宗元", "蘇軾", "王翰"],answer:0},
      {poem:'【唐詩理解】',text:'「春風又綠江南岸」的下一句是甚麼？',options:["以上皆非", "無從判斷", "明月何時照我還", "另有所指"],answer:2},
      {poem:'【唐詩理解】',text:'《送杜少府之任蜀州》的作者是誰？',options:["王勃", "李商隱", "楊萬里", "駱賓王"],answer:0},
      {poem:'【唐詩理解】',text:'「海內存知己」的下一句是甚麼？',options:["天涯若比鄰", "另有所指", "無從判斷", "以上皆非"],answer:0},
      {poem:'【唐詩理解】',text:'《登幽州臺歌》的作者是誰？',options:["王翰", "杜甫", "陳子昂", "李白"],answer:2},
      {poem:'【唐詩理解】',text:'「前不見古人」的下一句是甚麼？',options:["另有所指", "無從判斷", "以上皆非", "後不見來者"],answer:3},
      {poem:'【唐詩理解】',text:'《黃鶴樓》的作者是誰？',options:["葉紹翁", "王昌齡", "崔顥", "陳子昂"],answer:2},
      {poem:'【唐詩理解】',text:'「日暮鄉關何處是」的下一句是甚麼？',options:["以上皆非", "另有所指", "煙波江上使人愁", "無從判斷"],answer:2},
      {poem:'【唐詩理解】',text:'《出塞》的作者是誰？',options:["孟浩然", "柳宗元", "李白", "王昌齡"],answer:3},
      {poem:'【唐詩理解】',text:'「秦時明月漢時關」的下一句是甚麼？',options:["以上皆非", "另有所指", "無從判斷", "萬里長征人未還"],answer:3},
      {poem:'【唐詩理解】',text:'《別董大》的作者是誰？',options:["高適", "王之渙", "王勃", "王安石"],answer:0},
      {poem:'【唐詩理解】',text:'「莫愁前路無知己」的下一句是甚麼？',options:["無從判斷", "以上皆非", "天下誰人不識君", "另有所指"],answer:2},
      {poem:'【唐詩理解】',text:'《涼州詞》「葡萄美酒夜光杯」的作者是誰？',options:["李白", "楊萬里", "王翰", "賈島"],answer:2},
      {poem:'【唐詩理解】',text:'「欲飲琵琶馬上催」的上一句是甚麼？',options:["另有所指", "無從判斷", "以上皆非", "葡萄美酒夜光杯"],answer:3},
      {poem:'【唐詩理解】',text:'《登樂遊原》的作者是誰？',options:["陳子昂", "孟浩然", "李商隱", "王勃"],answer:2},
      {poem:'【唐詩理解】',text:'「夕陽無限好」的下一句是甚麼？',options:["只是近黃昏", "另有所指", "無從判斷", "以上皆非"],answer:0},
      {poem:'【唐詩理解】',text:'《題西林壁》的作者是誰？',options:["賈島", "杜牧", "蘇軾", "陳子昂"],answer:2},
      {poem:'【唐詩理解】',text:'「不識廬山真面目」的下一句是甚麼？',options:["以上皆非", "無從判斷", "只緣身在此山中", "另有所指"],answer:2},
      {poem:'【唐詩理解】',text:'《夏日絕句》的作者是誰？',options:["王勃", "李清照", "陳子昂", "崔顥"],answer:1},
      {poem:'【唐詩理解】',text:'「生當作人傑」的下一句是甚麼？',options:["以上皆非", "另有所指", "無從判斷", "死亦為鬼雄"],answer:3},
      {poem:'【唐詩理解】',text:'《示兒》的作者是誰？',options:["陸游", "駱賓王", "李白", "王之渙"],answer:0},
      {poem:'【唐詩理解】',text:'「王師北定中原日」的下一句是甚麼？',options:["家祭無忘告乃翁", "以上皆非", "另有所指", "無從判斷"],answer:0},
      {poem:'【唐詩理解】',text:'《聞官軍收河南河北》的作者是誰？',options:["杜甫", "王之渙", "崔顥", "孟浩然"],answer:0},
      {poem:'【唐詩理解】',text:'「卻看妻子愁何在」的下一句是甚麼？',options:["無從判斷", "以上皆非", "漫卷詩書喜欲狂", "另有所指"],answer:2},
      {poem:'【找錯字】',text:'句子中有一個錯字：班上同學就環保議題進行辨論。',options:["不需改正", "辯→辨", "辨→辯", "以上皆非"],answer:2},
      {poem:'【找錯字】',text:'句子中有一個錯字：做事要先找出關建，再決定方法。',options:["建→鍵", "不需改正", "以上皆非", "鍵→建"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：每天運動和段鍊身體都很重要。',options:["段→鍛", "不需改正", "以上皆非", "鍛→段"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：這篇文章的脈洛十分清楚。',options:["以上皆非", "洛→絡", "不需改正", "絡→洛"],answer:1},
      {poem:'【找錯字】',text:'句子中有一個錯字：面對批評，我們要保持冷婧。',options:["不需改正", "靜→婧", "以上皆非", "婧→靜"],answer:3},
      {poem:'【找錯字】',text:'句子中有一個錯字：他以嚴僅的態度完成研究。',options:["僅→謹", "不需改正", "以上皆非", "謹→僅"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：這份報告的論正十分有力。',options:["正→證", "不需改正", "證→正", "以上皆非"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：老師提醒我們引用資料要註明出處，不能抄媳。',options:["媳→襲", "襲→媳", "以上皆非", "不需改正"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：他待人真誠，說話從不虛委。',options:["委→偽", "偽→委", "不需改正", "以上皆非"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：要改善作文，必須多閲讀、多練習。',options:["閱→閲", "閲→閱", "以上皆非", "不需改正"],answer:1},
      {poem:'【找錯字】',text:'句子中有一個錯字：他對自己的要求一向很茍格。',options:["嚴→茍", "不需改正", "以上皆非", "茍→嚴"],answer:3},
      {poem:'【找錯字】',text:'句子中有一個錯字：他勇於承認錯誤，態度十分成懇。',options:["誠→成", "不需改正", "成→誠", "以上皆非"],answer:2},
      {poem:'【找錯字】',text:'句子中有一個錯字：校方已公佈得奬名單。',options:["以上皆非", "不需改正", "獎→奬", "奬→獎"],answer:3},
      {poem:'【找錯字】',text:'句子中有一個錯字：我們應以客觀的態度分柝問題。',options:["以上皆非", "柝→析", "不需改正", "析→柝"],answer:1},
      {poem:'【找錯字】',text:'句子中有一個錯字：他在關鍵時刻仍能保持鎮訂。',options:["不需改正", "定→訂", "訂→定", "以上皆非"],answer:2},
      {poem:'【找錯字】',text:'句子中有一個錯字：這個觀點雖然新穎，但仍須要進一步驗證。',options:["需→須", "須→需", "以上皆非", "不需改正"],answer:1},
      {poem:'【找錯字】',text:'句子中有一個錯字：我們要學會體諒別人，不可一味埋苑。',options:["以上皆非", "怨→苑", "苑→怨", "不需改正"],answer:2},
      {poem:'【找錯字】',text:'句子中有一個錯字：同學們對這項提議展開熱烈討侖。',options:["論→侖", "侖→論", "以上皆非", "不需改正"],answer:1},
      {poem:'【找錯字】',text:'句子中有一個錯字：這篇文章語句流暢，結購完整。',options:["購→構", "構→購", "以上皆非", "不需改正"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：他處事果段，從不拖泥帶水。',options:["不需改正", "段→斷", "斷→段", "以上皆非"],answer:1},
      {poem:'【找錯字】',text:'句子中有一個錯字：面對未知，我們既要謹慎，也要保恃好奇心。',options:["以上皆非", "持→恃", "恃→持", "不需改正"],answer:2},
      {poem:'【找錯字】',text:'句子中有一個錯字：要達到目標，除了天分，還要靠持續磨鍊和積絫。',options:["累→絫", "不需改正", "以上皆非", "絫→累"],answer:3},
      {poem:'【找錯字】',text:'句子中有一個錯字：這位作者的觀察很細至，文字也很生動。',options:["緻→至", "至→緻", "以上皆非", "不需改正"],answer:1},
      {poem:'【找錯字】',text:'句子中有一個錯字：經過討論後，大家終於達成共識，氣氛十分融恰。',options:["不需改正", "以上皆非", "洽→恰", "恰→洽"],answer:3},
      {poem:'【找錯字】',text:'句子中有一個錯字：這次經驗令他獲益良多，也更加謙遜誠墾。',options:["墾→懇", "不需改正", "懇→墾", "以上皆非"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：她把資料整理得井井有條，沒有絲豪混亂。',options:["以上皆非", "毫→豪", "不需改正", "豪→毫"],answer:3},
      {poem:'【找錯字】',text:'句子中有一個錯字：只要方向正確，再遠的目標也能逐歩接近。',options:["步→歩", "歩→步", "不需改正", "以上皆非"],answer:1}
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
