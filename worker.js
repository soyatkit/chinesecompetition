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
      {poem:'【部首】',text:'「跑」的部首是甚麼？',options:["木", "火", "氵", "足"],answer:3},
      {poem:'【部首】',text:'「樹」的部首是甚麼？',options:["口", "火", "木", "氵"],answer:2},
      {poem:'【詞義辨析】',text:'「高興」的近義詞是甚麼？',options:["視情況而定", "無從判斷", "以上皆非", "開心"],answer:3},
      {poem:'【詞義辨析】',text:'「勇敢」的反義詞是甚麼？',options:["膽小", "無從判斷", "以上皆非", "視情況而定"],answer:0},
      {poem:'【詞義辨析】',text:'「快速」的近義詞是甚麼？',options:["無從判斷", "以上皆非", "視情況而定", "迅速"],answer:3},
      {poem:'【成語運用】',text:'「一心一意」是形容做事怎樣？',options:["視情況而定", "以上皆非", "專心", "無從判斷"],answer:2},
      {poem:'【成語運用】',text:'「井底之蛙」比喻甚麼人？',options:["見識短淺的人", "以上皆非", "視情況而定", "無從判斷"],answer:0},
      {poem:'【成語運用】',text:'「畫龍點睛」比喻甚麼？',options:["無從判斷", "以上皆非", "視情況而定", "在關鍵地方加上精彩一筆，使內容更生動"],answer:3},
      {poem:'【詞語填充】',text:'雖然天氣突然轉壞，但同學們仍然＿＿秩序，安靜地返回課室。',options:["放棄", "保持", "忘記", "停止"],answer:1},
      {poem:'【詞語填充】',text:'哥哥做事一向很＿＿，因此老師常把重要任務交給他。',options:["忘記", "認真", "停止", "放棄"],answer:1},
      {poem:'【詞語填充】',text:'這篇文章內容＿＿，不但有趣，還能啟發我們思考。',options:["忘記", "停止", "豐富", "放棄"],answer:2},
      {poem:'【修辭辨識】',text:'「月亮像一隻彎彎的小船，靜靜地掛在天上。」用了甚麼修辭？',options:["比喻", "排比", "誇張", "擬人"],answer:0},
      {poem:'【修辭辨識】',text:'「微風輕輕吹過，花兒點頭微笑。」用了甚麼修辭？',options:["擬人", "誇張", "比喻", "排比"],answer:0},
      {poem:'【修辭辨識】',text:'「他跑得比風還快，一轉眼就到終點了。」用了甚麼修辭？',options:["誇張", "比喻", "排比", "擬人"],answer:0},
      {poem:'【修辭辨識】',text:'「我愛閱讀，愛思考，愛寫作。」用了甚麼修辭？',options:["排比", "比喻", "誇張", "擬人"],answer:0},
      {poem:'【修辭辨識】',text:'「這樣美麗的景色，怎能不叫人喜愛呢？」用了甚麼修辭？',options:["比喻", "擬人", "誇張", "反問"],answer:3},
      {poem:'【唐詩理解】',text:'《靜夜思》的作者是誰？',options:["杜甫", "李白", "白居易", "王維"],answer:1},
      {poem:'【綜合】',text:'「舉頭望明月」的下一句是甚麼？',options:["低頭思故鄉", "選項D", "選項B", "選項C"],answer:0},
      {poem:'【綜合】',text:'「白日依山盡」的下一句是甚麼？',options:["選項D", "黃河入海流", "選項B", "選項C"],answer:1},
      {poem:'【唐詩理解】',text:'《登鸛雀樓》的作者是誰？',options:["王之渙", "王維", "李白", "杜甫"],answer:0},
      {poem:'【唐詩理解】',text:'「春眠不覺曉」出自哪一首詩？',options:["《春曉》", "《憫農》", "《靜夜思》", "《登鸛雀樓》"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：妹妹最喜歡吃草莓和平果。請找出錯字並改正。',options:["平 → 蘋", "平 → 平", "蘋 → 平", "無需改正"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：同學們在操塲上進行早會。請找出錯字並改正。',options:["塲 → 場", "無需改正", "塲 → 塲", "場 → 塲"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：圖書館裡十分安靖，大家都在專心看書。請找出錯字並改正。',options:["靜 → 靖", "靖 → 靜", "靖 → 靖", "無需改正"],answer:1}
    ],
    P5: [
      {poem:'【部首】',text:'「懶」的部首是甚麼？',options:["氵", "木", "火", "忄"],answer:3},
      {poem:'【部首】',text:'「鋼」的部首是甚麼？',options:["火", "木", "金", "氵"],answer:2},
      {poem:'【部首】',text:'「裁」的部首是甚麼？',options:["火", "衣", "氵", "木"],answer:1},
      {poem:'【詞義辨析】',text:'「珍貴」的近義詞是甚麼？',options:["以上皆非", "視情況而定", "寶貴", "無從判斷"],answer:2},
      {poem:'【詞義辨析】',text:'「炎熱」的反義詞是甚麼？',options:["視情況而定", "寒冷", "無從判斷", "以上皆非"],answer:1},
      {poem:'【詞義辨析】',text:'「清楚」的近義詞是甚麼？',options:["無從判斷", "明白", "以上皆非", "視情況而定"],answer:1},
      {poem:'【成語運用】',text:'「專心致志」是形容甚麼？',options:["視情況而定", "無從判斷", "專心投入", "以上皆非"],answer:2},
      {poem:'【成語運用】',text:'「畫蛇添足」比喻甚麼？',options:["以上皆非", "多此一舉", "無從判斷", "視情況而定"],answer:1},
      {poem:'【成語運用】',text:'「津津有味」通常形容甚麼？',options:["無從判斷", "以上皆非", "吃得或讀得很有味道、很感興趣", "視情況而定"],answer:2},
      {poem:'【詞語填充】',text:'面對困難，我們要＿＿，不要輕易放棄。',options:["停止", "忘記", "堅持", "放棄"],answer:2},
      {poem:'【詞語填充】',text:'這篇文章條理＿＿，很容易明白。',options:["清晰", "停止", "放棄", "忘記"],answer:0},
      {poem:'【詞語填充】',text:'他經常幫助同學，十分＿＿。',options:["熱心", "放棄", "忘記", "停止"],answer:0},
      {poem:'【修辭辨識】',text:'「書，是良師；書，是益友；書，是明燈。」用了甚麼修辭？',options:["誇張", "排比", "比喻", "擬人"],answer:1},
      {poem:'【修辭辨識】',text:'「天對地，雨對風。」用了甚麼修辭？',options:["擬人", "比喻", "對偶", "誇張"],answer:2},
      {poem:'【修辭辨識】',text:'「誰不想把事情做好呢？」用了甚麼修辭？',options:["反問", "擬人", "誇張", "比喻"],answer:0},
      {poem:'【修辭辨識】',text:'「甚麼是真正的勇氣？真正的勇氣，是跌倒後再站起來。」用了甚麼修辭？',options:["比喻", "擬人", "誇張", "設問"],answer:3},
      {poem:'【修辭辨識】',text:'「盼望着，盼望着，春天終於來了。」用了甚麼修辭？',options:["擬人", "反覆", "誇張", "比喻"],answer:1},
      {poem:'【綜合】',text:'「欲窮千里目」的下一句是甚麼？',options:["更上一層樓", "選項D", "選項C", "選項B"],answer:0},
      {poem:'【唐詩理解】',text:'《黃鶴樓送孟浩然之廣陵》的作者是誰？',options:["白居易", "王維", "杜甫", "李白"],answer:3},
      {poem:'【綜合】',text:'「兩個黃鸝鳴翠柳」的下一句是甚麼？',options:["選項D", "選項C", "選項B", "一行白鷺上青天"],answer:3},
      {poem:'【唐詩理解】',text:'《江雪》的作者是誰？',options:["王維", "柳宗元", "李白", "杜甫"],answer:1},
      {poem:'【綜合】',text:'「千山鳥飛絕」的下一句是甚麼？',options:["萬徑人蹤滅", "選項D", "選項B", "選項C"],answer:0},
      {poem:'【找錯字】',text:'句子中有一個錯字：我們應該遵敬師長，友愛同學。請找出錯字並改正。',options:["遵 → 遵", "尊 → 遵", "無需改正", "遵 → 尊"],answer:3},
      {poem:'【找錯字】',text:'句子中有一個錯字：老師常常鼓厉我們勇敢嘗試。請找出錯字並改正。',options:["無需改正", "厉 → 厉", "厉 → 勵", "勵 → 厉"],answer:2},
      {poem:'【找錯字】',text:'句子中有一個錯字：只要堅恃到底，就有成功的機會。請找出錯字並改正。',options:["持 → 恃", "無需改正", "恃 → 持", "恃 → 恃"],answer:2}
    ],
    P6: [
      {poem:'【部首】',text:'「籍」的部首是甚麼？',options:["氵", "火", "木", "竹"],answer:3},
      {poem:'【部首】',text:'「警」的部首是甚麼？',options:["木", "言", "氵", "火"],answer:1},
      {poem:'【部首】',text:'「顧」的部首是甚麼？',options:["火", "木", "頁", "氵"],answer:2},
      {poem:'【詞義辨析】',text:'「堅毅」的近義詞是甚麼？',options:["無從判斷", "以上皆非", "視情況而定", "堅定"],answer:3},
      {poem:'【詞義辨析】',text:'「慷慨」的反義詞是甚麼？',options:["無從判斷", "以上皆非", "吝嗇", "視情況而定"],answer:2},
      {poem:'【詞義辨析】',text:'「敏捷」的近義詞是甚麼？',options:["以上皆非", "迅捷", "無從判斷", "視情況而定"],answer:1},
      {poem:'【成語運用】',text:'「胸有成竹」比喻甚麼？',options:["無從判斷", "視情況而定", "以上皆非", "做事前已有周詳打算"],answer:3},
      {poem:'【成語運用】',text:'「實事求是」是指甚麼？',options:["按實際情況處理，不誇大不虛假", "視情況而定", "無從判斷", "以上皆非"],answer:0},
      {poem:'【成語運用】',text:'「堅持不懈」是形容怎樣的態度？',options:["無從判斷", "視情況而定", "持續努力，不輕易放棄", "以上皆非"],answer:2},
      {poem:'【詞語填充】',text:'成功沒有捷徑，只有靠長期＿＿和努力。',options:["停止", "忘記", "放棄", "積累"],answer:3},
      {poem:'【詞語填充】',text:'面對不同意見，我們應保持＿＿，理性討論。',options:["放棄", "停止", "忘記", "冷靜"],answer:3},
      {poem:'【詞語填充】',text:'這次專題研習資料＿＿，分析也很深入。',options:["停止", "充實", "忘記", "放棄"],answer:1},
      {poem:'【修辭辨識】',text:'「燕子去了，有再來的時候；楊柳枯了，有再青的時候；桃花謝了，有再開的時候。」用了甚麼修辭？',options:["排比", "擬人", "誇張", "比喻"],answer:0},
      {poem:'【修辭辨識】',text:'「學如逆水行舟，不進則退。」用了甚麼修辭？',options:["擬人", "排比", "比喻", "誇張"],answer:2},
      {poem:'【修辭辨識】',text:'「你怎能說這件事和你完全無關？」用了甚麼修辭？',options:["比喻", "擬人", "誇張", "反問"],answer:3},
      {poem:'【修辭辨識】',text:'「甚麼是責任？責任就是把應做的事做好。」用了甚麼修辭？',options:["設問", "比喻", "擬人", "誇張"],answer:0},
      {poem:'【修辭辨識】',text:'「盼啊，盼啊，我們終於等到畢業旅行了。」用了甚麼修辭？',options:["擬人", "誇張", "比喻", "反覆"],answer:3},
      {poem:'【唐詩理解】',text:'《送元二使安西》的作者是誰？',options:["李白", "王維", "杜甫", "白居易"],answer:1},
      {poem:'【綜合】',text:'「勸君更盡一杯酒」的下一句是甚麼？',options:["選項B", "選項D", "選項C", "西出陽關無故人"],answer:3},
      {poem:'【唐詩理解】',text:'《望廬山瀑布》的作者是誰？',options:["白居易", "王維", "李白", "杜甫"],answer:2},
      {poem:'【綜合】',text:'「飛流直下三千尺」的下一句是甚麼？',options:["選項C", "疑是銀河落九天", "選項D", "選項B"],answer:1},
      {poem:'【唐詩理解】',text:'《春望》的作者是誰？',options:["白居易", "李白", "王維", "杜甫"],answer:3},
      {poem:'【找錯字】',text:'句子中有一個錯字：班上同學就環保議題進行辨論。請找出錯字並改正。',options:["無需改正", "辨 → 辯", "辨 → 辨", "辯 → 辨"],answer:1},
      {poem:'【找錯字】',text:'句子中有一個錯字：做事要先找出關建，再決定方法。請找出錯字並改正。',options:["無需改正", "建 → 鍵", "鍵 → 建", "建 → 建"],answer:1},
      {poem:'【找錯字】',text:'句子中有一個錯字：每天運動和段鍊身體都很重要。請找出錯字並改正。',options:["段 → 鍛", "鍛 → 段", "段 → 段", "無需改正"],answer:0}
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
