import { z } from 'zod';

type FieldLike = {
  id: string;
  kind:
    | 'short_text'
    | 'long_text'
    | 'single_select'
    | 'multi_select'
    | 'number'
    | 'email'
    | 'date'
    | 'rating_1_5';
  required: boolean;
  order: number;
  options?: Array<{ label: string; value: string }>;
  validation?: {
    minLength?: number;
    maxLength?: number;
    min?: number;
    max?: number;
    pattern?: string;
  };
  correctness?:
    | { mode: 'text_exact'; expectedText: string; normalization: 'trim_lower' }
    | { mode: 'single_select_exact'; expectedOptionValue: string }
    | { mode: 'multi_select_exact'; expectedOptionValues: string[] }
    | { mode: 'numeric_exact'; expectedNumber: number; tolerance?: number };
};

const fieldKindSchema = z.enum([
  'short_text',
  'long_text',
  'single_select',
  'multi_select',
  'number',
  'email',
  'date',
  'rating_1_5',
]);

const surveyFieldSchema = z
  .object({
    id: z.string().min(1).max(128),
    kind: fieldKindSchema,
    label: z.string().min(1).max(300),
    required: z.boolean(),
    order: z.number().int().min(0),
    placeholder: z.string().max(300).optional(),
    helpText: z.string().max(600).optional(),
    options: z
      .array(
        z.object({
          label: z.string().min(1).max(200),
          value: z.string().min(1).max(200),
        }),
      )
      .max(100)
      .optional(),
    validation: z
      .object({
        minLength: z.number().int().min(0).max(10000).optional(),
        maxLength: z.number().int().min(0).max(10000).optional(),
        min: z.number().optional(),
        max: z.number().optional(),
        pattern: z.string().max(400).optional(),
      })
      .optional(),
    correctness: z
      .union([
        z.object({
          mode: z.literal('text_exact'),
          expectedText: z.string().min(1).max(1000),
          normalization: z.literal('trim_lower'),
        }),
        z.object({
          mode: z.literal('single_select_exact'),
          expectedOptionValue: z.string().min(1).max(200),
        }),
        z.object({
          mode: z.literal('multi_select_exact'),
          expectedOptionValues: z.array(z.string().min(1).max(200)).min(1).max(100),
        }),
        z.object({
          mode: z.literal('numeric_exact'),
          expectedNumber: z.number(),
          tolerance: z.number().min(0).optional(),
        }),
      ])
      .optional(),
  })
  .superRefine((field, ctx) => {
    if ((field.kind === 'single_select' || field.kind === 'multi_select') && (!field.options || field.options.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Select fields must define at least one option.',
      });
    }
    if (field.kind === 'rating_1_5') {
      if (field.validation?.min !== undefined || field.validation?.max !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Rating fields cannot override min/max constraints.',
        });
      }
    }
    if (
      field.validation?.minLength !== undefined &&
      field.validation?.maxLength !== undefined &&
      field.validation.minLength > field.validation.maxLength
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'minLength cannot be greater than maxLength.',
      });
    }
    if (
      field.validation?.min !== undefined &&
      field.validation?.max !== undefined &&
      field.validation.min > field.validation.max
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'min cannot be greater than max.',
      });
    }

    if (!field.correctness) {
      return;
    }

    if (field.kind === 'email' || field.kind === 'date') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Correctness is not supported for email/date fields.',
      });
      return;
    }

    if ((field.kind === 'short_text' || field.kind === 'long_text') && field.correctness.mode !== 'text_exact') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Text fields require text_exact correctness mode.',
      });
      return;
    }

    if (field.kind === 'single_select') {
      if (field.correctness.mode !== 'single_select_exact') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'single_select fields require single_select_exact correctness mode.',
        });
        return;
      }
      const options = new Set((field.options ?? []).map((option) => option.value));
      if (!options.has(field.correctness.expectedOptionValue)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Correct option must be one of the configured options.',
        });
      }
      return;
    }

    if (field.kind === 'multi_select') {
      if (field.correctness.mode !== 'multi_select_exact') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'multi_select fields require multi_select_exact correctness mode.',
        });
        return;
      }
      const expectedSet = new Set(field.correctness.expectedOptionValues);
      if (expectedSet.size !== field.correctness.expectedOptionValues.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Expected options must be unique.',
        });
      }
      const options = new Set((field.options ?? []).map((option) => option.value));
      const invalid = field.correctness.expectedOptionValues.filter((value) => !options.has(value));
      if (invalid.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Expected options must be present in configured options.',
        });
      }
      return;
    }

    if (field.kind === 'number' || field.kind === 'rating_1_5') {
      if (field.correctness.mode !== 'numeric_exact') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'number/rating fields require numeric_exact correctness mode.',
        });
      }
    }
  });

