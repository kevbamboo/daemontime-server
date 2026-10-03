export function validateGameSettings(settings) {
  const { timeLimit, numberOfQuestions } = settings ?? {};
  const isValid = (value) =>
    Number.isInteger(value) && value >= 5 && value <= 99;

  if (!isValid(timeLimit) || !isValid(numberOfQuestions)) {
    throw new Error(
      "Time limit and number of questions must be whole numbers from 5 to 99.",
    );
  }
}
