
function findCurrentGame(games: Game[]) {
  return games.find((game) =>
    game.players.some((player) => player.id === socketService.userId),
  );
}

function isFinished(update: GameUpdate | null) {
  return update?.phase === 'finished' || update?.phase === 'interrupted';
}
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import EmptyLobby from "./EmptyLobby";
import MessageBox from "./MessageBox";
import GameCard from "./GameCard";
import NewGameModal from "./NewGameModal";
import GamePlay from "./GamePlay";
import {
  socketService,
  type Game,
  type GameUpdate,
} from "../services/socket.service";
import "./GameBox.css";

export default function GameBox() {
  const newGameButtonRef = useRef<HTMLButtonElement>(null);
  const [games, setGames] = useState<Game[]>([]);
  const [gameUpdate, setGameUpdate] = useState<GameUpdate | null>(null);
  const [showConnectionFallback, setShowConnectionFallback] = useState(false);
  const [, redraw] = useState(0);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [activeTab, setActiveTab] = useState<"users" | "lobby" | "game">(
    "lobby",
  );
  const [, redrawUsers] = useState(0);
  useEffect(() => {
    if (socketService.ready) {
      setShowConnectionFallback(false);
      return;
    }

    const timeout = window.setTimeout(() => {
      setShowConnectionFallback(true);
    }, 5000);

    return () => window.clearTimeout(timeout);
  }, [socketService.ready]);
  useEffect(() => {
    let previousGameId: string | undefined;
    const gamesOff = socketService.subscribeToGames((nextGames) => {
      const nextGameId = nextGames.find((g) =>
        g.players.some((p) => p.id === socketService.userId),
      )?.gameId;
      if (nextGameId && nextGameId !== previousGameId) setActiveTab("game");
      previousGameId = nextGameId;
      setGames(nextGames);
    });
    const statusOff = socketService.subscribeToStatus(() =>
      redraw((n) => n + 1),
    );
    const usersOff = socketService.subscribeToOnlineUsers(() =>
      redrawUsers((n) => n + 1),
    );
    const gameUpdatesOff = socketService.subscribeToGameUpdates(setGameUpdate);
    return () => {
      gamesOff();
      statusOff();
      usersOff();
      gameUpdatesOff();
    };
  }, []);
  const game = findCurrentGame(games);
  const hasGameTab = !!game;
  const useNativeCursor = creating || hasGameTab;
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.toggleAttribute("data-native-cursor", useNativeCursor);
    return () => root.removeAttribute("data-native-cursor");
  }, [useNativeCursor]);
  const selectedTab = activeTab === "game" && !hasGameTab ? "lobby" : activeTab;
  const gameEnded = isFinished(gameUpdate);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      socketService.reportError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div id="game">
      <h1 className="game-title">Daemon Time</h1>
      {socketService.error && showConnectionFallback && (
        <p role="alert">{socketService.error}</p>
      )}
      {!socketService.ready ? (
        showConnectionFallback ? (
          <div className="connection-overlay">
            Connecting…{" "}
            <button
              onClick={() => void action(() => socketService.retryConnection())}
            >
              Retry
            </button>
          </div>
        ) : null
      ) : (
        <>
          <div id="game-box">
            {!game ? (
              <>
                <div className="game-box-header">
                  <h2>Lobby</h2>
                  <button
                    ref={newGameButtonRef}
                    className="new-game-button"
                    disabled={busy}
                    onClick={() => setCreating(true)}
                  >
                    Create Game
                  </button>
                </div>
                {games.length === 0 && (
                  <EmptyLobby buttonRef={newGameButtonRef} />
                )}
                <div id="game-list">
                  {games.map((g) => (
                    <GameCard
                      key={g.gameId}
                      game={g}
                      disabled={busy}
                      onJoin={() =>
                        void action(() => socketService.joinGame(g.gameId))
                      }
                    />
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="game-header">
                  <h2>
                    {game.players.find((player) => player.id === game.hostId)
                      ?.username ?? "Host"}
                    's Game
                  </h2>
                  {(!game.started || game.solo || gameEnded) && (
                    <button
                      className={`leave-button${gameEnded ? " leave-highlight" : ""}`}
                      disabled={busy}
                      onClick={() =>
                        void action(() => socketService.leaveGame(game.gameId))
                      }
                    >
                      {gameEnded && <span aria-hidden="true">←</span>}
                      {gameEnded ? "Lobby" : "Leave"}
                    </button>
                  )}
                </div>
                {game.started ? (
                  <GamePlay
                    key={game.gameId}
                    update={
                      gameUpdate?.gameId === game.gameId ? gameUpdate : null
                    }
                  />
                ) : (
                  <div className="players-section">
                    <h3>Players</h3>
                    <ol>
                      {game.players.map((player) => (
                        <li key={player.id}>
                          {player.username}
                          {player.id === game.hostId ? " (Host)" : ""}
                        </li>
                      ))}
                    </ol>
                    {game.players.length === 1 && (
                      <p>Waiting for players to join...</p>
                    )}
                    {socketService.isCurrentGameHost && (
                      <button
                        className="start-game-button"
                        disabled={busy || game.started}
                        onClick={() =>
                          void action(() =>
                            socketService.startGame(game.gameId),
                          )
                        }
                      >
                        {game.started ? "Started" : "Start Game"}
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
          <aside className="chat-panel">
            <div
              className="chat-tabs"
              role="tablist"
              aria-label="Lobby sidebar"
              style={
                {
                  "--tab-index":
                    selectedTab === "users"
                      ? 0
                      : selectedTab === "lobby"
                        ? 1
                        : 2,
                  "--tab-count": hasGameTab ? 3 : 2,
                } as React.CSSProperties
              }
            >
              <button
                className={selectedTab === "users" ? "active" : ""}
                role="tab"
                aria-selected={selectedTab === "users"}
                onClick={() => setActiveTab("users")}
              >
                Online <span>{socketService.onlineUsers.length}</span>
              </button>
              <button
                className={selectedTab === "lobby" ? "active" : ""}
                role="tab"
                aria-selected={selectedTab === "lobby"}
                onClick={() => setActiveTab("lobby")}
              >
                Lobby Chat
              </button>
              {hasGameTab && (
                <button
                  className={selectedTab === "game" ? "active" : ""}
                  role="tab"
                  aria-selected={selectedTab === "game"}
                  onClick={() => setActiveTab("game")}
                >
                  Game Chat
                </button>
              )}
            </div>
            {selectedTab === "users" ? (
              <div className="online-users" role="tabpanel">
                <ul>
                  {socketService.onlineUsers.map((user) => (
                    <li key={user.id}>
                      <span className="online-dot" />
                      {user.username}
                      {user.id === socketService.userId && <small>You</small>}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <MessageBox gameState={selectedTab === "game" ? 1 : 0} />
            )}
          </aside>
        </>
      )}
      {creating && <NewGameModal onClose={() => setCreating(false)} />}
    </div>
  );
}
