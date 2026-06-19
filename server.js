const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'leaderboard.json');
const MAX_ENTRIES = 20;

// ---- helpers ----
function readLB() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    }
  } catch (_) {}
  return [];
}

function writeLB(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

function sendJSON(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

// ---- server ----
const server = http.createServer((req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // GET /api/leaderboard
  if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
    const lb = readLB();
    sendJSON(res, 200, { success: true, leaderboard: lb.slice(0, MAX_ENTRIES) });
    return;
  }

  // POST /api/leaderboard
  if (req.method === 'POST' && url.pathname === '/api/leaderboard') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const entry = JSON.parse(body);

        // validate
        if (!entry.grade || !entry.className || !entry.studentNo || entry.score == null) {
          sendJSON(res, 400, { success: false, error: 'Missing required fields: grade, className, studentNo, score' });
          return;
        }
        if (!['P4', 'P5', 'P6'].includes(entry.grade)) {
          sendJSON(res, 400, { success: false, error: 'grade must be P4, P5, or P6' });
          return;
        }
        const score = Number(entry.score);
        if (isNaN(score) || score < 0 || score > 100) {
          sendJSON(res, 400, { success: false, error: 'score must be 0-100' });
          return;
        }

        const record = {
          grade: entry.grade,
          className: String(entry.className).slice(0, 10),
          studentNo: String(entry.studentNo).slice(0, 6),
          score,
          time: new Date().toISOString(),
        };

        const lb = readLB();
        lb.push(record);
        lb.sort((a, b) => b.score - a.score || new Date(a.time) - new Date(b.time));

        // keep top 50 at most, return top 20
        const trimmed = lb.slice(0, 50);
        writeLB(trimmed);

        sendJSON(res, 200, { success: true, rank: trimmed.indexOf(record) + 1, leaderboard: trimmed.slice(0, MAX_ENTRIES) });
      } catch (e) {
        sendJSON(res, 400, { success: false, error: 'Invalid JSON body' });
      }
    });
    return;
  }

  // Health check
  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJSON(res, 200, { status: 'ok', entries: readLB().length });
    return;
  }

  // 404
  sendJSON(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`📜 唐詩小狀元 API server running on port ${PORT}`);
  console.log(`   GET  /api/leaderboard  - 拎排行榜`);
  console.log(`   POST /api/leaderboard  - 提交分數`);
  console.log(`   GET  /api/health       - 健康檢查`);
});
