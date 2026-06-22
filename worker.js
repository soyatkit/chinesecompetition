// 中文至叻挑戰賽 — Cloudflare Worker (固定五組 / 三回合版)
// Admin: lyt / lyt

import { ROUND_1, ROUND_2, ROUND_3, ROUND_BONUS, BANKS, BANKS_R2, BANKS_R3 } from './questions/banks.js';

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
        const gh = await fetch('https://raw.githubusercontent.com/soyatkit/chinesecompetition/main/index.html');
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
      const { grade, groupCount, initialScores, round } = await request.json().catch(() => ({}));
      if (!['P4', 'P5', 'P6'].includes(grade)) return err('Invalid grade', 400);
      const gc = Math.max(2, Math.min(6, Number(groupCount) || 4));
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const letters = 'ABCDEF'.slice(0, gc);
      const groups = {};
      for (const ch of letters) groups[ch] = (initialScores && typeof initialScores[ch] === 'number') ? initialScores[ch] : 0;
      const questions = getQuestions(round, grade);
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
          q = { poem: qq.category || qq.poem, category: qq.category || qq.poem, text: qq.text, options: qq.options, answer: qq.answer };
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

/**
 * Get questions for a given round and grade.
 * Returns a shuffled copy of the question bank.
 */
function getQuestions(round, grade) {
  const bank = round === 'r2' ? ROUND_2 : round === 'r3' ? ROUND_3 : round === 'r4' || round === 'bonus' ? ROUND_BONUS : ROUND_1;
  const qs = [...(bank[grade] || bank.P4)];
  for (let i = qs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [qs[i], qs[j]] = [qs[j], qs[i]];
  }
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
