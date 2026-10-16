// Vercel serverless function — sends the early-access emails via Resend.
// Env vars (set on Vercel): RESEND_API_KEY (required), MAIL_FROM (optional),
// NOTIFY_TO (optional — where to copy you on each new signup).
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const email = ((req.body && req.body.email) || "").toString().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) {
    return res.status(400).json({ error: "invalid email" });
  }

  const key = process.env.RESEND_API_KEY;
  if (!key) return res.status(503).json({ error: "email not configured yet" });
  const FROM = process.env.MAIL_FROM || "TABOOST <onboarding@resend.dev>";
  const NOTIFY = process.env.NOTIFY_TO || "";

  const send = (to, subject, html) =>
    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to, subject, html }),
    });

  try {
    const welcome = await send(
      email,
      "You're on the TABOOST early-access list 🎉",
      `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;color:#0E1414">
         <h2 style="color:#009999;margin:0 0 8px">You're in.</h2>
         <p>Thanks for joining the TABOOST early-access list. We'll send your invite and license key the moment your spot opens.</p>
         <p>In the meantime: TABOOST Poster posts to every platform from your own logins — no API keys, no passwords, ever.</p>
         <p style="color:#667">— TABOOST</p>
       </div>`
    );
    const body = await welcome.json().catch(() => ({}));
    if (!welcome.ok) return res.status(502).json({ error: "send failed", detail: body });

    if (NOTIFY) {
      await send(NOTIFY, "New TABOOST signup", `<p>New early-access signup: <b>${email}</b></p>`).catch(() => {});
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e) });
  }
}
