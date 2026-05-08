import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import admin from "firebase-admin";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}
const db = admin.firestore();

async function updateBookCosts(bookId: string, usage: { promptTokens?: number, outputTokens?: number, imageGenerated?: boolean }) {
  const bookRef = db.collection('buecher').doc(bookId);
  const bookDoc = await bookRef.get();
  
  if (!bookDoc.exists) return;
  
  const currentMetrics = bookDoc.data()?.cost_metrics || {
    text_input_tokens: 0,
    text_output_tokens: 0,
    images_generated: 0,
    total_cost_usd: 0
  };

  const inputTokens = usage.promptTokens || 0;
  const outputTokens = usage.outputTokens || 0;
  
  const newMetrics = {
    text_input_tokens: currentMetrics.text_input_tokens + inputTokens,
    text_output_tokens: currentMetrics.text_output_tokens + outputTokens,
    images_generated: currentMetrics.images_generated + (usage.imageGenerated ? 1 : 0),
  };

  const cost = (newMetrics.text_input_tokens / 1_000_000 * 0.075) + 
               (newMetrics.text_output_tokens / 1_000_000 * 0.30) + 
               (newMetrics.images_generated * 0.01);
  
  newMetrics.total_cost_usd = cost;

  await bookRef.update({ cost_metrics: newMetrics });
}

async function startServer() {
  const app = express();
  app.use(express.json());
  const PORT = process.env.PORT || 3000;

  // Track costs endpoint
  app.post("/api/track-cost", async (req, res) => {
    const { bookId, usage } = req.body;
    await updateBookCosts(bookId, usage);
    res.json({ status: "ok" });
  });

  // API routes FIRST
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
