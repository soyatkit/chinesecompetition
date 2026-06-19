// ==================== 唐詩小狀元 — Cloudflare Worker ====================
// KV bindings: LEADERBOARD, SESSIONS
// Admin:  laoshi / tangshi2026

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const CORS = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const path = url.pathname;

    // ──── AUTH middleware ────
    function checkAuth(req) {
      const auth = req.headers.get('Authorization') || '';
      if (auth !== 'Bearer laoshi:tangshi2026') return false;
      return true;
    }

    // ──── ROUTES ────

    // ==================== HEALTH ====================
    if (path === '/api/health' && request.method === 'GET') {
      const data = (await env.LEADERBOARD.get('top20', 'json')) || [];
      return Response.json({ status: 'ok', entries: data.length }, { headers: CORS });
    }

    // ==================== LEADERBOARD (public) ====================
    if (path === '/api/leaderboard' && request.method === 'GET') {
      const data = (await env.LEADERBOARD.get('top20', 'json')) || [];
      return Response.json({ success: true, leaderboard: data }, { headers: CORS });
    }

    if (path === '/api/leaderboard' && request.method === 'POST') {
      return handleLeaderboardPost(request, env, CORS);
    }

    // ==================== ADMIN ====================
    if (path === '/api/admin/login' && request.method === 'POST') {
      const { username, password } = await request.json().catch(() => ({}));
      if (username === 'laoshi' && password === 'tangshi2026') {
        return Response.json({ success: true, token: 'laoshi:tangshi2026' }, { headers: CORS });
      }
      return Response.json({ success: false, error: 'Wrong credentials' }, { status: 401, headers: CORS });
    }

    if (path === '/api/admin/leaderboard' && request.method === 'DELETE') {
      if (!checkAuth(request)) {
        return Response.json({ success: false, error: 'Unauthorized' }, { status: 401, headers: CORS });
      }
      const { index } = await request.json().catch(() => ({}));
      const lb = (await env.LEADERBOARD.get('top20', 'json')) || [];
      if (index != null && index >= 0 && index < lb.length) {
        lb.splice(index, 1);
        await env.LEADERBOARD.put('top20', JSON.stringify(lb));
        return Response.json({ success: true, leaderboard: lb }, { headers: CORS });
      }
      // clear all
      await env.LEADERBOARD.put('top20', JSON.stringify([]));
      return Response.json({ success: true, leaderboard: [] }, { headers: CORS });
    }

    // ==================== SESSION ====================
    // POST /api/session/create — teacher creates game session
    if (path === '/api/session/create' && request.method === 'POST') {
      if (!checkAuth(request)) {
        return Response.json({ success: false, error: 'Unauthorized' }, { status: 401, headers: CORS });
      }
      const { grade } = await request.json().catch(() => ({}));
      if (!['P4', 'P5', 'P6'].includes(grade)) {
        return Response.json({ success: false, error: 'Invalid grade' }, { status: 400, headers: CORS });
      }
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const session = {
        code, grade,
        state: 'waiting',   // waiting | playing | finished
        currentQ: 0,
        questions: generateQuestions(grade),
        players: {},
        startedAt: null,
        createdAt: new Date().toISOString(),
      };
      await env.SESSIONS.put(code, JSON.stringify(session), { expirationTtl: 7200 });
      return Response.json({ success: true, code, grade }, { headers: CORS });
    }

    // POST /api/session/join — student joins
    if (path === '/api/session/join' && request.method === 'POST') {
      const { code, className, studentNo } = await request.json().catch(() => ({}));
      if (!code || !className || !studentNo) {
        return Response.json({ success: false, error: 'Missing fields' }, { status: 400, headers: CORS });
      }
      const raw = await env.SESSIONS.get(code);
      if (!raw) {
        return Response.json({ success: false, error: 'Session not found or expired' }, { status: 404, headers: CORS });
      }
      const session = JSON.parse(raw);
      if (session.state !== 'waiting') {
        return Response.json({ success: false, error: 'Game already started' }, { status: 400, headers: CORS });
      }
      const playerKey = `${className}_${studentNo}`;
      if (!session.players[playerKey]) {
        session.players[playerKey] = { className, studentNo, score: 0, joinedAt: new Date().toISOString() };
      }
      await env.SESSIONS.put(code, JSON.stringify(session), { expirationTtl: 7200 });
      return Response.json({ success: true, playerKey, grade: session.grade }, { headers: CORS });
    }

    // GET /api/session/:code — poll game state (students + teacher)
    const sessionMatch = path.match(/^\/api\/session\/(\d{6})$/);
    if (sessionMatch && request.method === 'GET') {
      const code = sessionMatch[1];
      const raw = await env.SESSIONS.get(code);
      if (!raw) {
        return Response.json({ success: false, error: 'Session not found' }, { status: 404, headers: CORS });
      }
      const session = JSON.parse(raw);
      const question = session.state === 'playing' && session.questions[session.currentQ]
        ? { text: session.questions[session.currentQ].text, poem: session.questions[session.currentQ].poem, options: session.questions[session.currentQ].options }
        : null;
      return Response.json({
        success: true,
        code: session.code,
        grade: session.grade,
        state: session.state,
        currentQ: session.currentQ,
        totalQ: session.questions.length,
        question,
        players: session.players,
      }, { headers: CORS });
    }

    // POST /api/session/:code/start — teacher starts game
    const startMatch = path.match(/^\/api\/session\/(\d{6})\/start$/);
    if (startMatch && request.method === 'POST') {
      if (!checkAuth(request)) {
        return Response.json({ success: false, error: 'Unauthorized' }, { status: 401, headers: CORS });
      }
      const code = startMatch[1];
      const raw = await env.SESSIONS.get(code);
      if (!raw) return Response.json({ success: false, error: 'Session not found' }, { status: 404, headers: CORS });
      const session = JSON.parse(raw);
      session.state = 'playing';
      session.currentQ = 0;
      session.startedAt = new Date().toISOString();
      await env.SESSIONS.put(code, JSON.stringify(session), { expirationTtl: 7200 });
      return Response.json({ success: true }, { headers: CORS });
    }

    // POST /api/session/:code/next — teacher advances to next Q
    const nextMatch = path.match(/^\/api\/session\/(\d{6})\/next$/);
    if (nextMatch && request.method === 'POST') {
      if (!checkAuth(request)) {
        return Response.json({ success: false, error: 'Unauthorized' }, { status: 401, headers: CORS });
      }
      const code = nextMatch[1];
      const raw = await env.SESSIONS.get(code);
      if (!raw) return Response.json({ success: false, error: 'Session not found' }, { status: 404, headers: CORS });
      const session = JSON.parse(raw);
      session.currentQ++;
      if (session.currentQ >= session.questions.length) {
        session.state = 'finished';
        // auto-save all players to leaderboard
        const lb = (await env.LEADERBOARD.get('top20', 'json')) || [];
        for (const [, p] of Object.entries(session.players)) {
          lb.push({ grade: session.grade, className: p.className, studentNo: p.studentNo, score: p.score, time: new Date().toISOString() });
        }
        lb.sort((a, b) => b.score - a.score || new Date(a.time) - new Date(b.time));
        await env.LEADERBOARD.put('top20', JSON.stringify(lb.slice(0, 50)));
      } else {
        session.players = resetPlayerAnswered(session.players);
      }
      await env.SESSIONS.put(code, JSON.stringify(session), { expirationTtl: 7200 });
      return Response.json({ success: true, state: session.state, currentQ: session.currentQ }, { headers: CORS });
    }

    // POST /api/session/:code/answer — student submits answer
    const ansMatch = path.match(/^\/api\/session\/(\d{6})\/answer$/);
    if (ansMatch && request.method === 'POST') {
      const code = ansMatch[1];
      const { playerKey, answer } = await request.json().catch(() => ({}));
      if (playerKey == null || answer == null) {
        return Response.json({ success: false, error: 'Missing fields' }, { status: 400, headers: CORS });
      }
      const raw = await env.SESSIONS.get(code);
      if (!raw) return Response.json({ success: false, error: 'Session not found' }, { status: 404, headers: CORS });
      const session = JSON.parse(raw);
      if (session.state !== 'playing') {
        return Response.json({ success: false, error: 'Game not in progress' }, { status: 400, headers: CORS });
      }
      const player = session.players[playerKey];
      if (!player) return Response.json({ success: false, error: 'Player not found' }, { status: 400, headers: CORS });
      if (player.answered) {
        return Response.json({ success: false, error: 'Already answered' }, { status: 400, headers: CORS });
      }
      const q = session.questions[session.currentQ];
      const correct = answer === q.answer;
      if (correct) player.score += 10;
      player.answered = true;
      player.lastAnswer = answer;
      player.lastCorrect = correct;
      await env.SESSIONS.put(code, JSON.stringify(session), { expirationTtl: 7200 });
      return Response.json({ success: true, correct, answer: q.answer, score: player.score }, { headers: CORS });
    }

    // POST /api/session/:code/end — teacher ends game early
    const endMatch = path.match(/^\/api\/session\/(\d{6})\/end$/);
    if (endMatch && request.method === 'POST') {
      if (!checkAuth(request)) {
        return Response.json({ success: false, error: 'Unauthorized' }, { status: 401, headers: CORS });
      }
      const code = endMatch[1];
      const raw = await env.SESSIONS.get(code);
      if (!raw) return Response.json({ success: false, error: 'Session not found' }, { status: 404, headers: CORS });
      const session = JSON.parse(raw);
      session.state = 'finished';
      const lb = (await env.LEADERBOARD.get('top20', 'json')) || [];
      for (const [, p] of Object.entries(session.players)) {
        lb.push({ grade: session.grade, className: p.className, studentNo: p.studentNo, score: p.score, time: new Date().toISOString() });
      }
      lb.sort((a, b) => b.score - a.score || new Date(a.time) - new Date(b.time));
      await env.LEADERBOARD.put('top20', JSON.stringify(lb.slice(0, 50)));
      await env.SESSIONS.put(code, JSON.stringify(session), { expirationTtl: 7200 });
      return Response.json({ success: true }, { headers: CORS });
    }

    // 404
    return Response.json({ error: 'Not found' }, { status: 404, headers: CORS });
  },
};

