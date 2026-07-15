import "dotenv/config";
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { analyzeBasketFlow, askFlow, chatFlow, feedbackFlow, historyFlow, messageFlow, sessionFlow, stateFlow, usageFlow } from "./controllers/assistantController.js";
import { isConfigured } from "./services/assistantService.js";
import { authAndUser, isDevOpen } from "./auth.js";

const app = express();
// Baskets are small; images arrive as base64 data URLs, so allow a larger body.
app.use(express.json({ limit: "12mb" }));

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
app.use(express.static(publicDir));

// Health is public (no token, no user) — used for readiness checks and the UI.
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, configured: isConfigured(), provider: process.env.LLM_PROVIDER || "openai-compatible", devOpen: isDevOpen() });
});

// Everything below requires the service token (if configured) and a user_id.
app.use("/api", authAndUser);

app.post("/api/analyze", analyzeBasketFlow);
app.post("/api/ask", askFlow);
app.post("/api/chat", chatFlow);
app.post("/api/message", messageFlow);
app.post("/api/feedback", feedbackFlow);
app.get("/api/state", stateFlow);
app.get("/api/usage", usageFlow);
app.post("/api/session", sessionFlow);
app.get("/api/history", historyFlow);

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Food Assistant (research alpha) on http://localhost:${port}`);
  console.log(
    isDevOpen()
      ? "AUTH: dev-open (no SERVICE_TOKEN) — fine for localhost; set SERVICE_TOKEN before exposing the service."
      : "AUTH: SERVICE_TOKEN required on /api (except /api/health)."
  );
  if (!isConfigured()) {
    console.log("LLM not configured — UI serves, but analysis needs LLM_API_KEY in .env");
  }
});
