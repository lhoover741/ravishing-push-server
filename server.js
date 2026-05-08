import express from "express";
import cors from "cors";
import webpush from "web-push";
import pkg from "pg";

const { Pool } = pkg;
const app = express();

app.use(cors({ origin: "*", methods: ["GET", "POST", "PATCH", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.use(express.json({ limit: "1mb" }));

const {
  PORT = 3000,
  DATABASE_URL,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  VAPID_SUBJECT = "mailto:bookings@ravishingbeaute.salon",
  ADMIN_TOKEN = "admin-authenticated",
  DEPOSIT_PAYMENT_LINK = ""
} = process.env;

const BOOKING_STATUSES = ["pending", "confirmed", "cancelled", "archived"];
const AUDIENCES = ["admin", "client"];

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : false
});

const SERVICE_LABELS = {
  "small-knotless": "Small Knotless",
  "medium-knotless": "Medium Knotless",
  "large-knotless": "Large Knotless",
  "two-feed-ins": "2 Feed-Ins",
  "six-feed-ins": "6 Feed-Ins",
  "eight-feed-ins": "8 Feed-Ins",
  "ten-fourteen-feed-ins": "10–14 Feed-Ins",
  "fourteen-twenty-feed-ins": "14–20+ Feed-Ins",
  "fulani-braids": "Fulani Braids",
  "lemonade-braids": "Lemonade Braids",
  "braided-ponytail": "Braided Ponytail",
  "middle-part-quick-weave": "Middle Part Quick Weave",
  "side-part-quick-weave": "Side Part Quick Weave",
  "free-part-quick-weave": "Free Part Quick Weave",
  "half-up-half-down": "Half Up Half Down",
  "half-freestyle-half-quick-weave": "Half Freestyle Half Quick Weave",
  "standard-sew-in": "Standard Sew-In",
  "half-up-half-down-sew-in": "Half Up Half Down Sew-In",
  "sleek-ponytail": "Sleek Ponytail",
  "natural-styles": "Natural Styles",
  "knotless-sm": "Small Knotless",
  "knotless-md": "Medium Knotless",
  "knotless-lg": "Large Knotless",
  feedin: "Feed-In Braids",
  stitch: "Feed-In Braids",
  bobbraids: "Fulani Braids",
  ponytail: "Sleek Ponytail",
  quickweave: "Middle Part Quick Weave"
};

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePhone(value) {
  const raw = cleanString(value);
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  return raw;
}

function normalizeBoolean(value) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

function normalizeAudience(value) {
  const audience = cleanString(value).toLowerCase();
  return AUDIENCES.includes(audience) ? audience : "client";
}

function normalizeFlexibleDate(value) {
  return value === true || value === "true";
}

function formatDate(value, flexibleDate) {
  if (flexibleDate) return "Flexible date";
  const date = cleanString(value);
  if (!date) return "Date not selected";
  try {
    return new Date(`${date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  } catch {
    return date;
  }
}

function defaultPriceLabel(basePrice) {
  return Number(basePrice) > 0 ? `$${Number(basePrice)}+` : "Custom";
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function mapBookingRow(row) {
  return {
    id: Number(row.id),
    clientName: row.client_name,
    phone: row.phone,
    service: row.service,
    serviceLabel: SERVICE_LABELS[row.service] || row.service,
    preferredDate: row.preferred_date,
    flexibleDate: row.flexible_date ? "true" : "false",
    timePreference: row.time_preference,
    status: row.status,
    depositPaid: Boolean(row.deposit_paid),
    depositPaidAt: row.deposit_paid_at,
    totalEstimate: row.total_estimate === null ? null : Number(row.total_estimate),
    notes: row.notes,
    addons: row.addons,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapServicePriceRow(row) {
  return { serviceId: row.service_id, basePrice: Number(row.base_price), priceLabel: row.price_label, updatedAt: row.updated_at };
}

function mapSettings(rows) {
  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return { depositPaymentLink: settings.deposit_payment_link || DEPOSIT_PAYMENT_LINK || "" };
}

async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, subscription JSONB NOT NULL, created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query("ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'client'");

  await pool.query(`CREATE TABLE IF NOT EXISTS booking_requests (
    id BIGSERIAL PRIMARY KEY,
    client_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    service TEXT NOT NULL,
    preferred_date TEXT,
    flexible_date BOOLEAN DEFAULT FALSE,
    time_preference TEXT NOT NULL DEFAULT 'flexible',
    notes TEXT,
    addons TEXT,
    base_price NUMERIC,
    total_estimate NUMERIC,
    status TEXT NOT NULL DEFAULT 'pending',
    client_web_push_subscription JSONB,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  )`);
  await pool.query("ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS deposit_paid BOOLEAN DEFAULT FALSE");
  await pool.query("ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS deposit_paid_at TIMESTAMP");

  await pool.query(`CREATE TABLE IF NOT EXISTS service_price_overrides (service_id TEXT PRIMARY KEY, base_price NUMERIC NOT NULL, price_label TEXT NOT NULL, updated_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TIMESTAMP DEFAULT NOW())`);

  if (DEPOSIT_PAYMENT_LINK) {
    await pool.query(`INSERT INTO app_settings (key, value, updated_at) VALUES ('deposit_payment_link', $1, NOW()) ON CONFLICT (key) DO NOTHING`, [DEPOSIT_PAYMENT_LINK]);
  }

  console.log("Ravishing Beauté database ready.");
}

await initDb();

async function removeInvalidSubscription(row, error) {
  if (error.statusCode === 404 || error.statusCode === 410) {
    await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [row.endpoint]);
  }
}

async function sendStoredPush({ title = "Ravishing Beauté", body = "You have a new update.", url = "/", audience = "all" } = {}) {
  const payload = JSON.stringify({ title, body, url });
  const result = audience === "all"
    ? await pool.query("SELECT * FROM push_subscriptions")
    : await pool.query("SELECT * FROM push_subscriptions WHERE audience = $1", [normalizeAudience(audience)]);

  let sent = 0;
  let failed = 0;
  for (const row of result.rows) {
    try {
      await webpush.sendNotification(row.subscription, payload);
      sent++;
    } catch (error) {
      failed++;
      console.error("Push failed:", row.endpoint, error.statusCode || error.message);
      await removeInvalidSubscription(row, error);
    }
  }
  return { ok: true, audience, sent, failed };
}

async function sendDirectPush(subscription, { title = "Ravishing Beauté", body = "You have a new update.", url = "/" } = {}) {
  if (!subscription?.endpoint) return { ok: false, sent: 0, failed: 0, skipped: true };
  try {
    await webpush.sendNotification(subscription, JSON.stringify({ title, body, url }));
    return { ok: true, sent: 1, failed: 0 };
  } catch (error) {
    console.error("Direct client push failed:", error.statusCode || error.message);
    return { ok: false, sent: 0, failed: 1, error: error.message };
  }
}

app.get("/", async (req, res) => {
  const subscriptionCount = await pool.query("SELECT COUNT(*) FROM push_subscriptions");
  const adminCount = await pool.query("SELECT COUNT(*) FROM push_subscriptions WHERE audience = 'admin'");
  const clientCount = await pool.query("SELECT COUNT(*) FROM push_subscriptions WHERE audience = 'client'");
  const bookingCount = await pool.query("SELECT COUNT(*) FROM booking_requests");
  const depositPaidCount = await pool.query("SELECT COUNT(*) FROM booking_requests WHERE deposit_paid = TRUE");
  const priceCount = await pool.query("SELECT COUNT(*) FROM service_price_overrides");
  res.json({ ok: true, service: "Ravishing Beauté Push + Booking Server", stored: Number(subscriptionCount.rows[0].count), adminSubscriptions: Number(adminCount.rows[0].count), clientSubscriptions: Number(clientCount.rows[0].count), bookings: Number(bookingCount.rows[0].count), depositPaid: Number(depositPaidCount.rows[0].count), priceOverrides: Number(priceCount.rows[0].count) });
});

app.get("/vapid-public-key", (req, res) => res.json({ publicKey: VAPID_PUBLIC_KEY }));

app.get("/service-prices", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM service_price_overrides ORDER BY service_id ASC");
    res.json({ ok: true, prices: result.rows.map(mapServicePriceRow) });
  } catch {
    res.status(500).json({ ok: false, error: "Failed to fetch service pricing" });
  }
});

app.get("/admin/settings", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT key, value FROM app_settings");
    res.json({ ok: true, settings: mapSettings(result.rows) });
  } catch {
    res.status(500).json({ error: "Failed to fetch admin settings" });
  }
});

app.patch("/admin/settings", requireAdmin, async (req, res) => {
  try {
    const depositPaymentLink = cleanString(req.body?.depositPaymentLink);
    await pool.query(`INSERT INTO app_settings (key, value, updated_at) VALUES ('deposit_payment_link', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [depositPaymentLink]);
    const result = await pool.query("SELECT key, value FROM app_settings");
    res.json({ ok: true, settings: mapSettings(result.rows) });
  } catch {
    res.status(500).json({ error: "Failed to update admin settings" });
  }
});

app.get("/admin/service-prices", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM service_price_overrides ORDER BY service_id ASC");
    res.json({ ok: true, prices: result.rows.map(mapServicePriceRow) });
  } catch {
    res.status(500).json({ error: "Failed to fetch service pricing" });
  }
});