// ==================== HELPERS ====================

function resetPlayerAnswered(players) {
  const updated = {};
  for (const [key, p] of Object.entries(players)) {
    updated[key] = { ...p, answered: false, lastAnswer: null, lastCorrect: null };
  }
  return updated;
}

function generateQuestions(grade) {
  const BANK = {
    P4: [
      { poem: '《靜夜思》李白', text: '「床前明月光，疑是地上霜」出自哪首詩？', options: ['春曉', '靜夜思', '登鸛雀樓', '憫農'], answer: 1 },
      { poem: '《靜夜思》李白', text: '《靜夜思》的作者是誰？', options: ['杜甫', '李白', '白居易', '王維'], answer: 1 },
      { poem: '《靜夜思》李白', text: '「舉頭望明月」的下一句是甚麼？', options: ['疑是地上霜', '低頭思故鄉', '處處聞啼鳥', '粒粒皆辛苦'], answer: 1 },
      { poem: '《春曉》孟浩然', text: '「春眠不覺曉，處處聞啼鳥」中，詩人在哪個季節醒來？', options: ['夏天', '秋天', '冬天', '春天'], answer: 3 },
      { poem: '《春曉》孟浩然', text: '「夜來風雨聲，花落知多少」的作者是誰？', options: ['李白', '杜甫', '孟浩然', '王維'], answer: 2 },
      { poem: '《登鸛雀樓》王之渙', text: '「白日依山盡，黃河入海流」的下一句是？', options: ['欲窮千里目，更上一層樓', '舉頭望明月，低頭思故鄉', '夜來風雨聲，花落知多少', '誰知盤中餐，粒粒皆辛苦'], answer: 0 },
      { poem: '《憫農》李紳', text: '「誰知盤中餐，粒粒皆辛苦」提醒我們應該怎樣做？', options: ['多吃飯', '珍惜食物', '努力耕田', '好好讀書'], answer: 1 },
      { poem: '《詠鵝》駱賓王', text: '「鵝，鵝，鵝，曲項向天歌」中，駱賓王描寫鵝的甚麼特點？', options: ['鵝在睡覺', '鵝彎著脖子向天唱歌', '鵝在吃東西', '鵝在飛翔'], answer: 1 },
      { poem: '《相思》王維', text: '「紅豆生南國，春來發幾枝」中的「紅豆」象徵甚麼？', options: ['財富', '思念', '好運', '健康'], answer: 1 },
      { poem: '《鹿柴》王維', text: '「空山不見人，但聞人語響」描寫的是怎樣的環境？', options: ['熱鬧的城市', '寧靜的山林', '廣闊的大海', '繁華的市場'], answer: 1 },
    ],
    P5: [
      { poem: '《遊子吟》孟郊', text: '「慈母手中線，遊子身上衣」出自下列哪首詩？', options: ['回鄉偶書', '遊子吟', '楓橋夜泊', '望廬山瀑布'], answer: 1 },
      { poem: '《遊子吟》孟郊', text: '「誰言寸草心，報得三春暉」中的「寸草」比喻甚麼？', options: ['小草', '子女', '母親', '春天'], answer: 1 },
      { poem: '《回鄉偶書》賀知章', text: '「少小離家老大回，鄉音無改鬢毛衰」表達了甚麼情感？', options: ['興奮', '憤怒', '感慨時光流逝', '害怕'], answer: 2 },
      { poem: '《望廬山瀑布》李白', text: '「飛流直下三千尺，疑是銀河落九天」描寫的是甚麼？', options: ['黃河', '長江', '廬山瀑布', '大海'], answer: 2 },
      { poem: '《絕句》杜甫', text: '「兩個黃鸝鳴翠柳，一行白鷺上青天」中，詩人描寫了幾種鳥？', options: ['一種', '兩種', '三種', '四種'], answer: 1 },
      { poem: '《楓橋夜泊》張繼', text: '「姑蘇城外寒山寺」中的「姑蘇」是現今哪個城市？', options: ['杭州', '南京', '蘇州', '揚州'], answer: 2 },
      { poem: '《涼州詞》王翰', text: '「葡萄美酒夜光杯，欲飲琵琶馬上催」描寫的是甚麼場景？', options: ['家庭聚會', '邊塞軍旅宴飲', '皇宮宴會', '朋友送別'], answer: 1 },
      { poem: '《送孟浩然之廣陵》李白', text: '「煙花三月下揚州」中的「煙花」是指甚麼？', options: ['煙火', '春天的繁華景色', '煙和花', '戰爭的烽火'], answer: 1 },
      { poem: '《望天門山》李白', text: '「兩岸青山相對出，孤帆一片日邊來」描寫的是哪條江河？', options: ['黃河', '珠江', '長江', '淮河'], answer: 2 },
      { poem: '《早發白帝城》李白', text: '「千里江陵一日還」說明了甚麼？', options: ['路程很遠', '船速很快', '詩人很累', '天氣很好'], answer: 1 },
    ],
    P6: [
      { poem: '《送元二使安西》王維', text: '「勸君更盡一杯酒，西出陽關無故人」表達了甚麼情感？', options: ['喜悅', '依依不捨', '憤怒', '無所謂'], answer: 1 },
      { poem: '《九月九日憶山東兄弟》王維', text: '這首詩題目中的「九月九日」是甚麼節日？', options: ['中秋節', '端午節', '重陽節', '元宵節'], answer: 2 },
      { poem: '《贈汪倫》李白', text: '「桃花潭水深千尺，不及汪倫送我情」中，詩人用甚麼來比喻友情？', options: ['桃花', '潭水', '船隻', '山峰'], answer: 1 },
      { poem: '《江雪》柳宗元', text: '「千山鳥飛絕，萬徑人蹤滅」營造了怎樣的氣氛？', options: ['熱鬧歡樂', '生機勃勃', '孤獨冷清', '憤怒悲傷'], answer: 2 },
      { poem: '《江南春》杜牧', text: '「南朝四百八十寺，多少樓臺煙雨中」的「南朝」指甚麼？', options: ['唐朝', '宋朝', '魏晉南北朝時期的南方政權', '元朝'], answer: 2 },
      { poem: '《泊秦淮》杜牧', text: '「商女不知亡國恨，隔江猶唱後庭花」中，詩人實際上在諷刺誰？', options: ['商女', '平民百姓', '沉迷享樂的達官貴人', '詩人自己'], answer: 2 },
      { poem: '《山行》杜牧', text: '「停車坐愛楓林晚，霜葉紅於二月花」中「坐」字的意思是？', options: ['坐下', '因為', '乘坐', '座位'], answer: 1 },
      { poem: '《樂遊原》李商隱', text: '「夕陽無限好，只是近黃昏」表達了詩人甚麼心情？', options: ['興奮雀躍', '心滿意足', '惋惜和感慨', '憤怒不滿'], answer: 2 },
      { poem: '《烏衣巷》劉禹錫', text: '「舊時王謝堂前燕，飛入尋常百姓家」反映了甚麼？', options: ['燕子搬家了', '世事變遷、繁華不再', '春天來了', '人們喜歡燕子'], answer: 1 },
      { poem: '《望洞庭》劉禹錫', text: '「遙望洞庭山水翠，白銀盤裡一青螺」把洞庭湖比作甚麼？', options: ['鏡子', '白銀盤', '青螺', '山水畫'], answer: 1 },
    ],
  };
  const qs = BANK[grade] || BANK.P4;
  // Fisher-Yates shuffle
  for (let i = qs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [qs[i], qs[j]] = [qs[j], qs[i]];
  }
  return qs.slice(0, 10);
}

