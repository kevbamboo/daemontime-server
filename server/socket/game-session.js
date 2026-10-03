const COUNTDOWN_MS = 3000;
const SCOREBOARD_MS = 3000;

// Private, server-owned match state. Never send these records as lobby snapshots.
export function createGameSessions({
  emit,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  const sessions = new Map();
  const publicQuestion = (question, index) => ({
    index,
    text: question.text,
    choices: question.choices,
  });

  function getReviewQuestion(session, userId, question, index) {
    const answer = session.answers[index]?.[userId];
    return {
      ...publicQuestion(question, index),
      correctAnswer: question.correctAnswer,
      yourAnswer: answer?.choice ?? null,
      points: answer?.points ?? 0,
      shortExplanation: question.shortExplanation,
      longExplanation: question.longExplanation,
    };
  }

  function snapshot(session, userId) {
    const answer = session.answers[session.index]?.[userId];
    const update = {
      gameId: session.gameId,
      phase: session.phase,
      serverNow: now(),
      endsAt: session.endsAt,
      questionIndex: session.index,
      totalQuestions: session.questions.length,
      submitted: Boolean(answer),
      yourAnswer: answer?.choice ?? null,
      scores: session.players
        .map((player) => {
          const playerAnswer = session.answers[session.index]?.[player.id];
          return {
            ...player,
            score: session.scores[player.id],
            answerPoints: playerAnswer?.points,
            submitted: Boolean(playerAnswer),
            active: session.active.has(player.id),
          };
        })
        .sort(
          (a, b) => b.score - a.score || a.username.localeCompare(b.username),
        ),
    };

    if (answer) {
      update.yourAnswerPoints = answer.points;
    }
    if (session.phase === "question") {
      update.question = publicQuestion(
        session.questions[session.index],
        session.index,
      );
    }
    // Answers and explanations are withheld until the entire game ends.
    if (session.phase === "finished") {
      update.review = session.questions.map((question, index) =>
        getReviewQuestion(session, userId, question, index),
      );
    }
    return update;
  }

  function publish(session) {
    for (const userId of session.active) {
      emit(userId, snapshot(session, userId));
    }
  }
  function transition(session, phase, duration) {
    cancel(session.timer);
    session.timer = null;
    session.phase = phase;
    session.endsAt = duration === null ? null : now() + duration;
    if (duration !== null) {
      session.timer = schedule(() => advance(session), duration);
      session.timer?.unref?.();
    }
    publish(session);
  }

  function advance(session) {
    if (sessions.get(session.gameId) !== session) {
      return;
    }
    if (session.phase === "question") {
      transition(session, "scoreboard", SCOREBOARD_MS);
      return;
    }
    if (session.phase !== "countdown" && session.phase !== "scoreboard") {
      return;
    }
    if (session.index + 1 === session.questions.length) {
      transition(session, "finished", null);
      return;
    }

    session.index++;
    session.answers[session.index] = {};
    transition(session, "question", session.timeLimit * 1000);
  }
  function allSubmitted(session) {
    return [...session.active].every(
      (id) => session.answers[session.index]?.[id],
    );
  }

  return {
    start(game, questions) {
      if (sessions.has(game.gameId)) {
        return;
      }
      if (!questions.length) {
        throw new Error("No questions available.");
      }
      const session = {
        gameId: game.gameId,
        players: structuredClone(game.players),
        active: new Set(game.players.map((player) => player.id)),
        questions: structuredClone(questions),
        scores: Object.fromEntries(game.players.map((player) => [player.id, 0])),
        answers: [],
        timeLimit: game.timeLimit,
        index: -1,
        timer: null,
      };
      sessions.set(game.gameId, session);
      transition(session, "countdown", COUNTDOWN_MS);
    },
    snapshot(gameId, userId) {
      const session = sessions.get(gameId);
      return session?.active.has(userId) ? snapshot(session, userId) : null;
    },
    submit(gameId, userId, index, choice) {
      const session = sessions.get(gameId);
      if (!session?.active.has(userId)) {
        throw new Error("You are not in this game.");
      }
      if (session.phase !== "question" || index !== session.index) {
        throw new Error("This question is no longer accepting answers.");
      }
      if (now() >= session.endsAt) {
        advance(session);
        throw new Error("Time is up.");
      }
      if (!Number.isInteger(choice) || choice < 1 || choice > 4) {
        throw new Error("Choose an answer from 1 to 4.");
      }
      const answers = session.answers[index];
      if (answers[userId]) {
        throw new Error("You already submitted an answer.");
      }
      const correct = choice === session.questions[index].correctAnswer;
      const correctBefore = Object.values(answers).filter(
        (answer) => answer.points > 0,
      ).length;
      // players is the starting roster; departures do not lower question points.
      const points = correct ? session.players.length - correctBefore : 0;
      answers[userId] = { choice, points };
      session.scores[userId] += points;
      if (allSubmitted(session)) {
        transition(session, "scoreboard", SCOREBOARD_MS);
      } else {
        publish(session);
      }
      return true;
    },
    leave(gameId, userId) {
      const session = sessions.get(gameId);
      if (!session) {
        return;
      }
      session.active.delete(userId);
      if (!session.active.size) {
        cancel(session.timer);
        sessions.delete(gameId);
      } else if (session.phase === "question" && allSubmitted(session)) {
        transition(session, "scoreboard", SCOREBOARD_MS);
      } else {
        publish(session);
      }
    },
    stop() {
      for (const session of sessions.values()) {
        cancel(session.timer);
      }
      sessions.clear();
    },
  };
}
