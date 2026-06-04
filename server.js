const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'appointments.json');
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '').trim();
const ADMIN_PASSWORD_HEADER = 'x-admin-password';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.mp3': 'audio/mpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
};

function getStaticCacheControl(ext) {
  if (ext === '.html') return 'no-cache';
  if (ext === '.css' || ext === '.js') return 'public, max-age=604800';
  if (['.jpg', '.jpeg', '.png', '.webp', '.svg', '.mp3'].includes(ext)) {
    return 'public, max-age=2592000';
  }
  return 'public, max-age=86400';
}

function send(res, status, body, type = 'application/json; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': type, ...extraHeaders });
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
  let decodedTarget = target;
  try {
    decodedTarget = decodeURIComponent(target);
  } catch {
    decodedTarget = target;
  }
  const fullPath = path.normalize(path.join(ROOT, decodedTarget));
  if (!fullPath.startsWith(ROOT)) {
    return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
  }

  fs.stat(fullPath, (err, stats) => {
    if (err || !stats.isFile()) {
      return send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
    }

    const ext = path.extname(fullPath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const lastModified = stats.mtime.toUTCString();
    const etag = `W/"${stats.size}-${Math.floor(stats.mtimeMs)}"`;
    const headers = {
      'Content-Type': type,
      'Content-Length': stats.size,
      'Cache-Control': getStaticCacheControl(ext),
      'Last-Modified': lastModified,
      ETag: etag,
      'Accept-Ranges': 'bytes'
    };

    const range = req.headers.range;
    if (!range) {
      const ifNoneMatch = req.headers['if-none-match'];
      const ifModifiedSince = req.headers['if-modified-since'];
      const notModifiedByTag = ifNoneMatch && ifNoneMatch === etag;
      const notModifiedByDate =
        ifModifiedSince && new Date(ifModifiedSince).getTime() >= stats.mtime.getTime();

      if (notModifiedByTag || notModifiedByDate) {
        res.writeHead(304, {
          'Cache-Control': headers['Cache-Control'],
          'Last-Modified': lastModified,
          ETag: etag,
          'Accept-Ranges': 'bytes'
        });
        return res.end();
      }
    }

    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      if (!match) {
        res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` });
        return res.end();
      }

      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : stats.size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end >= stats.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` });
        return res.end();
      }

      res.writeHead(206, {
        ...headers,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stats.size}`
      });
      return fs.createReadStream(fullPath, { start, end }).pipe(res);
    }

    res.writeHead(200, headers);
    fs.createReadStream(fullPath).pipe(res);
  });
}

function getProvidedPassword(req) {
  const headerPassword = String(req.headers[ADMIN_PASSWORD_HEADER] || '').trim();
  if (headerPassword) return headerPassword;

  const authorization = String(req.headers.authorization || '').trim();
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function requireAdminAuth(req, res) {
  if (!ADMIN_PASSWORD) {
    send(
      res,
      503,
      JSON.stringify({ ok: false, message: '后台密码未配置，请先设置 ADMIN_PASSWORD。' }),
      'application/json; charset=utf-8'
    );
    return false;
  }

  const providedPassword = getProvidedPassword(req);
  if (!providedPassword || providedPassword !== ADMIN_PASSWORD) {
    send(
      res,
      401,
      JSON.stringify({ ok: false, message: '后台密码错误或未提供密码。' }),
      'application/json; charset=utf-8',
      { 'WWW-Authenticate': 'Bearer realm="admin"' }
    );
    return false;
  }

  return true;
}

function exportRows(res, rows, format) {
  if (format !== 'json') {
    return send(res, 400, JSON.stringify({ ok: false, message: '当前仅支持 JSON 备份导出。' }));
  }

  const exportedAt = new Date().toISOString();
  const totalAttendees = rows.reduce((sum, item) => sum + (Number(item.attendees) || 0), 0);
  const fileName = `appointments-backup-${exportedAt.replaceAll(':', '-')}.json`;
  const backup = {
    exportedAt,
    total: rows.length,
    totalAttendees,
    data: rows
  };

  return send(
    res,
    200,
    JSON.stringify(backup, null, 2),
    'application/json; charset=utf-8',
    { 'Content-Disposition': `attachment; filename="${fileName}"` }
  );
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
        position: String(body.position || '').trim(),
        phone: String(body.phone || '').trim(),
        attendees: Number(body.attendees || 0),
        note: String(body.note || '').trim()
      };

      if (!record.company || !record.contactName || !record.position || !record.phone || !record.attendees) {
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
    if (!requireAdminAuth(req, res)) return;

    const rows = safeReadJson(DATA_FILE);
    const exportFormat = String(url.searchParams.get('export') || '').trim().toLowerCase();
    if (exportFormat) {
      return exportRows(res, rows, exportFormat);
    }
    return send(res, 200, JSON.stringify({ ok: true, total: rows.length, data: rows }));
  }

  if (pathname === '/api/appointments' && req.method === 'DELETE') {
    if (!requireAdminAuth(req, res)) return;

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
