import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import dotenv from "dotenv";
import setUpSocket from "./socket/index.socket.js";
import apiRoutes from "./routes/api.routes.js";
import { supabase } from "./lib/supabase.js";
import { createGameStore } from "./db/game-store.js";
dotenv.config();

const frontendUrlSetting =
  process.env.NODE_ENV === "production"
    ? "FRONTEND_URL_PRODUCTION"
    : "FRONTEND_URL_DEVELOPMENT";
const frontendUrl = process.env[frontendUrlSetting];
if (!frontendUrl) {
  throw new Error(`Missing required environment variable: ${frontendUrlSetting}`);
}

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: frontendUrl,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.use(express.json());
app.use(cors({ origin: frontendUrl, credentials: true }));

app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

app.use("/api", apiRoutes);

const store = await createGameStore(supabase, {
  timeLimit: Number(process.env.GAME_TIME_LIMIT_SECONDS ?? 30),
  numberOfQuestions: Number(process.env.GAME_NUMBER_OF_QUESTIONS ?? 5),
});
const stopSockets = setUpSocket(io, {
  store,
  supabase,
  authenticate: async (token) => {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error) throw error;
    return user;
  },
});
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  stopSockets();
  io.close();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
server.on("error", (error) => {
  console.error(error);
  shutdown();
  process.exitCode = 1;
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Server listening on port ${server.address().port}`);
});
