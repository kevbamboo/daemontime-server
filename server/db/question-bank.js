const PAGE_SIZE = 1000;
const QUERY_TIMEOUT_MS = 5000;

export function normalizeQuestion(row) {
  const choices = row?.choices;
  const answer = row?.answer;
  const correctAnswer =
    typeof answer === "number" || typeof answer === "string"
      ? Number(answer)
      : NaN;

  if (
    typeof row?.question !== "string" ||
    !row.question.trim() ||
    !Array.isArray(choices) ||
    choices.length !== 4 ||
    choices.some((choice) => typeof choice !== "string" || !choice.trim()) ||
    !Number.isInteger(correctAnswer) ||
    correctAnswer < 1 ||
    correctAnswer > 4
  ) {
    throw new Error(
      "Questions must contain question, choices (an array of four strings), and answer (1-4).",
    );
  }

  return {
    text: row.question,
    choices: [...choices],
    correctAnswer,
    shortExplanation: String(row.short_explanation ?? ""),
    longExplanation: String(row.long_explanation ?? ""),
  };
}

export async function loadQuestionBank(supabase) {
  if (!supabase) {
    throw new Error("Question database is not configured.");
  }

  const questions = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("questions")
      .select("question,choices,answer,short_explanation,long_explanation")
      .order("id")
      .range(offset, offset + PAGE_SIZE - 1)
      .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS));

    if (error || !Array.isArray(data)) {
      throw new Error(
        "Unable to load questions. Check the question bank database schema.",
        { cause: error },
      );
    }

    questions.push(...data.map(normalizeQuestion));
    if (data.length < PAGE_SIZE) {
      return questions;
    }
  }
}
