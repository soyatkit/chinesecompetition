#!/usr/bin/env python3
"""Regenerate worker.js cleanly."""

# Read existing worker to get genQ bank
with open('/Users/yatkit/Desktop/唐詩問題/worker.js') as f:
    old = f.read()

# Extract genQ function (find from "function genQ" to end of worker code, before INDEX_HTML)
genq_start = old.index('function genQ')
# Find where the old INDEX_HTML starts
idx_start = old.index('const INDEX_HTML')
genq_code = old[genq_start:idx_start].rstrip()

worker = f"""// 唐詩小狀元 — Cloudflare Worker (小組搶答版)
// Admin: lyt / lyt

export default {{
  async fetch(request, env) {{
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '*';
    const CORS = {{
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    }};
    if (request.method === 'OPTIONS') return new Response(null, {{ status: 204, headers: CORS }});

    const p = url.pathname;
    function ok(data) {{ return Response.json({{ success: true, ...data }}, {{ headers: CORS }}); }}
    function err(msg, code) {{ return Response.json({{ success: false, error: msg }}, {{ status: code, headers: CORS }}); }}
    function auth(req) {{ return (req.headers.get('Authorization') || '') === 'Bearer lyt:lyt'; }}

    // ── SERVE WEBSITE (fetch fresh from GitHub raw, zero CDN) ──
    if (request.method === 'GET' && (p === '/' || p === '/index.html' || p === '')) {{
      try {{
        const gh = await fetch('https://raw.githubusercontent.com/soyatkit/chinesepoetry/main/index.html');
        if (gh.ok) {{
          const h = await gh.text();
          return new Response(h, {{
            headers: {{ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, max-age=0', 'Pragma': 'no-cache', 'Expires': '0' }},
          }});
        }}
      }} catch (e) {{}}
      return new Response(FALLBACK_HTML, {{
        headers: {{ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' }},
      }});
    }}

    // ── HEALTH ──
    if (p === '/api/health') {{ const d = (await env.LEADERBOARD.get('top20', 'json')) || []; return ok({{ status: 'ok', entries: d.length }}); }}

    // ── LEADERBOARD ──
    if (p === '/api/leaderboard' && request.method === 'GET') {{ return ok({{ leaderboard: (await env.LEADERBOARD.get('top20', 'json')) || [] }}); }}
    if (p === '/api/leaderboard' && request.method === 'POST') {{ return handleLBPost(request, env, CORS); }}

    // ── ADMIN LOGIN ──
    if (p === '/api/admin/login' && request.method === 'POST') {{
      const {{ username, password }} = await request.json().catch(() => ({{}}));
      return (username === 'lyt' && password === 'lyt') ? ok({{ token: 'lyt:lyt' }}) : err('Wrong credentials', 401);
    }}

    // ── ADMIN DELETE LB ──
    if (p === '/api/admin/leaderboard' && request.method === 'DELETE') {{
      if (!auth(request)) return err('Unauthorized', 401);
      const {{ index }} = await request.json().catch(() => ({{}}));
      const lb = (await env.LEADERBOARD.get('top20', 'json')) || [];
      if (index != null && index >= 0 && index < lb.length) {{ lb.splice(index, 1); await env.LEADERBOARD.put('top20', JSON.stringify(lb)); return ok({{ leaderboard: lb }}); }}
      await env.LEADERBOARD.put('top20', JSON.stringify([]));
      return ok({{ leaderboard: [] }});
    }}

    // ── SESSION CREATE ──
    if (p === '/api/session/create' && request.method === 'POST') {{
      if (!auth(request)) return err('Unauthorized', 401);
      const {{ grade, groupCount }} = await request.json().catch(() => ({{}}));
      if (!['P4', 'P5', 'P6'].includes(grade)) return err('Invalid grade', 400);
      const gc = Math.max(2, Math.min(6, Number(groupCount) || 4));
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const letters = 'ABCDEF'.slice(0, gc);
      const groups = {{}};
      for (const ch of letters) groups[ch] = 0;
      const session = {{ code, grade, groupCount: gc, state: 'waiting', currentQ: 0, questions: genQ(grade), groups, history: [], createdAt: new Date().toISOString() }};
      await env.SESSIONS.put(code, JSON.stringify(session), {{ expirationTtl: 7200 }});
      return ok({{ code, grade, groupCount: gc }});
    }}

    // ── SESSION GET ──
    const sm = p.match(/^\\\\/api\\\\/session\\\\/(\\\\d{{6}})$/);
    if (sm && request.method === 'GET') {{
      const raw = await env.SESSIONS.get(sm[1]);
      if (!raw) return err('Session not found', 404);
      const s = JSON.parse(raw);
      const q = s.state === 'playing' && s.questions[s.currentQ] ? {{ poem: s.questions[s.currentQ].poem, text: s.questions[s.currentQ].text, options: s.questions[s.currentQ].options, answer: s.questions[s.currentQ].answer }} : null;
      return ok({{ code: s.code, grade: s.grade, groupCount: s.groupCount || 4, state: s.state, currentQ: s.currentQ, totalQ: s.questions.length, question: q, groups: s.groups, history: s.history }});
    }}

    // ── SESSION START ──
    const startM = p.match(/^\\\\/api\\\\/session\\\\/(\\\\d{{6}})\\\\/start$/);
    if (startM && request.method === 'POST') {{
      if (!auth(request)) return err('Unauthorized', 401);
      const raw = await env.SESSIONS.get(startM[1]); if (!raw) return err('Not found', 404);
      const s = JSON.parse(raw); s.state = 'playing'; s.currentQ = 0;
      await env.SESSIONS.put(startM[1], JSON.stringify(s), {{ expirationTtl: 7200 }});
      return ok({{}});
    }}

    // ── SCORE GROUP ──
    const scoreM = p.match(/^\\\\/api\\\\/session\\\\/(\\\\d{{6}})\\\\/score$/);
    if (scoreM && request.method === 'POST') {{
      if (!auth(request)) return err('Unauthorized', 401);
      const {{ group, type }} = await request.json().catch(() => ({{}}));
      if (!/^[A-F]$/.test(group) || !['correct','wrong'].includes(type)) return err('Invalid params', 400);
      const raw = await env.SESSIONS.get(scoreM[1]); if (!raw) return err('Not found', 404);
      const s = JSON.parse(raw);
      if (s.state !== 'playing') return err('Game not started', 400);
      const delta = type === 'correct' ? 10 : -5;
      s.groups[group] = Math.max(0, (s.groups[group] || 0) + delta);
      s.history.push({{ q: s.currentQ, group, type, delta, time: new Date().toISOString() }});
      await env.SESSIONS.put(scoreM[1], JSON.stringify(s), {{ expirationTtl: 7200 }});
      return ok({{ groups: s.groups }});
    }}

    // ── NEXT QUESTION ──
    const nextM = p.match(/^\\\\/api\\\\/session\\\\/(\\\\d{{6}})\\\\/next$/);
    if (nextM && request.method === 'POST') {{
      if (!auth(request)) return err('Unauthorized', 401);
      const raw = await env.SESSIONS.get(nextM[1]); if (!raw) return err('Not found', 404);
      const s = JSON.parse(raw); s.currentQ++;
      if (s.currentQ >= s.questions.length) {{
        s.state = 'finished';
        const lb = (await env.LEADERBOARD.get('top20', 'json')) || [];
        for (const [g, sc] of Object.entries(s.groups)) {{
          lb.push({{ grade: s.grade, group: g, className: '\u7B2C' + g + '\u7D44', studentNo: '', score: sc, time: new Date().toISOString() }});
        }}
        lb.sort((a, b) => b.score - a.score || new Date(a.time) - new Date(b.time));
        await env.LEADERBOARD.put('top20', JSON.stringify(lb.slice(0, 50)));
      }}
      await env.SESSIONS.put(nextM[1], JSON.stringify(s), {{ expirationTtl: 7200 }});
      return ok({{ state: s.state, currentQ: s.currentQ }});
    }}

    // ── END GAME ──
    const endM = p.match(/^\\\\/api\\\\/session\\\\/(\\\\d{{6}})\\\\/end$/);
    if (endM && request.method === 'POST') {{
      if (!auth(request)) return err('Unauthorized', 401);
      const raw = await env.SESSIONS.get(endM[1]); if (!raw) return err('Not found', 404);
      const s = JSON.parse(raw); s.state = 'finished';
      const lb = (await env.LEADERBOARD.get('top20', 'json')) || [];
      for (const [g, sc] of Object.entries(s.groups)) {{
        lb.push({{ grade: s.grade, group: g, className: '\u7B2C' + g + '\u7D44', studentNo: '', score: sc, time: new Date().toISOString() }});
      }}
      lb.sort((a, b) => b.score - a.score || new Date(a.time) - new Date(b.time));
      await env.LEADERBOARD.put('top20', JSON.stringify(lb.slice(0, 50)));
      await env.SESSIONS.put(endM[1], JSON.stringify(s), {{ expirationTtl: 7200 }});
      return ok({{}});
    }}

    return err('Not found', 404);
  }},
}};

{genq_code}

const FALLBACK_HTML = `<!DOCTYPE html>
<html lang="zh-HK"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>唐詩小狀元</title>
<style>body{{font-family:sans-serif;text-align:center;padding:40px;background:#FFF8F0;color:#5C4033;}}h1{{color:#E8909E;}}</style></head><body>
<h1>📜 唐詩小狀元</h1><p>載入中...</p>
<script>fetch('https://raw.githubusercontent.com/soyatkit/chinesepoetry/main/index.html').then(r=>r.text()).then(h=>{{document.open();document.write(h);document.close()}}).catch(function(){{location.href='https://soyatkit.github.io/chinesepoetry/'}})</script>
</body></html>`;
"""

with open('/Users/yatkit/Desktop/唐詩問題/worker.js', 'w') as f:
    f.write(worker)
print('OK - worker.js regenerated')
