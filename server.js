import express from "express";
import cors from "cors";
import webpush from "web-push";
import pkg from "pg";

const { Pool } = pkg;

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "1mb" }));

const {
  PORT = 3000,
  DATABASE_URL,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  VAPID_SUBJECT = "mailto:bookings@ravishingbeaute.salon",
  ADMIN_TOKEN = "admin-authenticated"
} = process.env;

const BOOKING_STATUSES = ["pending", "confirmed", "cancelled", "archived"];

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error("Missing VAPID keys.");
}

webpush.setVapidDetails(
  VAPID_SUBJECT,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL
    ? {
        rejectUnauthorized: false
      }
    : false
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

  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }

  return raw;
}

function normalizeFlexibleDate(value) {
  return value === true || value === "true";
}

function formatDate(value, flexibleDate) {
  if (flexibleDate) return "Flexible date";
  const date = cleanString(value);
  if (!date) return "Date not selected";

  try {
    return new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric"
    });
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

  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

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
    totalEstimate: row.total_estimate === null ? null : Number(row.total_estimate),
    notes: row.notes,
    addons: row.addons,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapServicePriceRow(row) {
  return {
    serviceId: row.service_id,
    basePrice: Number(row.base_price),
    priceLabel: row.price_label,
    updatedAt: row.updated_at
  };
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      subscription JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS booking_requests (
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
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS service_price_overrides (
      service_id TEXT PRIMARY KEY,
      base_price NUMERIC NOT NULL,
      price_label TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  console.log("Push, booking, and service pricing tables ready.");
}

await initDb();

async function sendPushNotification({
  title = "Ravishing Beauté",
  body = "You have a new appointment update.",
  url = "/"
} = {}) {
  const payload = JSON.stringify({ title, body, url });
  const result = await pool.query("SELECT * FROM push_subscriptions");

  let sent = 0;
  let failed = 0;

  for (const row of result.rows) {
    try {
      await webpush.sendNotification(row.subscription, payload);
      sent++;
    } catch (error) {
      failed++;

      console.error(
        "Push failed:",
        row.endpoint,
        error.statusCode || error.message
      );

      if (error.statusCode === 404 || error.statusCode === 410) {
        await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [
          row.endpoint
        ]);

        console.log("Removed invalid subscription:", row.endpoint);
      }
    }
  }

  return { ok: true, sent, failed };
}

app.get("/", async (req, res) => {
  const subscriptionCount = await pool.query(
    "SELECT COUNT(*) FROM push_subscriptions"
  );
  const bookingCount = await pool.query("SELECT COUNT(*) FROM booking_requests");
  const priceCount = await pool.query("SELECT COUNT(*) FROM service_price_overrides");

  res.json({
    ok: true,
    service: "Ravishing Beauté Push + Booking Server",
    stored: Number(subscriptionCount.rows[0].count),
    bookings: Number(bookingCount.rows[0].count),
    priceOverrides: Number(priceCount.rows[0].count)
  });
});

app.get("/vapid-public-key", (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.get("/service-prices", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM service_price_overrides ORDER BY service_id ASC"
    );
    res.json({ ok: true, prices: result.rows.map(mapServicePriceRow) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: "Failed to fetch service pricing" });
  }
});

app.get("/admin/service-prices", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM service_price_overrides ORDER BY service_id ASC"
    );
    res.json({ ok: true, prices: result.rows.map(mapServicePriceRow) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch service pricing" });
  }
});