export const surveyFieldsSchema = z
  .array(surveyFieldSchema)
  .min(1)
  .max(200)
  .superRefine((fields, ctx) => {
    const ids = new Set<string>();
    fields.forEach((field, index) => {
      if (ids.has(field.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate field id: ${field.id}`,
          path: [index, 'id'],
        });
      }
      ids.add(field.id);
    });

    const sorted = [...fields].sort((a, b) => a.order - b.order);
    sorted.forEach((field, index) => {
      if (field.order !== index) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Field order must be contiguous and start at 0.',
          path: [index, 'order'],
        });
      }
    });
  });

const answerValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]);
export const answerMapSchema = z.record(z.string(), answerValueSchema);

export function parseSurveyFieldsWithZod(fields: unknown) {
  return surveyFieldsSchema.parse(fields);
}

export function parseAnswerMapWithZod(value: unknown) {
  return answerMapSchema.parse(value);
}

export function validateAnswerWithZod(field: FieldLike, value: unknown): string | null {
  const required = field.required;

  const absent =
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim().length === 0) ||
    (Array.isArray(value) && value.length === 0);

  if (absent) {
    return required ? 'This field is required.' : null;
  }

  switch (field.kind) {
    case 'short_text':
    case 'long_text':
    case 'single_select':
    case 'email':
    case 'date': {
      if (typeof value !== 'string') {
        return 'Expected a string.';
      }
      if (field.kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        return 'Invalid email format.';
      }
      if (field.kind === 'single_select') {
        const options = new Set((field.options ?? []).map((option) => option.value));
        if (options.size > 0 && !options.has(value)) {
          return 'Invalid option selected.';
        }
      }
      if (field.validation?.minLength !== undefined && value.length < field.validation.minLength) {
        return `Minimum length is ${field.validation.minLength}.`;
      }
      if (field.validation?.maxLength !== undefined && value.length > field.validation.maxLength) {
        return `Maximum length is ${field.validation.maxLength}.`;
      }
      if (field.validation?.pattern) {
        const regex = new RegExp(field.validation.pattern);
        if (!regex.test(value)) {
          return 'Value does not match pattern.';
        }
      }
      return null;
    }
    case 'multi_select': {
      const multi = z.array(z.string()).safeParse(value);
      if (!multi.success) {
        return 'Expected an array of strings.';
      }
      const options = new Set((field.options ?? []).map((option) => option.value));
      if (options.size > 0 && multi.data.some((entry) => !options.has(entry))) {
        return 'One or more selected options are invalid.';
      }
      return null;
    }
    case 'number':
    case 'rating_1_5': {
      const parsed = z.number().safeParse(value);
      if (!parsed.success) {
        return 'Expected a number.';
      }
      if (field.kind === 'rating_1_5' && (parsed.data < 1 || parsed.data > 5)) {
        return 'Rating must be between 1 and 5.';
      }
      if (field.validation?.min !== undefined && parsed.data < field.validation.min) {
        return `Minimum value is ${field.validation.min}.`;
      }
      if (field.validation?.max !== undefined && parsed.data > field.validation.max) {
        return `Maximum value is ${field.validation.max}.`;
      }
      return null;
    }
  }
}
