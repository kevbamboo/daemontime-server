import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { io as client } from "socket.io-client";
import { once } from "node:events";
import setUpSocket from "../socket/index.socket.js";
import { loadQuestionBank } from "../db/question-bank.js";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const request = (socket, event, ...args) =>
  socket.timeout(2000).emitWithAck(event, ...args);

test("a game started alone is solo and can be left during countdown", async (t) => {
  const { connect } = await fixture(t);
  const host = await connect("host");
  const { data: game } = await request(host, "create-game", { timeLimit: 5, numberOfQuestions: 5 });
  const update = once(host, "game-update");
  assert.equal((await request(host, "start-game", game.gameId)).ok, true);
  assert.equal((await update)[0].phase, "countdown");
  const { data: games } = await request(host, "open-games");
  assert.equal(games[0].solo, true);
  assert.equal((await request(host, "leave-game", game.gameId)).ok, true);
  assert.deepEqual((await request(host, "open-games")).data, []);
  assert.equal((await request(host, "submit-answer", game.gameId, 0, 1)).ok, false);
});
test(
  "full match sends private questions, records submissions, reconnects, and ends in review",
  { timeout: 25000 },
  async (t) => {
    const { connect } = await fixture(t);
    const host = await connect("host");
    const player = await connect("player");
    const outsider = await connect("outsider");
    const { data: game } = await request(host, "create-game", {
      timeLimit: 5,
      numberOfQuestions: 5,
    });
    await request(player, "join-game", game.gameId);
    const hostUpdates = [];
    const playerUpdates = [];
    host.on("game-update", (update) => hostUpdates.push(update));
    player.on("game-update", (update) => playerUpdates.push(update));
    async function until(predicate) {
      const deadline = Date.now() + 4500;
      while (!predicate()) {
        if (Date.now() > deadline)
          throw new Error("Timed out waiting for game update");
        await delay(10);
      }
    }
    assert.equal((await request(host, "start-game", game.gameId)).ok, true);
    const seen = new Set();
    for (let index = 0; index < 5; index++) {
      await until(
        () =>
          hostUpdates.at(-1)?.phase === "question" &&
          hostUpdates.at(-1)?.questionIndex === index,
      );
      const update = hostUpdates.at(-1);
      assert.equal(update.review, undefined);
      assert.equal(update.question.correctAnswer, undefined);
      seen.add(update.question.text);
      assert.equal(
        (await request(outsider, "submit-answer", game.gameId, index, 1)).ok,
        false,
      );
      assert.equal(
        (await request(host, "submit-answer", game.gameId, index, 1)).ok,
        true,
      );
      assert.equal(hostUpdates.at(-1).submitted, true);
      assert.equal(hostUpdates.at(-1).phase, "question");
      assert.equal(
        (await request(host, "submit-answer", game.gameId, index, 1)).ok,
        false,
      );
      const restored = once(host, "game-update");
      await request(host, "join-lobby");
      assert.equal((await restored)[0].yourAnswer, 1);
      assert.equal(
        (await request(player, "submit-answer", game.gameId, index, 2)).ok,
        true,
      );
      await until(() => hostUpdates.at(-1)?.phase === "scoreboard");
    }
    await until(() => hostUpdates.at(-1)?.phase === "finished");
    await until(() => playerUpdates.at(-1)?.phase === "finished");
    assert.equal(seen.size, 5);
    assert.equal(hostUpdates.at(-1).review.length, 5);
    assert.ok(
      hostUpdates
        .at(-1)
        .review.every((q) => q.yourAnswer === 1 && q.correctAnswer === 1),
    );
    assert.ok(playerUpdates.at(-1).review.every((q) => q.yourAnswer === 2));
    assert.equal(
      hostUpdates.at(-1).scores.find((p) => p.id === "host").score,
      10,
    );
    assert.equal(
      playerUpdates.at(-1).scores.find((p) => p.id === "player").score,
      0,
    );
    const { data: lobby } = await request(outsider, "open-games");
    assert.equal(lobby[0].questions, undefined);
    assert.equal(lobby[0].answers, undefined);
  },
);

