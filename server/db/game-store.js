import { validateGameSettings } from "../lib/game-settings.js";

const TABLE = "currentGames";
const PAGE_SIZE = 1000;
const QUERY_TIMEOUT_MS = 5000;
const GAME_COLUMNS =
  "game_id,host_id,host_handle,users_in_game,state,time_limit,number_of_questions";

function gameFromRow(row) {
  return {
    gameId: row.game_id,
    hostId: row.host_id,
    timeLimit: row.time_limit,
    numberOfQuestions: row.number_of_questions,
    players: row.users_in_game.map((id) => ({
      id,
      username: id === row.host_id ? row.host_handle : `Player-${id.slice(0, 8)}`,
    })),
    started: row.state !== "waiting",
  };
}

function rowFromGame(game) {
  const host = game.players.find((player) => player.id === game.hostId);
  if (!host) {
    throw new Error("The game host must be one of its players.");
  }

  return {
    game_id: game.gameId,
    host_id: game.hostId,
    host_handle: host.username,
    users_in_game: game.players.map((player) => player.id),
    state: game.started ? "started" : "waiting",
    time_limit: game.timeLimit,
    number_of_questions: game.numberOfQuestions,
  };
}

export async function createGameStore(supabase, defaults) {
  validateGameSettings(defaults);
  const games = new Map();

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(TABLE)
      .select(GAME_COLUMNS)
      .order("game_id")
      .range(offset, offset + PAGE_SIZE - 1)
      .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS));

    if (error || !Array.isArray(data)) {
      throw new Error(
        "Unable to load currentGames from Supabase. Check the server credentials and table columns.",
        { cause: error },
      );
    }

    for (const row of data) {
      games.set(row.game_id, gameFromRow(row));
    }
    if (data.length < PAGE_SIZE) {
      break;
    }
  }

  async function save(query, message) {
    const { error } = await query.abortSignal(
      AbortSignal.timeout(QUERY_TIMEOUT_MS),
    );
    if (error) {
      console.error("Supabase game save failed", {
        table: TABLE,
        code: error.code,
        message: error.message,
        hint: error.hint,
      });
      throw new Error(message, { cause: error });
    }
  }

  return {
    list() {
      return structuredClone([...games.values()]);
    },

    // The schema stores only the host's handle. Other names are restored on join.
    rememberPlayer(userId, username) {
      for (const game of games.values()) {
        const player = game.players.find((player) => player.id === userId);
        if (player) {
          player.username = username;
        }
      }
    },

    async replace(game, gameId) {
      if (game && game.gameId !== gameId) {
        throw new Error("The game ID must match the record being replaced.");
      }

      const previous = games.get(gameId);
      const next = game
        ? structuredClone({
            ...game,
            timeLimit: previous?.timeLimit ?? game.timeLimit ?? defaults.timeLimit,
            numberOfQuestions:
              previous?.numberOfQuestions ??
              game.numberOfQuestions ??
              defaults.numberOfQuestions,
          })
        : null;

      if (next) {
        validateGameSettings(next);
      }

      // Solo matches stay in memory; starting one removes its persisted lobby.
      if (next?.solo || (!next && previous?.solo)) {
        if (previous && !previous.solo) {
          await save(
            supabase.from(TABLE).delete().eq("game_id", gameId),
            "Unable to remove solo game from the database.",
          );
        }
      } else {
        const query = next
          ? supabase.from(TABLE).upsert(rowFromGame(next), {
              onConflict: "game_id",
              defaultToNull: false,
            })
          : supabase.from(TABLE).delete().eq("game_id", gameId);
        await save(
          query,
          "Unable to save game. Check the server log for the database error.",
        );
      }

      // Commit the in-memory snapshot only after the database write succeeds.
      if (next) {
        games.set(gameId, next);
      } else {
        games.delete(gameId);
      }
    },
  };
}
