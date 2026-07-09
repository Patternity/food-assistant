import "dotenv/config";
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { analyzeBasketFlow, askFlow, chatFlow, feedbackFlow, historyFlow, stateFlow } from "./controllers/assistantController.js";
import { isConfigured } from "./services/assistantService.js";

const app = express();
// Baskets are small; images arrive as base64 data URLs, so allow a larger body.
app.use(express.json({ limit: "12mb" }));

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
app.use(express.static(publicDir));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, configured: isConfigured(), provider: process.env.LLM_PROVIDER || "openai-compatible" });
});

app.post("/api/analyze", analyzeBasketFlow);
app.post("/api/ask", askFlow);
app.post("/api/chat", chatFlow);
app.post("/api/feedback", feedbackFlow);
app.get("/api/state", stateFlow);
app.get("/api/history", historyFlow);

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Food Assistant (research alpha) on http://localhost:${port}`);
  if (!isConfigured()) {
    console.log("LLM not configured — UI serves, but analysis needs LLM_API_KEY in .env");
  }
});
