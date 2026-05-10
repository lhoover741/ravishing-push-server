import express from "express";
import pkg from "pg";
import { mountGalleryRoutes } from "./gallery.js";

const { Pool } = pkg;
const originalListen = express.application.listen;
let mounted = false;

function createGalleryPool() {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  });
}

express.application.listen = function patchedListen(...args) {
  if (!mounted) {
    mounted = true;
    const galleryPool = createGalleryPool();
    void mountGalleryRoutes(this, galleryPool, {
      adminToken: process.env.ADMIN_TOKEN || "admin-authenticated",
    })
      .then(() => console.log("Ravishing Beauté gallery routes ready."))
      .catch((error) => console.error("Gallery routes failed:", error));
  }

  return originalListen.apply(this, args);
};
