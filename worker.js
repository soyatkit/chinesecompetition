export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // GET /api/leaderboard — 拎排行榜 Top 20
    if (request.method === 'GET' && url.pathname === '/api/leaderboard') {
      const data = await env.LEADERBOARD.get('top20', 'json');
      return Response.json(
        { success: true, leaderboard: data || [] },
        { headers: corsHeaders }
      );
    }

    // POST /api/leaderboard — 提交分數
    if (request.method === 'POST' && url.pathname === '/api/leaderboard') {
      try {
        const entry = await request.json();

        if (!entry.grade || !entry.className || !entry.studentNo || entry.score == null) {
          return Response.json(
            { success: false, error: 'Missing required fields' },
            { status: 400, headers: corsHeaders }
          );
        }
        if (!['P4', 'P5', 'P6'].includes(entry.grade)) {
          return Response.json(
            { success: false, error: 'grade must be P4, P5, or P6' },
            { status: 400, headers: corsHeaders }
          );
        }
        const score = Number(entry.score);
        if (isNaN(score) || score < 0 || score > 100) {
          return Response.json(
            { success: false, error: 'score must be 0–100' },
            { status: 400, headers: corsHeaders }
          );
        }

        const record = {
          grade: entry.grade,
          className: String(entry.className).slice(0, 10),
          studentNo: String(entry.studentNo).slice(0, 6),
          score,
          time: new Date().toISOString(),
        };

        const current = (await env.LEADERBOARD.get('top20', 'json')) || [];
        current.push(record);
        current.sort((a, b) => b.score - a.score || new Date(a.time) - new Date(b.time));

        // 保留 top 50 防止無限增長，對外只返 top 20
        const top50 = current.slice(0, 50);
        await env.LEADERBOARD.put('top20', JSON.stringify(top50));

        return Response.json(
          { success: true, leaderboard: top50.slice(0, 20) },
          { headers: corsHeaders }
        );
      } catch (_) {
        return Response.json(
          { success: false, error: 'Invalid JSON body' },
          { status: 400, headers: corsHeaders }
        );
      }
    }

    // GET /api/health
    if (request.method === 'GET' && url.pathname === '/api/health') {
      const data = (await env.LEADERBOARD.get('top20', 'json')) || [];
      return Response.json(
        { status: 'ok', entries: data.length },
        { headers: corsHeaders }
      );
    }

    return Response.json(
      { error: 'Not found' },
      { status: 404, headers: corsHeaders }
    );
  },
};
