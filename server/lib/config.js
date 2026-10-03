import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { validateGameSettings } from "./game-settings.js";

// Resolve .env relative to the server, even when started from the repository root.
dotenv.config({
  path: fileURLToPath(new URL("../.env", import.meta.url)),
  quiet: true,
});

export function requiredSetting(name, environment = process.env) {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function readServerConfig(environment = process.env) {
  const frontendSetting =
    environment.NODE_ENV === "production"
      ? "FRONTEND_URL_PRODUCTION"
      : "FRONTEND_URL_DEVELOPMENT";
  const frontendUrl = requiredSetting(frontendSetting, environment);
  const port = Number(environment.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be a whole number from 0 to 65535.");
  }

  const gameSettings = {
    timeLimit: Number(environment.GAME_TIME_LIMIT_SECONDS ?? 30),
    numberOfQuestions: Number(environment.GAME_NUMBER_OF_QUESTIONS ?? 5),
  };
  validateGameSettings(gameSettings);

  return { frontendUrl, port, gameSettings };
}
