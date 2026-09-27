import type { Game } from "../services/socket.service";
import "./GameCard.css";

type GameCardProps = {
  game: Game;
  disabled: boolean;
  onJoin: () => void;
};

export default function GameCard({ game, disabled, onJoin }: GameCardProps) {
  const { started } = game;
  const host = game.players.find(
    (player) => player.id === game.hostId,
  )?.username;
  const unavailable = disabled || started;

  return (
    <button
      type="button"
      className="game-card"
      onClick={onJoin}
      disabled={unavailable}
      aria-label={`${started ? "Game in progress" : "Join game"} hosted by ${host ?? "unknown"}, ${game.players.length} players, ${game.numberOfQuestions} questions, ${game.timeLimit} seconds per question`}
    >
      <span className="game-card-front" aria-hidden="true">
        <span className="game-card-status">
          <span className={started ? "status-dot started" : "status-dot"} />
          {started ? "In Progress" : "Open"}
        </span>

        <span className="game-card-info">
          <span>
            <span className="game-card-label">HOST</span>
            <strong>{host}</strong>
          </span>
          <span className="game-card-player-count">
            {game.players.length} {game.players.length === 1 ? "player" : "players"}
          </span>
        </span>
      </span>
      <span className="game-card-back" aria-hidden="true">
        <span className="game-card-back-title">GAME DETAILS</span>
        <span className="game-card-details">
          <span>
            <strong>{game.numberOfQuestions}</strong>
            <span>Questions</span>
          </span>
          <span>
            <strong>{game.timeLimit}</strong>
            <span>Seconds/q</span>
          </span>
        </span>
      </span>
    </button>
  );
}
