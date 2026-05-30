const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'appointments.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf8');
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const target = pathname === '/' ? '/index.html' : pathname;
  const fullPath = path.normalize(path.join(ROOT, target));
  if (!fullPath.startsWith(ROOT)) {
    return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      return send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
    }
    const ext = path.extname(fullPath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    send(res, 200, data, type);
  });
}

ensureDataFile();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (pathname === '/api/appointments' && req.method === 'POST') {
    try {
      const raw = await collectBody(req);
      const body = JSON.parse(raw || '{}');

      const record = {
        id: Date.now().toString(36),
        createdAt: new Date().toISOString(),
        company: String(body.company || '').trim(),
        contactName: String(body.contactName || '').trim(),
        phone: String(body.phone || '').trim(),
        attendees: Number(body.attendees || 0),
        note: String(body.note || '').trim()
      };

      if (!record.company || !record.contactName || !record.phone || !record.attendees) {
        return send(res, 400, JSON.stringify({ ok: false, message: '请完整填写必填项' }));
      }

      const rows = safeReadJson(DATA_FILE);
      rows.push(record);
      fs.writeFileSync(DATA_FILE, JSON.stringify(rows, null, 2), 'utf8');

      return send(res, 200, JSON.stringify({ ok: true, message: '预约提交成功' }));
    } catch (err) {
      return send(res, 500, JSON.stringify({ ok: false, message: '提交失败，请稍后重试' }));
    }
  }

  if (pathname === '/api/appointments' && req.method === 'GET') {
    const rows = safeReadJson(DATA_FILE);
    return send(res, 200, JSON.stringify({ ok: true, total: rows.length, data: rows }));
  }

  if (pathname === '/api/appointments' && req.method === 'DELETE') {
    try {
      const id = String(url.searchParams.get('id') || '').trim();
      if (!id) {
        return send(res, 400, JSON.stringify({ ok: false, message: '缺少 id 参数' }));
      }

      const rows = safeReadJson(DATA_FILE);
      const nextRows = rows.filter((item) => String(item.id) !== id);
      if (nextRows.length === rows.length) {
        return send(res, 404, JSON.stringify({ ok: false, message: '未找到要删除的数据' }));
      }

      fs.writeFileSync(DATA_FILE, JSON.stringify(nextRows, null, 2), 'utf8');
      return send(res, 200, JSON.stringify({ ok: true, message: '删除成功' }));
    } catch {
      return send(res, 500, JSON.stringify({ ok: false, message: '删除失败，请稍后重试' }));
    }
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
