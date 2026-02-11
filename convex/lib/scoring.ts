import type { Doc } from '../_generated/dataModel';

type SurveyField = Doc<'surveyVersions'>['fields'][number];

export type FieldCorrectnessResult = {
  isCorrect: boolean;
};

export type SubmissionGrading = {
  gradableCount: number;
  correctCount: number;
  incorrectCount: number;
  scorePercent: number;
  fieldResults: Record<string, FieldCorrectnessResult>;
};

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function compareExactMultiSelect(expected: string[], actual: string[]): boolean {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  if (expectedSet.size !== actualSet.size) {
    return false;
  }
  for (const value of expectedSet) {
    if (!actualSet.has(value)) {
      return false;
    }
  }
  return true;
}

export function evaluateFieldCorrectness(field: SurveyField, answer: unknown): boolean | null {
  const correctness = field.correctness;
  if (!correctness) {
    return null;
  }

  switch (correctness.mode) {
    case 'text_exact': {
      if (typeof answer !== 'string') {
        return false;
      }
      return normalizeText(answer) === normalizeText(correctness.expectedText);
    }
    case 'single_select_exact': {
      return typeof answer === 'string' && answer === correctness.expectedOptionValue;
    }
    case 'multi_select_exact': {
      if (!Array.isArray(answer) || answer.some((entry) => typeof entry !== 'string')) {
        return false;
      }
      return compareExactMultiSelect(correctness.expectedOptionValues, answer as string[]);
    }
    case 'numeric_exact': {
      if (typeof answer !== 'number' || Number.isNaN(answer)) {
        return false;
      }
      const tolerance = correctness.tolerance ?? 0;
      return Math.abs(answer - correctness.expectedNumber) <= tolerance;
    }
  }
}

export function gradeSubmission(
  fields: Doc<'surveyVersions'>['fields'],
  answers: Record<string, unknown>,
): SubmissionGrading {
  let gradableCount = 0;
  let correctCount = 0;
  const fieldResults: Record<string, FieldCorrectnessResult> = {};

  for (const field of fields) {
    if (!field.correctness) {
      continue;
    }
    gradableCount += 1;
    const isCorrect = evaluateFieldCorrectness(field, answers[field.id]) === true;
    if (isCorrect) {
      correctCount += 1;
    }
    fieldResults[field.id] = { isCorrect };
  }

  const incorrectCount = Math.max(0, gradableCount - correctCount);
  const scorePercent = gradableCount === 0 ? 0 : Math.round((correctCount / gradableCount) * 10000) / 100;

  return {
    gradableCount,
    correctCount,
    incorrectCount,
    scorePercent,
    fieldResults,
  };
}
