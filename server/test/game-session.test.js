import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createGameSessions,
  normalizeQuestion,
} from "../socket/game-session.js";

function fixture(count = 2, playerCount = 2) {
  let clock = 0;
  let nextId = 0;
  const timers = new Map();
  const updates = [];
  const sessions = createGameSessions({
    emit: (userId, update) => updates.push({ userId, update }),
    now: () => clock,
    schedule(fn, ms) {
      const id = ++nextId;
      timers.set(id, { at: clock + ms, fn });
      return id;
    },
    cancel: (id) => timers.delete(id),
  });
  const questions = Array.from({ length: count }, (_, index) =>
    normalizeQuestion({
      question: `Question ${index}`,
      choices: ["a", "b", "c", "d"],
      answer: "2",
      short_explanation: "Short",
      long_explanation: "Long",
    }),
  );
  sessions.start(
    {
      gameId: "game",
      timeLimit: 5,
      players: ["a", "b", "c"].slice(0, playerCount).map((id) => ({
        id,
        username: id.toUpperCase(),
      })),
    },
    questions,
  );
  return {
    sessions,
    updates,
    timers,
    get: (id) => sessions.snapshot("game", id),
    tick(ms) {
      const end = clock + ms;
      while (true) {
        const entry = [...timers]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        clock = entry[1].at;
        timers.delete(entry[0]);
        entry[1].fn();
      }
      clock = end;
    },
    elapseWithoutTimers(ms) {
      clock += ms;
    },
  };
}

test("3-second countdown, question deadline, 3-second scoreboard, and final personalized review", () => {
  const { sessions, get, tick } = fixture();
  assert.equal(get("a").phase, "countdown");
  assert.equal(get("a").question, undefined);
  tick(2999);
  assert.equal(get("a").phase, "countdown");
  tick(1);
  assert.equal(get("a").phase, "question");
  assert.deepEqual(get("a").question.choices, ["a", "b", "c", "d"]);
  assert.equal(get("a").question.correctAnswer, undefined);
  assert.equal(get("a").review, undefined);
  sessions.submit("game", "a", 0, 2);
  assert.equal(get("a").submitted, true);
  assert.equal(get("b").submitted, false);
  assert.equal(get("b").yourAnswer, null);
  assert.equal(get("a").scores.find((p) => p.id === "a").score, 2);
  sessions.submit("game", "b", 0, 2);
  assert.equal(get("b").scores.find((p) => p.id === "b").score, 1);
  assert.equal(get("a").phase, "scoreboard");
  tick(2999);
  assert.equal(get("a").phase, "scoreboard");
  tick(1);
  assert.equal(get("a").questionIndex, 1);
  assert.equal(get("a").submitted, false);
  sessions.submit("game", "b", 1, 1);
  tick(5000);
  assert.equal(get("a").phase, "scoreboard");
  tick(3000);
  assert.equal(get("a").phase, "finished");
  assert.equal(get("a").review[1].yourAnswer, null);
  assert.equal(get("b").review[1].yourAnswer, 1);
  assert.equal(get("b").review[1].correctAnswer, 2);
  assert.equal(get("b").review[1].shortExplanation, "Short");
  assert.equal(get("b").review[1].longExplanation, "Long");
  assert.equal(get("a").scores.find((p) => p.id === "a").score, 2);
  assert.equal(get("b").scores.find((p) => p.id === "b").score, 1);
});

test("solo answers award one for correct and zero for incorrect through final review", () => {
  const { sessions, get, tick } = fixture(2, 1);
  tick(3000);
  sessions.submit("game", "a", 0, 2);
  assert.equal(get("a").scores[0].score, 1);
  tick(3000);
  sessions.submit("game", "a", 1, 1);
  tick(3000);
  assert.equal(get("a").phase, "finished");
  assert.equal(get("a").scores[0].score, 1);
  assert.deepEqual(get("a").review.map((question) => question.points), [1, 0]);
});

test("three players earn 3 and 2 for correct answers in order, while wrong earns zero", () => {
  const { sessions, get, tick } = fixture(2, 3);
  tick(3000);
  sessions.submit("game", "c", 0, 1);
  sessions.submit("game", "b", 0, 2);
  sessions.submit("game", "a", 0, 2);
  assert.deepEqual(get("a").scores.map(({ id, score }) => [id, score]), [
    ["b", 3], ["a", 2], ["c", 0],
  ]);
  tick(3000);
  sessions.submit("game", "a", 1, 2);
  sessions.submit("game", "b", 1, 2);
  sessions.submit("game", "c", 1, 2);
  tick(3000);
  assert.deepEqual(get("a").review.map((question) => question.points), [2, 3]);
  assert.deepEqual(get("b").review.map((question) => question.points), [3, 2]);
  assert.deepEqual(get("c").review.map((question) => question.points), [0, 1]);
});

test("departures preserve the starting player count and earlier correct answer rank", () => {
  const { sessions, get, tick } = fixture(2, 3);
  tick(3000);
  sessions.submit("game", "c", 0, 2);
  sessions.leave("game", "c");
  sessions.submit("game", "a", 0, 2);
  sessions.submit("game", "b", 0, 2);
  tick(3000);
  sessions.leave("game", "b");
  sessions.submit("game", "a", 1, 2);
  tick(3000);
  assert.deepEqual(get("a").review.map((question) => question.points), [2, 3]);
});

