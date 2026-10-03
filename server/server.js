import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server } from "socket.io";
import setUpSocket from "./socket/index.socket.js";
import apiRoutes from "./routes/api.routes.js";
import { supabase } from "./lib/supabase.js";
import { createGameStore } from "./db/game-store.js";
import { readServerConfig } from "./lib/config.js";

const { frontendUrl, port, gameSettings } = readServerConfig();
const store = await createGameStore(supabase, gameSettings);
const app = express();
const server = createServer(app);

const io = new Server(server, {
  cors: {
    origin: frontendUrl,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.use(cors({ origin: frontendUrl, credentials: true }));
app.use("/api", apiRoutes);

const stopSockets = setUpSocket(io, {
  store,
  supabase,
  authenticate: async (token) => {
    const { data, error } = await supabase.auth.getUser(token);
    if (error) {
      throw error;
    }
    return data.user;
  },
});

let closing = false;
function shutdown() {
  if (closing) {
    return;
  }
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

server.listen(port, "127.0.0.1", () => {
  console.log(`Server listening on port ${server.address().port}`);
});