app.patch("/admin/service-prices/:serviceId", requireAdmin, async (req, res) => {
  try {
    const serviceId = cleanString(req.params.serviceId);
    const basePrice = typeof req.body?.basePrice === "number" ? req.body.basePrice : Number(req.body?.basePrice);
    const priceLabel = cleanString(req.body?.priceLabel) || defaultPriceLabel(basePrice);
    if (!serviceId) return res.status(400).json({ error: "Service id is required" });
    if (!Number.isFinite(basePrice) || basePrice < 0) return res.status(400).json({ error: "Base price must be 0 or higher" });
    const result = await pool.query(`INSERT INTO service_price_overrides (service_id, base_price, price_label, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (service_id) DO UPDATE SET base_price = EXCLUDED.base_price, price_label = EXCLUDED.price_label, updated_at = NOW() RETURNING *`, [serviceId, basePrice, priceLabel]);
    res.json({ ok: true, price: mapServicePriceRow(result.rows[0]) });
  } catch {
    res.status(500).json({ error: "Failed to update service pricing" });
  }
});

app.post("/subscribe", async (req, res) => {
  try {
    const body = req.body || {};
    const audience = normalizeAudience(body.audience);
    const subscription = body.subscription?.endpoint ? body.subscription : body;
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) return res.status(400).json({ ok: false, error: "Invalid subscription" });
    await pool.query(`INSERT INTO push_subscriptions (endpoint, p256dh, auth, subscription, audience) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, subscription = EXCLUDED.subscription, audience = EXCLUDED.audience`, [subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, subscription, audience]);
    const count = await pool.query("SELECT COUNT(*) FROM push_subscriptions WHERE audience = $1", [audience]);
    res.json({ ok: true, audience, stored: Number(count.rows[0].count) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/send", async (req, res) => {
  try {
    const result = await sendStoredPush(req.body || {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/admin/client-notification", requireAdmin, async (req, res) => {
  try {
    const title = cleanString(req.body?.title) || "Ravishing Beauté";
    const body = cleanString(req.body?.body);
    const url = cleanString(req.body?.url) || "/";
    if (!body) return res.status(400).json({ error: "Notification message is required" });
    const result = await sendStoredPush({ title, body, url, audience: "client" });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Failed to send client notification" });
  }
});

app.post("/booking-requests", async (req, res) => {
  try {
    const body = req.body || {};
    const clientName = cleanString(body.clientName);
    const phone = normalizePhone(body.phone);
    const service = cleanString(body.service);
    const preferredDate = cleanString(body.preferredDate) || null;
    const flexibleDate = normalizeFlexibleDate(body.flexibleDate);
    const timePreference = cleanString(body.timePreference) || "flexible";
    const notes = cleanString(body.notes) || null;
    const addons = cleanString(body.addons) || null;
    const basePrice = typeof body.basePrice === "number" ? body.basePrice : null;
    const totalEstimate = typeof body.totalEstimate === "number" ? body.totalEstimate : null;
    if (!clientName) return res.status(400).json({ ok: false, error: "Please enter your name." });
    if (!phone) return res.status(400).json({ ok: false, error: "Please enter your phone number." });
    if (!service) return res.status(400).json({ ok: false, error: "Please select a service." });
    const clientWebPushSubscription = body.clientWebPushSubscription ? (typeof body.clientWebPushSubscription === "string" ? JSON.parse(body.clientWebPushSubscription) : body.clientWebPushSubscription) : null;
    const insert = await pool.query(`INSERT INTO booking_requests (client_name, phone, service, preferred_date, flexible_date, time_preference, notes, addons, base_price, total_estimate, status, client_web_push_subscription) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11) RETURNING *`, [clientName, phone, service, preferredDate, flexibleDate, timePreference, notes, addons, basePrice, totalEstimate, clientWebPushSubscription]);
    const booking = mapBookingRow(insert.rows[0]);
    const dateLabel = formatDate(preferredDate, flexibleDate);
    const estimateLabel = totalEstimate ? ` • $${totalEstimate}+` : "";
    const adminPush = await sendStoredPush({ title: `New booking request from ${clientName}`, body: `${booking.serviceLabel} • ${dateLabel} • ${timePreference}${estimateLabel}`, url: "/admin", audience: "admin" });
    await sendDirectPush(clientWebPushSubscription, { title: "Booking request received", body: `${booking.serviceLabel} is pending review. Shawna will text you to confirm.`, url: "/book" });
    res.status(201).json({ ok: true, id: booking.id, status: booking.status, message: "Booking request submitted.", booking, push: adminPush });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: "Booking request could not be submitted. Please try again." });
  }
});

app.get("/admin/booking-requests", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM booking_requests ORDER BY created_at DESC");
    res.json(result.rows.map(mapBookingRow));
  } catch {
    res.status(500).json({ error: "Failed to fetch booking requests" });
  }
});

app.patch("/admin/booking-requests/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const status = cleanString(req.body?.status);
    const depositPaid = normalizeBoolean(req.body?.depositPaid);
    const updateParts = [];
    const params = [];
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
    if (status) {
      if (!BOOKING_STATUSES.includes(status)) return res.status(400).json({ error: "Invalid status" });
      params.push(status);
      updateParts.push(`status = $${params.length}`);
    }
    if (depositPaid !== null) {
      params.push(depositPaid);
      const depositIndex = params.length;
      updateParts.push(`deposit_paid = $${depositIndex}`);
      updateParts.push(`deposit_paid_at = CASE WHEN $${depositIndex} THEN NOW() ELSE NULL END`);
    }
    if (!updateParts.length) return res.status(400).json({ error: "No valid update provided" });
    params.push(id);
    const result = await pool.query(`UPDATE booking_requests SET ${updateParts.join(", ")}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`, params);
    if (!result.rows.length) return res.status(404).json({ error: "Not found" });
    const booking = mapBookingRow(result.rows[0]);
    const raw = result.rows[0];
    if (status === "confirmed" || status === "cancelled") {
      await sendStoredPush({ title: status === "confirmed" ? "Appointment Confirmed" : "Appointment Update", body: status === "confirmed" ? `${booking.serviceLabel} has been confirmed.` : `${booking.serviceLabel} was marked cancelled.`, url: "/admin", audience: "admin" });
      await sendDirectPush(raw.client_web_push_subscription, { title: status === "confirmed" ? "Appointment Confirmed" : "Appointment Update", body: status === "confirmed" ? `${booking.serviceLabel} has been confirmed. Your $25 deposit is required to secure it.` : `${booking.serviceLabel} could not be confirmed as submitted.`, url: "/book" });
    }
    res.json(booking);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update booking request" });
  }
});

app.listen(PORT, () => console.log(`Push server running on port ${PORT}`));
