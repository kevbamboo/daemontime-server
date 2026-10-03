// Optional cross-project checks: npm run test:client requires client dependencies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
const clientRequire = createRequire(
  new URL("../../client/package.json", import.meta.url),
);
const ts = clientRequire("typescript");
const source = readFileSync(
  new URL("../../client/src/services/socket.service.ts", import.meta.url),
  "utf8",
).replace("import.meta.env.VITE_SOCKET_URL", "undefined");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  },
}).outputText;
const flush = () => new Promise((resolve) => setImmediate(resolve));
function fixture() {
  const sockets = [];
  const exports = {};
  let games = [];
  function io(_url, options) {
    const listeners = new Map();
    const socket = {
      auth: options.auth,
      connected: false,
      requests: [],
      on(event, fn) {
        const list = listeners.get(event) ?? [];
        list.push(fn);
        listeners.set(event, list);
      },
      fire(event, ...args) {
        for (const fn of listeners.get(event) ?? []) fn(...args);
      },
      connect() {
        this.connected = true;
        this.fire("connect");
      },
      disconnect() {
        this.connected = false;
        this.fire("disconnect");
      },
      removeAllListeners() {
        listeners.clear();
      },
      timeout() {
        return this;
      },
      emit(event, ...args) {
        this.requests.push(event);
        args.at(-1)(null, { ok: true, data: games });
      },
      listenerCount(event) {
        return listeners.get(event)?.length ?? 0;
      },
    };
    sockets.push(socket);
    return socket;
  }
  vm.runInNewContext(compiled, {
    exports,
    require: () => ({ io }),
    window: { location: { origin: "http://test" } },
    setTimeout,
    clearTimeout,
  });
  return {
    service: exports.socketService,
    sockets,
    setGames(value) {
      games = value;
    },
  };
}
test("client refreshes handshake token, restores lobby on reconnect, and registers chat once", async () => {
  const { service, sockets } = fixture();
  service.connect("old-token", "user");
  await flush();
  assert.equal(service.ready, true);
  service.connect("fresh-token", "user");
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].auth.token, "fresh-token");
  sockets[0].disconnect();
  assert.equal(service.ready, false);
  sockets[0].connect();
  await flush();
  assert.equal(service.ready, true);
  assert.equal(
    sockets[0].requests.filter((event) => event === "join-lobby").length,
    2,
  );
  assert.equal(sockets[0].listenerCount("chat-message"), 1);
});
test("client derives host from account ID and clears messages on leave/logout", async () => {
  const { service, sockets, setGames } = fixture();
  setGames([
    {
      gameId: "game",
      hostId: "other",
      players: [
        { id: "user", username: "same" },
        { id: "other", username: "same" },
      ],
      started: false,
    },
  ]);
  service.connect("token", "user");
  await flush();
  assert.equal(service.currentGameId, "game");
  assert.equal(service.isCurrentGameHost, false);
  sockets[0].fire("chat-message", {
    id: "message",
    gameId: "game",
    text: "hello",
  });
  assert.equal(service.gameMessages.length, 1);
  sockets[0].fire("games-snapshot", []);
  assert.equal(service.currentGameId, "");
  assert.equal(service.gameMessages.length, 0);
  sockets[0].fire("chat-message", { id: "lobby", gameId: null, text: "hello" });
  service.disconnect();
  assert.equal(service.lobbyMessages.length, 0);
  assert.equal(service.userId, "");
  await assert.rejects(service.createGame(), /Not connected/);
});

test("client delivers game updates only for current membership and clears them on leave", async () => {
  const { service, sockets, setGames } = fixture();
  setGames([
    {
      gameId: "game",
      hostId: "user",
      players: [{ id: "user", username: "User" }],
      started: true,
    },
  ]);
  service.connect("token", "user");
  await flush();
  const updates = [];
  const off = service.subscribeToGameUpdates((update) => updates.push(update));
  sockets[0].fire("game-update", { gameId: "other", phase: "question" });
  assert.equal(updates.length, 1);
  sockets[0].fire("game-update", {
    gameId: "game",
    phase: "question",
    submitted: true,
  });
  assert.equal(updates.at(-1).submitted, true);
  assert.equal(typeof updates.at(-1).receivedAt, "number");
  sockets[0].fire("games-snapshot", []);
  assert.equal(updates.at(-1), null);
  off();
  service.disconnect();
  assert.equal(sockets[0].listenerCount("game-update"), 0);
});
