import express from "express";
import cors from "cors";
import webpush from "web-push";
import pkg from "pg";

const { Pool } = pkg;

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json({ limit: "1mb" }));

const {
  PORT = 3000,
  DATABASE_URL,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  VAPID_SUBJECT = "mailto:bookings@ravishingbeaute.salon"
} = process.env;

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

  console.log("Push subscription table ready.");
}

await initDb();

app.get("/", async (req, res) => {
  const count = await pool.query(
    "SELECT COUNT(*) FROM push_subscriptions"
  );

  res.json({
    ok: true,
    service: "Ravishing Beauté Push Server",
    stored: Number(count.rows[0].count)
  });
});

app.get("/vapid-public-key", (req, res) => {
  res.json({
    publicKey: VAPID_PUBLIC_KEY
  });
});

app.post("/subscribe", async (req, res) => {
  try {
    const subscription = req.body;

    if (
      !subscription?.endpoint ||
      !subscription?.keys?.p256dh ||
      !subscription?.keys?.auth
    ) {
      return res.status(400).json({
        ok: false,
        error: "Invalid subscription"
      });
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

    const count = await pool.query(
      "SELECT COUNT(*) FROM push_subscriptions"
    );

    console.log("Subscription stored:", subscription.endpoint);

    res.json({
      ok: true,
      stored: Number(count.rows[0].count)
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/send", async (req, res) => {
  try {
    const {
      title = "Ravishing Beauté",
      body = "You have a new appointment update.",
      url = "/"
    } = req.body || {};

    const payload = JSON.stringify({
      title,
      body,
      url
    });

    const result = await pool.query(
      "SELECT * FROM push_subscriptions"
    );

    let sent = 0;
    let failed = 0;

    for (const row of result.rows) {
      try {
        await webpush.sendNotification(
          row.subscription,
          payload
        );

        sent++;
      } catch (error) {
        failed++;

        console.error(
          "Push failed:",
          row.endpoint,
          error.statusCode || error.message
        );

        if (
          error.statusCode === 404 ||
          error.statusCode === 410
        ) {
          await pool.query(
            "DELETE FROM push_subscriptions WHERE endpoint = $1",
            [row.endpoint]
          );

          console.log("Removed invalid subscription:", row.endpoint);
        }
      }
    }

    res.json({
      ok: true,
      sent,
      failed
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Push server running on port ${PORT}`);
});