app.patch("/admin/service-prices/:serviceId", requireAdmin, async (req, res) => {
  try {
    const serviceId = cleanString(req.params.serviceId);
    const rawBasePrice = req.body?.basePrice;
    const basePrice = typeof rawBasePrice === "number" ? rawBasePrice : Number(rawBasePrice);
    const priceLabel = cleanString(req.body?.priceLabel) || defaultPriceLabel(basePrice);

    if (!serviceId) {
      return res.status(400).json({ error: "Service id is required" });
    }

    if (!Number.isFinite(basePrice) || basePrice < 0) {
      return res.status(400).json({ error: "Base price must be 0 or higher" });
    }

    const result = await pool.query(
      `
      INSERT INTO service_price_overrides (service_id, base_price, price_label, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (service_id)
      DO UPDATE SET
        base_price = EXCLUDED.base_price,
        price_label = EXCLUDED.price_label,
        updated_at = NOW()
      RETURNING *
      `,
      [serviceId, basePrice, priceLabel]
    );

    res.json({ ok: true, price: mapServicePriceRow(result.rows[0]) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update service pricing" });
  }
});

app.post("/subscribe", async (req, res) => {
  try {
    const subscription = req.body;

    if (
      !subscription?.endpoint ||
      !subscription?.keys?.p256dh ||
      !subscription?.keys?.auth
    ) {
      return res.status(400).json({ ok: false, error: "Invalid subscription" });
    }

    await pool.query(
      `
      INSERT INTO push_subscriptions (
        endpoint,
        p256dh,
        auth,
        subscription
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (endpoint)
      DO UPDATE SET
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        subscription = EXCLUDED.subscription
      `,
      [
        subscription.endpoint,
        subscription.keys.p256dh,
        subscription.keys.auth,
        subscription
      ]
    );

    const count = await pool.query("SELECT COUNT(*) FROM push_subscriptions");
    console.log("Subscription stored:", subscription.endpoint);

    res.json({ ok: true, stored: Number(count.rows[0].count) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/send", async (req, res) => {
  try {
    const result = await sendPushNotification(req.body || {});
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: error.message });
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

    if (!clientName) {
      return res.status(400).json({ ok: false, error: "Please enter your name." });
    }

    if (!phone) {
      return res.status(400).json({ ok: false, error: "Please enter your phone number." });
    }

    if (!service) {
      return res.status(400).json({ ok: false, error: "Please select a service." });
    }

    const clientWebPushSubscription = body.clientWebPushSubscription
      ? typeof body.clientWebPushSubscription === "string"
        ? JSON.parse(body.clientWebPushSubscription)
        : body.clientWebPushSubscription
      : null;

    const insert = await pool.query(
      `
      INSERT INTO booking_requests (
        client_name,
        phone,
        service,
        preferred_date,
        flexible_date,
        time_preference,
        notes,
        addons,
        base_price,
        total_estimate,
        status,
        client_web_push_subscription
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11)
      RETURNING *
      `,
      [
        clientName,
        phone,
        service,
        preferredDate,
        flexibleDate,
        timePreference,
        notes,
        addons,
        basePrice,
        totalEstimate,
        clientWebPushSubscription
      ]
    );

    const booking = mapBookingRow(insert.rows[0]);
    const serviceLabel = booking.serviceLabel;
    const dateLabel = formatDate(preferredDate, flexibleDate);
    const estimateLabel = totalEstimate ? ` • $${totalEstimate}+` : "";

    const push = await sendPushNotification({
      title: `New booking request from ${clientName}`,
      body: `${serviceLabel} • ${dateLabel} • ${timePreference}${estimateLabel}`,
      url: "/admin"
    });

    res.status(201).json({
      ok: true,
      id: booking.id,
      status: booking.status,
      message: "Booking request submitted.",
      booking,
      push
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      ok: false,
      error: "Booking request could not be submitted. Please try again."
    });
  }
});

app.get("/admin/booking-requests", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM booking_requests ORDER BY created_at DESC"
    );

    res.json(result.rows.map(mapBookingRow));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch booking requests" });
  }
});

app.patch("/admin/booking-requests/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const status = cleanString(req.body?.status);

    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    if (!BOOKING_STATUSES.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const result = await pool.query(
      `
      UPDATE booking_requests
      SET status = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *
      `,
      [status, id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Not found" });
    }

    const booking = mapBookingRow(result.rows[0]);

    if (status === "confirmed" || status === "cancelled") {
      await sendPushNotification({
        title: status === "confirmed" ? "Appointment Confirmed" : "Appointment Update",
        body:
          status === "confirmed"
            ? `${booking.serviceLabel} has been confirmed.`
            : `${booking.serviceLabel} was marked cancelled.`,
        url: "/admin"
      });
    }

    res.json(booking);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update booking request" });
  }
});

app.listen(PORT, () => {
  console.log(`Push server running on port ${PORT}`);
});
