import { test } from "node:test";
import assert from "node:assert/strict";
import { readServerConfig, requiredSetting } from "../lib/config.js";

const development = { FRONTEND_URL_DEVELOPMENT: "http://localhost:5173" };

test("configuration reads numeric ports, game defaults, and the correct frontend", () => {
  assert.deepEqual(readServerConfig(development), {
    frontendUrl: "http://localhost:5173",
    port: 3000,
    gameSettings: { timeLimit: 30, numberOfQuestions: 5 },
  });
  assert.deepEqual(
    readServerConfig({
      NODE_ENV: "production",
      FRONTEND_URL_PRODUCTION: "https://example.com",
      PORT: "8080",
      GAME_TIME_LIMIT_SECONDS: "99",
      GAME_NUMBER_OF_QUESTIONS: "5",
    }),
    {
      frontendUrl: "https://example.com",
      port: 8080,
      gameSettings: { timeLimit: 99, numberOfQuestions: 5 },
    },
  );
});

test("configuration rejects missing credentials, invalid ports, and unusable game defaults", () => {
  assert.throws(
    () => requiredSetting("SUPABASE_SECRET_KEY", {}),
    /SUPABASE_SECRET_KEY/,
  );
  assert.throws(
    () => requiredSetting("SUPABASE_URL", { SUPABASE_URL: " " }),
    /SUPABASE_URL/,
  );
  assert.throws(
    () => readServerConfig({ NODE_ENV: "production" }),
    /FRONTEND_URL_PRODUCTION/,
  );
  for (const port of ["abc", "-1", "65536", "3.5"]) {
    assert.throws(() => readServerConfig({ ...development, PORT: port }), /PORT/);
  }
  for (const setting of ["GAME_TIME_LIMIT_SECONDS", "GAME_NUMBER_OF_QUESTIONS"]) {
    for (const value of ["", "4", "100", "5.5", "abc"]) {
      assert.throws(
        () => readServerConfig({ ...development, [setting]: value }),
        /5 to 99/,
      );
    }
  }
});