async function handleLeaderboardPost(request, env, CORS) {
  try {
    const entry = await request.json();
    if (!entry.grade || !entry.className || !entry.studentNo || entry.score == null) {
      return Response.json({ success: false, error: 'Missing fields' }, { status: 400, headers: CORS });
    }
    if (!['P4', 'P5', 'P6'].includes(entry.grade)) {
      return Response.json({ success: false, error: 'Invalid grade' }, { status: 400, headers: CORS });
    }
    const score = Number(entry.score);
    if (isNaN(score) || score < 0 || score > 100) {
      return Response.json({ success: false, error: 'Invalid score' }, { status: 400, headers: CORS });
    }
    const record = {
      grade: entry.grade,
      className: String(entry.className).slice(0, 10),
      studentNo: String(entry.studentNo).slice(0, 6),
      score,
      time: new Date().toISOString(),
    };
    const lb = (await env.LEADERBOARD.get('top20', 'json')) || [];
    lb.push(record);
    lb.sort((a, b) => b.score - a.score || new Date(a.time) - new Date(b.time));
    await env.LEADERBOARD.put('top20', JSON.stringify(lb.slice(0, 50)));
    return Response.json({ success: true, leaderboard: lb.slice(0, 20) }, { headers: CORS });
  } catch (_) {
    return Response.json({ success: false, error: 'Invalid JSON' }, { status: 400, headers: CORS });
  }
}
