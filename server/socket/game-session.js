// Private, server-owned match state. Never send these records as lobby snapshots.
export function normalizeQuestion(row) {
  const choices = row.choices;
  const correctAnswer = Number(row.answer);
  if (
    typeof row.question !== "string" ||
    !row.question.trim() ||
    !Array.isArray(choices) ||
    choices.length !== 4 ||
    choices.some((choice) => typeof choice !== "string" || !choice.trim()) ||
    !Number.isInteger(correctAnswer) ||
    correctAnswer < 1 ||
    correctAnswer > 4
  ) {
    throw new Error(
      "Questions must contain question, choices (an array of four strings), and answer (1–4).",
    );
  }
  return {
    text: row.question,
    choices,
    correctAnswer,
    shortExplanation: String(row.short_explanation ?? ""),
    longExplanation: String(row.long_explanation ?? ""),
  };
}

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
    const question = session.questions[session.index];
    return {
      gameId: session.gameId,
      phase: session.phase,
      serverNow: now(),
      endsAt: session.endsAt,
      questionIndex: session.index,
      totalQuestions: session.questions.length,
      submitted: !!answer,
      yourAnswer: answer?.choice ?? null,
      ...(answer ? { yourAnswerPoints: answer.points } : {}),
      scores: session.players
        .map((player) => ({
          ...player,
          score: session.scores[player.id],
          answerPoints: session.answers[session.index]?.[player.id]?.points,
          submitted: !!session.answers[session.index]?.[player.id],
          active: session.active.has(player.id),
        }))
        .sort(
          (a, b) => b.score - a.score || a.username.localeCompare(b.username),
        ),
      ...(session.phase === "question"
        ? { question: publicQuestion(question, session.index) }
        : {}),
      // Answers and explanations are withheld until the entire game ends.
      ...(session.phase === "finished"
        ? {
            review: session.questions.map((question, index) =>
              getReviewQuestion(session, userId, question, index),
            ),
          }
        : {}),
    };
  }
  function publish(session) {
    for (const id of session.active) emit(id, snapshot(session, id));
  }
  function transition(session, phase, duration) {
    cancel(session.timer);
    session.phase = phase;
    session.endsAt = duration === null ? null : now() + duration;
    if (duration !== null) {
      session.timer = schedule(() => advance(session), duration);
      session.timer?.unref?.();
    }
    publish(session);
  }
  function advance(session) {
    if (!sessions.has(session.gameId)) return;
    if (session.phase === "question") transition(session, "scoreboard", 3000);
    else if (session.phase === "countdown" || session.phase === "scoreboard") {
      session.index++;
      if (session.index === session.questions.length) {
        session.index--;
        transition(session, "finished", null);
      } else {
        session.answers[session.index] = {};
        transition(session, "question", session.timeLimit * 1000);
      }
    }
  }
  function allSubmitted(session) {
    return [...session.active].every(
      (id) => session.answers[session.index]?.[id],
    );
  }
  return {
    start(game, questions) {
      if (sessions.has(game.gameId)) return;
      if (!questions.length) throw new Error("No questions available.");
      const session = {
        gameId: game.gameId,
        players: structuredClone(game.players),
        active: new Set(game.players.map((p) => p.id)),
        questions: structuredClone(questions),
        scores: Object.fromEntries(game.players.map((p) => [p.id, 0])),
        answers: [],
        timeLimit: game.timeLimit,
        index: -1,
        timer: null,
      };
      sessions.set(game.gameId, session);
      transition(session, "countdown", 3000);
    },
    snapshot(gameId, userId) {
      const session = sessions.get(gameId);
      return session?.active.has(userId) ? snapshot(session, userId) : null;
    },
    submit(gameId, userId, index, choice) {
      const session = sessions.get(gameId);
      if (!session?.active.has(userId))
        throw new Error("You are not in this game.");
      if (session.phase !== "question" || index !== session.index)
        throw new Error("This question is no longer accepting answers.");
      if (now() >= session.endsAt) {
        advance(session);
        throw new Error("Time is up.");
      }
      if (!Number.isInteger(choice) || choice < 1 || choice > 4)
        throw new Error("Choose an answer from 1 to 4.");
      const answers = session.answers[index];
      if (answers[userId]) throw new Error("You already submitted an answer.");
      const correct = choice === session.questions[index].correctAnswer;
      const correctBefore = Object.values(answers).filter(
        (answer) => answer.points > 0,
      ).length;
      // players is the starting roster; departures do not lower question points.
      const points = correct ? session.players.length - correctBefore : 0;
      answers[userId] = { choice, points };
      session.scores[userId] += points;
      if (allSubmitted(session)) transition(session, "scoreboard", 3000);
      else publish(session);
      return true;
    },
    leave(gameId, userId) {
      const session = sessions.get(gameId);
      if (!session) return;
      session.active.delete(userId);
      if (!session.active.size) {
        cancel(session.timer);
        sessions.delete(gameId);
      } else if (session.phase === "question" && allSubmitted(session))
        transition(session, "scoreboard", 3000);
      else publish(session);
    },
    stop() {
      for (const session of sessions.values()) cancel(session.timer);
      sessions.clear();
    },
  };
}
