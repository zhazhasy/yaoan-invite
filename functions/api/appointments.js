let schemaReady;

const ADMIN_PASSWORD_HEADER = "x-admin-password";

export async function onRequest(context) {
  const { request, env } = context;
  const { method } = request;
  const url = new URL(request.url);

  if (!env.DB) {
    return json({ ok: false, message: "D1 database is not bound. Missing DB binding." }, 500);
  }

  if (method === "GET" || method === "DELETE") {
    const authError = verifyAdmin(request, env);
    if (authError) {
      return authError;
    }
  }

  await ensureSchema(env.DB);

  if (method === "GET") {
    try {
      const { results } = await env.DB.prepare(
        `SELECT id, created_at, company, contact_name, position, phone, attendees, note
         FROM appointments
         ORDER BY datetime(created_at) DESC`
      ).all();

      const data = (results || []).map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        company: row.company,
        contactName: row.contact_name,
        position: row.position || "",
        phone: row.phone,
        attendees: row.attendees,
        note: row.note || ""
      }));

      const exportFormat = String(url.searchParams.get("export") || "").trim().toLowerCase();
      if (exportFormat) {
        return exportAppointments(data, exportFormat);
      }

      return json({ ok: true, total: data.length, data });
    } catch (error) {
      return json({ ok: false, message: `读取失败: ${error.message}`, data: [] }, 500);
    }
  }

  if (method === "POST") {
    try {
      const body = await request.json();
      const company = String(body.company || "").trim();
      const contactName = String(body.contactName || "").trim();
      const position = String(body.position || "").trim();
      const phone = String(body.phone || "").trim();
      const attendees = Number(body.attendees || 0);
      const note = String(body.note || "").trim();

      if (!company || !contactName || !position || !phone || !attendees) {
        return json({ ok: false, message: "请完整填写必填项" }, 400);
      }

      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();

      await env.DB.prepare(
        `INSERT INTO appointments
         (id, created_at, company, contact_name, position, phone, attendees, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(id, createdAt, company, contactName, position, phone, attendees, note)
        .run();

      return json({ ok: true, message: "预约提交成功", id });
    } catch (error) {
      return json({ ok: false, message: `提交失败: ${error.message}` }, 500);
    }
  }

  if (method === "DELETE") {
    try {
      const id = String(url.searchParams.get("id") || "").trim();
      if (!id) {
        return json({ ok: false, message: "缺少 id 参数" }, 400);
      }

      const result = await env.DB.prepare("DELETE FROM appointments WHERE id = ?")
        .bind(id)
        .run();

      if (!result.success || (result.meta?.changes || 0) === 0) {
        return json({ ok: false, message: "未找到要删除的数据" }, 404);
      }

      return json({ ok: true, message: "删除成功" });
    } catch (error) {
      return json({ ok: false, message: `删除失败: ${error.message}` }, 500);
    }
  }

  return json({ ok: false, message: "Method Not Allowed" }, 405);
}

async function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = syncSchema(db).catch((error) => {
      schemaReady = undefined;
      throw error;
    });
  }

  await schemaReady;
}

async function syncSchema(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      company TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      attendees INTEGER NOT NULL,
      note TEXT
    )`
  ).run();

  const { results } = await db.prepare("PRAGMA table_info(appointments)").all();
  const columns = new Set((results || []).map((row) => row.name));

  if (!columns.has("position")) {
    await db.prepare("ALTER TABLE appointments ADD COLUMN position TEXT").run();
  }
}

function verifyAdmin(request, env) {
  const configuredPassword = String(env.ADMIN_PASSWORD || "").trim();
  if (!configuredPassword) {
    return json({ ok: false, message: "后台密码未配置，请先在 Cloudflare Pages 中设置 ADMIN_PASSWORD。" }, 503);
  }

  const providedPassword = getProvidedPassword(request);
  if (!providedPassword || providedPassword !== configuredPassword) {
    return json({ ok: false, message: "后台密码错误或未提供密码。" }, 401, {
      "www-authenticate": 'Bearer realm="admin"'
    });
  }

  return null;
}

function getProvidedPassword(request) {
  const headerPassword = String(request.headers.get(ADMIN_PASSWORD_HEADER) || "").trim();
  if (headerPassword) {
    return headerPassword;
  }

  const authorization = String(request.headers.get("authorization") || "").trim();
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function exportAppointments(data, format) {
  if (format !== "json") {
    return json({ ok: false, message: "当前仅支持 JSON 备份导出。" }, 400);
  }

  const exportedAt = new Date().toISOString();
  const totalAttendees = data.reduce((sum, item) => sum + (Number(item.attendees) || 0), 0);
  const fileName = `appointments-backup-${exportedAt.replaceAll(":", "-")}.json`;
  const backup = {
    exportedAt,
    total: data.length,
    totalAttendees,
    data
  };

  return textResponse(JSON.stringify(backup, null, 2), 200, "application/json; charset=utf-8", {
    "content-disposition": `attachment; filename="${fileName}"`
  });
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  });
}

function textResponse(body, status, contentType, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": contentType,
      ...extraHeaders
    }
  });
}