test("rejects outsiders, invalid choices, duplicate, stale, early and late submissions", () => {
  const { sessions, get, tick, elapseWithoutTimers } = fixture();
  assert.throws(() => sessions.submit("game", "a", 0, 2), /no longer/);
  assert.throws(() => sessions.submit("game", "outsider", 0, 2), /not in/);
  assert.equal(get("outsider"), null);
  tick(3000);
  for (const value of [0, 5, 1.5, "2", null])
    assert.throws(() => sessions.submit("game", "a", 0, value), /1 to 4/);
  assert.throws(() => sessions.submit("game", "a", 1, 2), /no longer/);
  sessions.submit("game", "a", 0, 2);
  assert.throws(() => sessions.submit("game", "a", 0, 2), /already/);
  elapseWithoutTimers(5000);
  assert.throws(() => sessions.submit("game", "b", 0, 2), /Time is up/);
  assert.equal(get("a").phase, "scoreboard");
  assert.equal(get("b").scores.find((p) => p.id === "b").score, 0);
});

test("leaving releases remaining players and cancels timers when the game empties", () => {
  const { sessions, get, tick, timers } = fixture();
  tick(3000);
  sessions.submit("game", "a", 0, 2);
  sessions.leave("game", "b");
  assert.equal(get("a").phase, "scoreboard");
  assert.equal(get("b"), null);
  assert.equal(get("a").scores.find((p) => p.id === "b").active, false);
  sessions.leave("game", "a");
  assert.equal(timers.size, 0);
  assert.equal(get("a"), null);
});

test("stop cancels all timers and malformed question records are rejected", () => {
  const { sessions, timers } = fixture();
  sessions.stop();
  assert.equal(timers.size, 0);
  assert.throws(
    () => normalizeQuestion({ question: "Missing answers" }),
    /Questions must/,
  );
  for (const choices of [
    null,
    "[]",
    [],
    ["a", "b", "c"],
    ["a", "b", "c", 4],
    ["a", "b", "c", ""],
  ]) {
    assert.throws(
      () =>
        normalizeQuestion({ question: "Invalid choices", choices, answer: 1 }),
      /Questions must/,
    );
  }
});

test("snapshots send personal answer points and reset them each question", () => {
  const { sessions, get, tick, updates } = fixture(2, 3);
  assert.equal(get("a").yourAnswerPoints, undefined);
  tick(3000);
  assert.equal(get("a").yourAnswerPoints, undefined);
  sessions.submit("game", "a", 0, 2);
  assert.equal(get("a").yourAnswerPoints, 3);
  assert.equal(updates.findLast(({ userId }) => userId === "a").update.yourAnswerPoints, 3);
  assert.equal(get("b").yourAnswerPoints, undefined);
  sessions.submit("game", "b", 0, 1);
  assert.equal(get("b").yourAnswerPoints, 0);
  assert.equal(get("a").yourAnswerPoints, 3);
  sessions.submit("game", "c", 0, 2);
  assert.equal(get("c").yourAnswerPoints, 2);
  assert.equal(get("a").phase, "scoreboard");
  tick(3000);
  for (const id of ["a", "b", "c"]) {
    assert.equal(get(id).yourAnswerPoints, undefined);
  }
  sessions.submit("game", "a", 1, 1);
  assert.equal(get("a").yourAnswerPoints, 0);
  tick(8000);
  assert.equal(get("a").phase, "finished");
  assert.equal(get("a").yourAnswerPoints, 0);
  assert.equal(get("b").yourAnswerPoints, undefined);
});

test("all players receive each player's round points without their answer choices", () => {
  const { sessions, get, tick, updates } = fixture(2, 3);
  tick(3000);
  sessions.submit("game", "a", 0, 2);
  sessions.submit("game", "b", 0, 1);
  for (const viewer of ["a", "b", "c"]) {
    const scores = updates.findLast(({ userId }) => userId === viewer).update.scores;
    assert.equal(scores.find((p) => p.id === "a").answerPoints, 3);
    assert.equal(scores.find((p) => p.id === "b").answerPoints, 0);
    assert.equal(scores.find((p) => p.id === "c").answerPoints, undefined);
    assert.ok(scores.every((p) => !("choice" in p) && !("correctAnswer" in p)));
  }
  sessions.submit("game", "c", 0, 2);
  for (const viewer of ["a", "b", "c"]) {
    assert.deepEqual(get(viewer).scores.map((p) => [p.id, p.answerPoints]), [
      ["a", 3], ["c", 2], ["b", 0],
    ]);
  }
  tick(3000);
  assert.ok(get("a").scores.every((p) => p.answerPoints === undefined));
  sessions.submit("game", "a", 1, 1);
  assert.equal(get("b").scores.find((p) => p.id === "a").answerPoints, 0);
  assert.equal(get("b").scores.find((p) => p.id === "a").score, 3);
});
