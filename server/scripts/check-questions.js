import { supabase } from "../lib/supabase.js";
import { loadQuestionBank } from "../db/question-bank.js";

// Read-only check: print schema/counts, never credentials or question contents.
const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/`, {
  headers: {
    apikey: process.env.SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
  },
  signal: AbortSignal.timeout(10000),
});
if (response.ok) {
  const schema = await response.json();
  const columns = schema.definitions?.questions?.properties;
  console.log(
    JSON.stringify({
      schema: columns
        ? { id: columns.id, choices: columns.choices, source: columns.source }
        : null,
    }),
  );
}
const questions = await loadQuestionBank(supabase);
console.log(
  JSON.stringify({
    loadedQuestions: questions.length,
    allChoicesHaveFourStrings: questions.every(
      (question) =>
        question.choices.length === 4 &&
        question.choices.every((choice) => typeof choice === "string"),
    ),
  }),
);
