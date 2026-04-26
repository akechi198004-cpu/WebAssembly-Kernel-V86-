import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import https from "https";

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Add COOP/COEP headers for SharedArrayBuffer and WASM multi-threading
  app.use((req, res, next) => {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    // "credentialless" is used here to ensure that iframes and cross-origin images still load properly in the AI Studio environment while maintaining isolation
    res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
    next();
  });

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