test("question loader reads every page and normalizes numeric answer strings", async () => {
  const row = {
    question: "Example",
    choices: ["a", "b", "c", "d"],
    answer: "1",
  };
  const offsets = [];
  const supabase = {
    from(table) {
      assert.equal(table, "questions");
      return {
        select(columns) {
          assert.equal(
            columns,
            "question,choices,answer,short_explanation,long_explanation",
          );
          return this;
        },
        order() {
          return this;
        },
        range(start) {
          offsets.push(start);
          this.start = start;
          return this;
        },
        async abortSignal() {
          return {
            data: Array.from(
              { length: this.start === 0 ? 1000 : 1 },
              () => row,
            ),
            error: null,
          };
        },
      };
    },
  };
  const bank = await loadQuestionBank(supabase);
  assert.equal(bank.length, 1001);
  assert.deepEqual(offsets, [0, 1000]);
  assert.equal(bank[0].correctAnswer, 1);
  await assert.rejects(loadQuestionBank(null), /not configured/);
});
test(
  "game updates reach host and players, exclude observers, and restore on reconnect",
  { timeout: 5000 },
  async (t) => {
    const { connect } = await fixture(t);
    const host = await connect("host");
    const player = await connect("player");
    const observer = await connect("observer");
    const observed = [];
    observer.on("game-update", (update) => observed.push(update));
    const { data: game } = await request(host, "create-game", {
      timeLimit: 30,
      numberOfQuestions: 5,
    });
    await request(player, "join-game", game.gameId);
    const hostUpdate = once(host, "game-update");
    const playerUpdate = once(player, "game-update");
    assert.equal((await request(host, "start-game", game.gameId)).ok, true);
    const [update] = await hostUpdate;
    assert.equal(update.gameId, game.gameId);
    assert.equal(update.phase, "countdown");
    const [otherUpdate] = await playerUpdate;
    assert.equal(otherUpdate.phase, update.phase);
    assert.equal(otherUpdate.endsAt, update.endsAt);
    player.disconnect();
    const restored = await connect("player", false);
    const restoredUpdate = once(restored, "game-update");
    await request(restored, "join-lobby");
    const [reconnected] = await restoredUpdate;
    assert.equal(reconnected.phase, update.phase);
    assert.equal(reconnected.endsAt, update.endsAt);
    await request(observer, "open-games");
    assert.deepEqual(observed, []);
  },
);
async function fixture(t, overrides = {}) {
  const http = createServer();
  const io = new Server(http);
  const records = new Map();
  const store = {
    list() {
      return structuredClone([...records.values()]);
    },
    async replace(game, id) {
      await delay(5); // Exercise real async boundaries between competing requests.
      if (game) records.set(id, structuredClone(game));
      else records.delete(id);
    },
  };
  const stop = setUpSocket(io, {
    store,
    graceMs: 80,
    loadQuestions: async () =>
      Array.from({ length: 99 }, (_, index) => ({
        text: `Question ${index}`,
        choices: ["One", "Two", "Three", "Four"],
        correctAnswer: 1,
        shortExplanation: "Short",
        longExplanation: "Long",
      })),
    authenticate: async (token) => {
      if (token === "invalid") throw new Error("Invalid token");
      return { id: token, user_metadata: { username: "same-name" } };
    },
    ...overrides,
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const sockets = [];
  t.after(async () => {
    stop();
    for (const s of sockets) s.disconnect();
    await new Promise((resolve) => io.close(resolve));
  });
  async function connect(id, lobby = true) {
    const s = client(`http://127.0.0.1:${http.address().port}`, {
      auth: { token: id },
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });
    sockets.push(s);
    await new Promise((resolve, reject) => {
      s.once("connect", resolve);
      s.once("connect_error", reject);
    });
    if (lobby) assert.equal((await request(s, "join-lobby")).ok, true);
    return s;
  }
  return { connect, store, io, stop };
}
test("identity authorizes host, lobby is idempotent, and membership is singular", async (t) => {
  const { connect, store } = await fixture(t);
  const a = await connect("account-a");
  const b = await connect("account-b");
  await request(a, "join-lobby");
  await request(a, "join-lobby");
  const first = await request(a, "create-game", {
    timeLimit: 30,
    numberOfQuestions: 5,
  });
  assert.equal(store.list().length, 1);
  assert.equal(
    (await request(a, "create-game", { timeLimit: 30, numberOfQuestions: 5 }))
      .data.gameId,
    first.data.gameId,
  );
  assert.equal((await request(b, "start-game", first.data.gameId)).ok, false);
  const second = await request(b, "create-game", {
    timeLimit: 30,
    numberOfQuestions: 5,
  });
  assert.equal((await request(a, "join-game", second.data.gameId)).ok, false);
  assert.equal((await request(a, "start-game", first.data.gameId)).ok, true);
  assert.equal((await request(a, "start-game", first.data.gameId)).ok, true);
  assert.equal(store.list().length, 2);
});
test("malformed events and missing acknowledgments do not break later requests", async (t) => {
  const { connect } = await fixture(t);
  const a = await connect("a", false);
  assert.equal(
    (await request(a, "create-game", { timeLimit: 30, numberOfQuestions: 5 }))
      .ok,
    false,
  );
  a.emit("join-lobby");
  a.emit("create-game", { timeLimit: 30, numberOfQuestions: 5 });
  a.emit("start-game", {});
  a.emit("lobby-message", {});
  assert.equal((await request(a, "join-game", {})).ok, false);
  assert.equal((await request(a, "open-games")).data.length, 1);
});
test("lobby observers get membership and host snapshots; chat verifies membership and identity", async (t) => {
  const { connect } = await fixture(t);
  const a = await connect("a");
  const b = await connect("b");
  const observer = await connect("observer");
  const created = once(observer, "games-snapshot");
  const { data: game } = await request(a, "create-game", {
    timeLimit: 30,
    numberOfQuestions: 5,
  });
  await created;
  const changed = once(observer, "games-snapshot");
  await request(b, "join-game", game.gameId);
  assert.equal((await changed)[0][0].players.length, 2);
  assert.equal(
    (await request(observer, "game-message", game.gameId, "intrusion")).ok,
    false,
  );
  const chat = once(b, "chat-message");
  assert.equal(
    (await request(a, "game-message", game.gameId, "hello")).ok,
    true,
  );
  assert.equal((await chat)[0].userId, "a");
  const transfer = once(observer, "games-snapshot");
  await request(a, "leave-game", game.gameId);
  assert.equal((await transfer)[0][0].hostId, "b");
});
test("reconnect restores membership; final disconnect expires and transfers host", async (t) => {
  const { connect, store } = await fixture(t);
  const a = await connect("a");
  const b = await connect("b");
  const { data: game } = await request(a, "create-game", {
    timeLimit: 30,
    numberOfQuestions: 5,
  });
  await request(b, "join-game", game.gameId);
  a.disconnect();
  const restored = await connect("a");
  assert.equal(
    (await request(restored, "open-games")).data[0].players.length,
    2,
  );
  assert.equal((await request(restored, "start-game", game.gameId)).ok, true);
  const anotherTab = await connect("a");
  restored.disconnect();
  await delay(200);
  assert.equal(store.list()[0].hostId, "a");
  anotherTab.disconnect();
  await delay(200);
  assert.equal(store.list()[0].hostId, "b");
  b.disconnect();
  await delay(200);
  assert.equal(store.list().length, 0);
});
test("concurrent creates and joins preserve singular membership and all players", async (t) => {
  const { connect, store } = await fixture(t);
  const a = await connect("a");
  const b = await connect("b");
  const c = await connect("c");
  const [first, second] = await Promise.all([
    request(a, "create-game", { timeLimit: 30, numberOfQuestions: 5 }),
    request(a, "create-game", { timeLimit: 30, numberOfQuestions: 5 }),
  ]);
  assert.equal(first.data.gameId, second.data.gameId);
  assert.equal(store.list().length, 1);
  const joined = await Promise.all([
    request(b, "join-game", first.data.gameId),
    request(c, "join-game", first.data.gameId),
  ]);
  assert.ok(joined.every((reply) => reply.ok));
  assert.equal(store.list()[0].players.length, 3);
});
test("failed asynchronous writes return an error and do not poison the action queue", async (t) => {
  const { connect, store } = await fixture(t);
  const a = await connect("a");
  const replace = store.replace;
  store.replace = async () => {
    throw new Error("Database unavailable");
  };
  const result = await request(a, "create-game", {
    timeLimit: 30,
    numberOfQuestions: 5,
  });
  assert.equal(result.ok, false);
  assert.equal(store.list().length, 0);
  store.replace = replace;
  assert.equal(
    (await request(a, "create-game", { timeLimit: 30, numberOfQuestions: 5 }))
      .ok,
    true,
  );
});

test("game settings accept both boundaries and reject invalid requests without creating a game", async (t) => {
  const { connect, store } = await fixture(t);
  const a = await connect("a");
  for (const options of [
    undefined,
    {},
    { timeLimit: 4, numberOfQuestions: 5 },
    { timeLimit: 100, numberOfQuestions: 5 },
    { timeLimit: 5, numberOfQuestions: 4 },
    { timeLimit: 5, numberOfQuestions: 100 },
    { timeLimit: 5.5, numberOfQuestions: 5 },
    { timeLimit: 5, numberOfQuestions: 5.5 },
    { timeLimit: "30", numberOfQuestions: 5 },
  ]) {
    assert.equal((await request(a, "create-game", options)).ok, false);
  }
  assert.equal(store.list().length, 0);
  for (const value of [5, 99]) {
    const result = await request(a, "create-game", {
      timeLimit: value,
      numberOfQuestions: value,
    });
    assert.equal(result.ok, true);
    assert.equal(result.data.timeLimit, value);
    assert.equal(result.data.numberOfQuestions, value);
    assert.equal(store.list()[0].timeLimit, value);
    await request(a, "leave-game", result.data.gameId);
  }
});

test("answers are accepted while another game's database write is pending", { timeout: 8000 }, async (t) => {
  const { connect, store } = await fixture(t);
  const host = await connect("host");
  const other = await connect("other");
  const { data: game } = await request(host, "create-game", {
    timeLimit: 5,
    numberOfQuestions: 5,
  });
  const question = new Promise((resolve) => {
    host.on("game-update", (update) => {
      if (update.phase === "question") resolve(update);
    });
  });
  await request(host, "start-game", game.gameId);
  const update = await question;

  const writeStarted = Promise.withResolvers();
  const releaseWrite = Promise.withResolvers();
  const replace = store.replace;
  store.replace = async (...args) => {
    writeStarted.resolve();
    await releaseWrite.promise;
    return replace(...args);
  };
  const creating = request(other, "create-game", {
    timeLimit: 5,
    numberOfQuestions: 5,
  });
  await writeStarted.promise;
  try {
    const answer = await host.timeout(1000).emitWithAck(
      "submit-answer", game.gameId, update.questionIndex, 1,
    );
    assert.equal(answer.ok, true);
  } finally {
    releaseWrite.resolve();
    await creating;
  }
});

test("chat cooldown is shared across tabs and survives reconnects", async (t) => {
  const { connect } = await fixture(t, { graceMs: 1000 });
  const firstTab = await connect("account");
  const secondTab = await connect("account");
  assert.equal((await request(firstTab, "lobby-message", "first")).ok, true);
  const second = await request(secondTab, "lobby-message", "too soon");
  assert.equal(second.ok, false);
  assert.match(second.error, /cooldown/);

  firstTab.disconnect();
  secondTab.disconnect();
  const restored = await connect("account");
  assert.equal(
    (await request(restored, "lobby-message", "still too soon")).ok,
    false,
  );
  const other = await connect("another-account");
  assert.equal((await request(other, "lobby-message", "hello")).ok, true);
});

test("lobby snapshots expose only public game and player fields", async (t) => {
  const { connect, store } = await fixture(t);
  const host = await connect("host");
  const { data: game } = await request(host, "create-game", {
    timeLimit: 5,
    numberOfQuestions: 5,
  });
  await store.replace(
    {
      ...game,
      questions: [{ correctAnswer: 1 }],
      answers: { host: 1 },
      players: game.players.map((player) => ({ ...player, token: "private" })),
    },
    game.gameId,
  );
  assert.deepEqual((await request(host, "open-games")).data, [game]);
});

test("shutdown during a pending start does not create a new session", async (t) => {
  const { connect, store, stop } = await fixture(t);
  const host = await connect("host");
  const { data: game } = await request(host, "create-game", {
    timeLimit: 5,
    numberOfQuestions: 5,
  });
  const updates = [];
  host.on("game-update", (update) => updates.push(update));
  const writeStarted = Promise.withResolvers();
  const releaseWrite = Promise.withResolvers();
  const replace = store.replace;
  store.replace = async (...args) => {
    writeStarted.resolve();
    await releaseWrite.promise;
    return replace(...args);
  };

  const starting = request(host, "start-game", game.gameId);
  await writeStarted.promise;
  stop();
  releaseWrite.resolve();
  assert.equal((await starting).data, false);
  assert.deepEqual(updates, []);
});

test("missing and invalid tokens cannot connect", async (t) => {
  const { connect } = await fixture(t);
  for (const token of [undefined, "", "invalid"]) {
    await assert.rejects(connect(token), /Authentication failed/);
  }
});
