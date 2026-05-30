export async function onRequest(context) {
  const { request, env } = context;
  const { method } = request;
  const url = new URL(request.url);

  if (!env.DB) {
    return json({ ok: false, message: "D1 数据库未绑定（缺少 DB）" }, 500);
  }

  if (method === "GET") {
    try {
      const { results } = await env.DB.prepare(
        `SELECT id, created_at, company, contact_name, phone, attendees, note
         FROM appointments
         ORDER BY datetime(created_at) DESC`
      ).all();

      const data = (results || []).map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        company: row.company,
        contactName: row.contact_name,
        phone: row.phone,
        attendees: row.attendees,
        note: row.note || ""
      }));

      return json({ ok: true, total: data.length, data });
    } catch (e) {
      return json({ ok: false, message: `读取失败: ${e.message}`, data: [] }, 500);
    }
  }

  if (method === "POST") {
    try {
      const body = await request.json();
      const company = String(body.company || "").trim();
      const contactName = String(body.contactName || "").trim();
      const phone = String(body.phone || "").trim();
      const attendees = Number(body.attendees || 0);
      const note = String(body.note || "").trim();

      if (!company || !contactName || !phone || !attendees) {
        return json({ ok: false, message: "请完整填写必填项" }, 400);
      }

      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();

      await env.DB.prepare(
        `INSERT INTO appointments
         (id, created_at, company, contact_name, phone, attendees, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(id, createdAt, company, contactName, phone, attendees, note)
        .run();

      return json({ ok: true, message: "预约提交成功", id });
    } catch (e) {
      return json({ ok: false, message: `提交失败: ${e.message}` }, 500);
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
    } catch (e) {
      return json({ ok: false, message: `删除失败: ${e.message}` }, 500);
    }
  }

  return json({ ok: false, message: "Method Not Allowed" }, 405);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

