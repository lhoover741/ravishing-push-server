import Module from "module";
import { mountGalleryRoutes } from "./gallery.js";

const originalLoad = Module._load;
let capturedApp = null;
let capturedPool = null;
let mounted = false;

function tryMountGallery() {
  if (mounted || !capturedApp || !capturedPool) return;
  mounted = true;
  setTimeout(() => {
    mountGalleryRoutes(capturedApp, capturedPool, { adminToken: process.env.ADMIN_TOKEN || "admin-authenticated" })
      .then(() => console.log("Ravishing Beauté gallery routes ready."))
      .catch((error) => console.error("Gallery routes failed:", error));
  }, 0);
}

Module._load = function patchedModuleLoad(request, parent, isMain) {
  const loaded = originalLoad.apply(this, arguments);

  if (request === "express" && typeof loaded === "function") {
    function wrappedExpress(...args) {
      capturedApp = loaded(...args);
      tryMountGallery();
      return capturedApp;
    }
    Object.assign(wrappedExpress, loaded);
    return wrappedExpress;
  }

  if (request === "pg" && loaded && typeof loaded.Pool === "function") {
    class GalleryPool extends loaded.Pool {
      constructor(...args) {
        super(...args);
        capturedPool = this;
        tryMountGallery();
      }
    }
    return { ...loaded, Pool: GalleryPool };
  }

  return loaded;
};
