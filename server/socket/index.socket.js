import { randomUUID } from "node:crypto";
import { loadQuestionBank } from "../db/question-bank.js";
import { validateGameSettings } from "../lib/game-settings.js";
import { createGameSessions } from "./game-session.js";

const LOBBY_ROOM = "lobby";
const CHAT_COOLDOWN_MS = 3000;
const MAX_MESSAGE_LENGTH = 2000;
const gameRoom = (gameId) => `game:${gameId}`;

function acknowledge(callback, response) {
  if (typeof callback === "function") {
    callback(response);
  }
}

function shuffled(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

// Explicitly list public fields so private match data cannot reach the lobby.
function publicGame(game) {
  return {
    gameId: game.gameId,
    hostId: game.hostId,
    players: game.players.map(({ id, username }) => ({ id, username })),
    started: game.started,
    timeLimit: game.timeLimit,
    numberOfQuestions: game.numberOfQuestions,
    ...(game.startedAt === undefined ? {} : { startedAt: game.startedAt }),
    ...(game.solo === undefined ? {} : { solo: game.solo }),
  };
}

export default function setUpSocket(
  io,
  {
    authenticate,
    store,
    supabase,
    graceMs = 30_000,
    loadQuestions = () => loadQuestionBank(supabase),
  },
) {
  // Membership changes must finish their database writes before the next change.
  let pending = Promise.resolve();
  let stopped = false;
  function enqueue(action) {
    const result = pending.then(action);
    pending = result.catch(() => {});
    return result;
  }

  const socketsByUser = new Map();
  const disconnectDeadlines = new Map();
  const pendingExpirations = new Set();
  const lastMessageTimes = new Map();
  const sessions = createGameSessions({
    emit(userId, update) {
      for (const socket of socketsByUser.get(userId) ?? []) {
        if (socket.rooms.has(gameRoom(update.gameId))) {
          socket.emit("game-update", update);
        }
      }
    },
  });

  function publicGames() {
    return store.list().map(publicGame);
  }

  function findPlayerGame(userId) {
    return store.list().find((game) =>
      game.players.some((player) => player.id === userId),
    );
  }

  function publishGames() {
    io.to(LOBBY_ROOM).emit("games-snapshot", publicGames());
  }

  function publishOnlineUsers() {
    const users = [...socketsByUser].map(([id, sockets]) => ({
      id,
      username: sockets.values().next().value.data.username,
    }));
    io.to(LOBBY_ROOM).emit("online-users", users);
  }

  function gameUpdate(game, userId) {
    return sessions.snapshot(game.gameId, userId) ?? {
      gameId: game.gameId,
      phase: "interrupted",
      serverNow: Date.now(),
      endsAt: null,
      questionIndex: -1,
      totalQuestions: 0,
      submitted: false,
      yourAnswer: null,
      scores: [],
      message:
        "This game was interrupted by a server restart. Leave and create a new game.",
    };
  }

  for (const game of store.list()) {
    for (const player of game.players) {
      disconnectDeadlines.set(player.id, Date.now() + graceMs);
    }
  }

  async function removePlayer(userId) {
    const game = findPlayerGame(userId);
    if (!game) {
      return false;
    }

    const players = game.players.filter((player) => player.id !== userId);
    const nextGame = players.length
      ? {
          ...game,
          players,
          hostId: game.hostId === userId ? players[0].id : game.hostId,
        }
      : null;
    await store.replace(nextGame, game.gameId);

    for (const socket of socketsByUser.get(userId) ?? []) {
      socket.leave(gameRoom(game.gameId));
    }
    sessions.leave(game.gameId, userId);
    disconnectDeadlines.delete(userId);
    publishGames();
    return true;
  }

  const expiryTimer = setInterval(() => {
    for (const [userId, deadline] of disconnectDeadlines) {
      if (deadline > Date.now() || pendingExpirations.has(userId)) {
        continue;
      }

      pendingExpirations.add(userId);
      void enqueue(async () => {
        // Recheck after earlier writes: this player may have reconnected.
        if (
          stopped ||
          socketsByUser.has(userId) ||
          (disconnectDeadlines.get(userId) ?? Infinity) > Date.now()
        ) {
          return;
        }
        await removePlayer(userId);
        if (!socketsByUser.has(userId)) {
          disconnectDeadlines.delete(userId);
          lastMessageTimes.delete(userId);
        }
      })
        .catch((error) => console.error("Unable to expire membership", error))
        .finally(() => pendingExpirations.delete(userId));
    }
  }, Math.min(graceMs, 1000));
  expiryTimer.unref();

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== "string" || !token.trim()) {
        throw new Error("Missing token");
      }
      const user = await authenticate(token);
      if (stopped || typeof user?.id !== "string" || !user.id) {
        throw new Error("Invalid token");
      }

      const username = user.user_metadata?.username;
      socket.data.userId = user.id;
      socket.data.username = user.is_anonymous
        ? `Guest-${user.id.slice(0, 8)}`
        : typeof username === "string" && username.trim()
          ? username.trim().slice(0, 64)
          : `Player-${user.id.slice(0, 8)}`;
      next();
    } catch {
      next(new Error("Authentication failed"));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.data.userId;
    if (!socketsByUser.has(userId)) {
      socketsByUser.set(userId, new Set());
    }
    socketsByUser.get(userId).add(socket);
    disconnectDeadlines.delete(userId);
    socket.emit("socket-identity", { userId, username: socket.data.username });
    publishOnlineUsers();

    // Register each listener once; repeated lobby joins only restore state.
    function handle(event, action, { queued = true } = {}) {
      socket.on(event, (...args) => {
        const callback =
          typeof args.at(-1) === "function" ? args.pop() : undefined;
        const run = async () => {
          if (stopped || !socket.connected) {
            return;
          }
          if (event !== "join-lobby" && !socket.rooms.has(LOBBY_ROOM)) {
            throw new Error("Join the lobby first");
          }
          const data = await action(...args);
          acknowledge(callback, { ok: true, data });
        };

        const result = queued ? enqueue(run) : run();
        void result.catch((error) => {
          acknowledge(callback, {
            ok: false,
            error: error.message || "Request failed",
          });
        });
      });
    }

    function attachToGame(game) {
      for (const userSocket of socketsByUser.get(userId) ?? []) {
        userSocket.join(gameRoom(game.gameId));
      }
    }

    function requireGame(gameId) {
      if (typeof gameId !== "string") {
        throw new Error("Invalid game ID");
      }
      const game = store.list().find((game) => game.gameId === gameId);
      if (!game) {
        throw new Error("Game no longer exists");
      }
      return game;
    }

    function requireMembership(gameId) {
      const game = requireGame(gameId);
      if (
        !game.players.some((player) => player.id === userId) ||
        !socket.rooms.has(gameRoom(gameId))
      ) {
        throw new Error("You are not in this game");
      }
      return game;
    }

    handle("join-lobby", () => {
      socket.join(LOBBY_ROOM);
      store.rememberPlayer?.(userId, socket.data.username);
      publishOnlineUsers();

      const game = findPlayerGame(userId);
      if (game) {
        attachToGame(game);
        publishGames();
        if (game.started) {
          socket.emit("game-update", gameUpdate(game, userId));
        }
      }
      return publicGames();
    });

    handle("open-games", publicGames);

    handle("create-game", async (options) => {
      validateGameSettings(options ?? {});
      const existing = findPlayerGame(userId);
      if (existing) {
        attachToGame(existing);
        return publicGame(existing);
      }

      const game = {
        gameId: randomUUID(),
        hostId: userId,
        players: [{ id: userId, username: socket.data.username }],
        started: false,
        timeLimit: options.timeLimit,
        numberOfQuestions: options.numberOfQuestions,
      };
      await store.replace(game, game.gameId);
      attachToGame(game);
      publishGames();
      return publicGame(game);
    });

    handle("join-game", async (gameId) => {
      const game = requireGame(gameId);
      const existing = findPlayerGame(userId);
      if (existing && existing.gameId !== gameId) {
        throw new Error("Leave your current game first");
      }
      if (!existing) {
        if (game.started) {
          throw new Error("Game already started");
        }
        game.players.push({ id: userId, username: socket.data.username });
        await store.replace(game, gameId);
      }
      attachToGame(game);
      publishGames();
      return publicGame(game);
    });

    handle("start-game", async (gameId) => {
      const game = requireMembership(gameId);
      if (game.hostId !== userId) {
        throw new Error("Only the host can start this game");
      }
      if (game.started) {
        return true;
      }

      validateGameSettings(game);
      const bank = await loadQuestions();
      if (stopped) {
        return false;
      }
      if (bank.length < game.numberOfQuestions) {
        throw new Error("Not enough questions available to start this game.");
      }

      const questions = shuffled(bank).slice(0, game.numberOfQuestions);
      await store.replace(
        {
          ...game,
          started: true,
          startedAt: Date.now(),
          solo: game.players.length === 1,
        },
        gameId,
      );
      if (stopped) {
        return false;
      }
      publishGames();
      sessions.start(game, questions);
      return true;
    });

    // Answer deadlines must not wait for another game's database requests.
    handle(
      "submit-answer",
      (gameId, index, choice) => {
        requireMembership(gameId);
        return sessions.submit(gameId, userId, index, choice);
      },
      { queued: false },
    );

    handle("leave-game", (gameId) => {
      requireMembership(gameId);
      return removePlayer(userId);
    });

    function sendMessage(target, text, gameId = null) {
      if (
        typeof text !== "string" ||
        !text.trim() ||
        text.length > MAX_MESSAGE_LENGTH
      ) {
        throw new Error("Messages must contain 1-2000 characters");
      }

      const now = Date.now();
      const lastMessageAt = lastMessageTimes.get(userId) ?? -Infinity;
      if (now - lastMessageAt < CHAT_COOLDOWN_MS) {
        throw new Error("Message cooldown active");
      }
      lastMessageTimes.set(userId, now);
      io.to(target).emit("chat-message", {
        id: randomUUID(),
        userId,
        username: socket.data.username,
        text: text.trim(),
        gameId,
      });
      return true;
    }

    handle("lobby-message", (text) => sendMessage(LOBBY_ROOM, text));
    handle("game-message", (gameId, text) => {
      requireMembership(gameId);
      return sendMessage(gameRoom(gameId), text, gameId);
    });

    socket.on("disconnect", () => {
      const activeSockets = socketsByUser.get(userId);
      activeSockets?.delete(socket);
      if (!activeSockets?.size) {
        socketsByUser.delete(userId);
        disconnectDeadlines.set(userId, Date.now() + graceMs);
        publishOnlineUsers();
      }
    });
  });

  return () => {
    stopped = true;
    clearInterval(expiryTimer);
    sessions.stop();
  };
}
