const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function boolValue(value, fallback = false) {
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return fallback;
}

function intValue(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function requireGalleryAdmin(adminToken) {
  return (req, res, next) => {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== adminToken) return res.status(401).json({ error: "Unauthorized" });
    next();
  };
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES) {
        reject(new Error("Image is too large. Please upload an image under 6 MB."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function mapGalleryRow(row, req) {
  return {
    id: Number(row.id),
    imageUrl: `${req.protocol}://${req.get("host")}/gallery/image/${row.id}`,
    caption: row.caption || "",
    category: row.category || "Style",
    featured: Boolean(row.featured),
    visible: Boolean(row.visible),
    sortOrder: Number(row.sort_order || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function mountGalleryRoutes(app, pool, options = {}) {
  const adminToken = options.adminToken || process.env.ADMIN_TOKEN || "admin-authenticated";
  const adminOnly = requireGalleryAdmin(adminToken);

  await pool.query(`CREATE TABLE IF NOT EXISTS gallery_images (
    id BIGSERIAL PRIMARY KEY,
    image_data BYTEA NOT NULL,
    file_name TEXT,
    content_type TEXT NOT NULL,
    caption TEXT DEFAULT '',
    category TEXT DEFAULT 'Style',
    featured BOOLEAN DEFAULT FALSE,
    visible BOOLEAN DEFAULT TRUE,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  )`);

  app.get("/gallery", async (req, res) => {
    try {
      const result = await pool.query("SELECT id, file_name, content_type, caption, category, featured, visible, sort_order, created_at, updated_at FROM gallery_images WHERE visible = TRUE ORDER BY featured DESC, sort_order ASC, created_at DESC");
      res.json(result.rows.map((row) => mapGalleryRow(row, req)));
    } catch (error) {
      console.error("Gallery list failed:", error.message);
      res.status(500).json({ error: "Failed to fetch gallery" });
    }
  });

  app.get("/admin/gallery", adminOnly, async (req, res) => {
    try {
      const result = await pool.query("SELECT id, file_name, content_type, caption, category, featured, visible, sort_order, created_at, updated_at FROM gallery_images ORDER BY sort_order ASC, created_at DESC");
      res.json(result.rows.map((row) => mapGalleryRow(row, req)));
    } catch (error) {
      console.error("Admin gallery list failed:", error.message);
      res.status(500).json({ error: "Failed to fetch admin gallery" });
    }
  });

  app.get("/gallery/image/:id", async (req, res) => {
    try {
      const result = await pool.query("SELECT image_data, content_type FROM gallery_images WHERE id = $1 AND visible = TRUE", [Number(req.params.id)]);
      if (!result.rows.length) return res.status(404).json({ error: "Image not found" });
      const row = result.rows[0];
      res.setHeader("Content-Type", row.content_type || "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.send(row.image_data);
    } catch (error) {
      console.error("Gallery image load failed:", error.message);
      res.status(500).json({ error: "Failed to load image" });
    }
  });

  app.get("/admin/gallery/image/:id", adminOnly, async (req, res) => {
    try {
      const result = await pool.query("SELECT image_data, content_type FROM gallery_images WHERE id = $1", [Number(req.params.id)]);
      if (!result.rows.length) return res.status(404).json({ error: "Image not found" });
      const row = result.rows[0];
      res.setHeader("Content-Type", row.content_type || "image/jpeg");
      res.setHeader("Cache-Control", "no-store");
      res.send(row.image_data);
    } catch (error) {
      res.status(500).json({ error: "Failed to load admin image" });
    }
  });

  app.post("/admin/gallery", adminOnly, async (req, res) => {
    try {
      const contentType = cleanString(req.headers["content-type"]).split(";")[0].toLowerCase();
      if (!ALLOWED_TYPES.has(contentType)) return res.status(400).json({ error: "Only JPG, PNG, and WebP images are supported." });
      const imageData = await readRawBody(req);
      if (!imageData.length) return res.status(400).json({ error: "Image file is required." });

      const caption = cleanString(req.query.caption);
      const category = cleanString(req.query.category) || "Style";
      const featured = boolValue(req.query.featured, false);
      const visible = boolValue(req.query.visible, true);
      const sortOrder = intValue(req.query.sortOrder, 0);
      const fileName = cleanString(req.headers["x-file-name"]) || "gallery-image";

      const inserted = await pool.query(
        `INSERT INTO gallery_images (image_data, file_name, content_type, caption, category, featured, visible, sort_order, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) RETURNING id, file_name, content_type, caption, category, featured, visible, sort_order, created_at, updated_at`,
        [imageData, fileName, contentType, caption, category, featured, visible, sortOrder]
      );
      res.status(201).json(mapGalleryRow(inserted.rows[0], req));
    } catch (error) {
      console.error("Gallery upload failed:", error.message);
      res.status(500).json({ error: error.message || "Failed to upload gallery image" });
    }
  });

  app.patch("/admin/gallery/:id", adminOnly, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid image id" });
      const body = req.body || {};
      const caption = typeof body.caption === "string" ? body.caption.trim() : null;
      const category = typeof body.category === "string" ? body.category.trim() || "Style" : null;
      const featured = typeof body.featured === "boolean" ? body.featured : null;
      const visible = typeof body.visible === "boolean" ? body.visible : null;
      const sortOrder = Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : null;

      const updated = await pool.query(
        `UPDATE gallery_images SET
          caption = COALESCE($2, caption),
          category = COALESCE($3, category),
          featured = COALESCE($4, featured),
          visible = COALESCE($5, visible),
          sort_order = COALESCE($6, sort_order),
          updated_at = NOW()
         WHERE id = $1
         RETURNING id, file_name, content_type, caption, category, featured, visible, sort_order, created_at, updated_at`,
        [id, caption, category, featured, visible, sortOrder]
      );
      if (!updated.rows.length) return res.status(404).json({ error: "Image not found" });
      res.json(mapGalleryRow(updated.rows[0], req));
    } catch (error) {
      console.error("Gallery update failed:", error.message);
      res.status(500).json({ error: "Failed to update gallery image" });
    }
  });

  app.delete("/admin/gallery/:id", adminOnly, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid image id" });
      const hard = boolValue(req.query.hard, false);
      if (hard) {
        await pool.query("DELETE FROM gallery_images WHERE id = $1", [id]);
        return res.json({ ok: true, deleted: true });
      }
      const updated = await pool.query(
        "UPDATE gallery_images SET visible = FALSE, updated_at = NOW() WHERE id = $1 RETURNING id, file_name, content_type, caption, category, featured, visible, sort_order, created_at, updated_at",
        [id]
      );
      if (!updated.rows.length) return res.status(404).json({ error: "Image not found" });
      res.json(mapGalleryRow(updated.rows[0], req));
    } catch (error) {
      console.error("Gallery delete failed:", error.message);
      res.status(500).json({ error: "Failed to remove gallery image" });
    }
  });
}
