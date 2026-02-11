import { DateTime } from 'luxon';

const RESPONDENT_KEY_STORAGE_KEY = 'survey:respondent-key';

export type FieldKind =
  | 'short_text'
  | 'long_text'
  | 'single_select'
  | 'multi_select'
  | 'number'
  | 'email'
  | 'date'
  | 'rating_1_5';

export type FieldCorrectness =
  | { mode: 'text_exact'; expectedText: string; normalization: 'trim_lower' }
  | { mode: 'single_select_exact'; expectedOptionValue: string }
  | { mode: 'multi_select_exact'; expectedOptionValues: string[] }
  | { mode: 'numeric_exact'; expectedNumber: number; tolerance?: number };

export type SurveyField = {
  id: string;
  kind: FieldKind;
  label: string;
  required: boolean;
  order: number;
  placeholder?: string;
  helpText?: string;
  options?: Array<{ label: string; value: string }>;
  validation?: {
    minLength?: number;
    maxLength?: number;
    min?: number;
    max?: number;
    pattern?: string;
  };
  correctness?: FieldCorrectness;
};

export type SurveyTemplate = {
  key: 'blank' | 'customer_satisfaction' | 'product_feedback';
  label: string;
  description: string;
  fields: SurveyField[];
};

export function getOrCreateRespondentKey() {
  if (typeof window === 'undefined') {
    return 'server_respondent_key';
  }

  const existing = window.localStorage.getItem(RESPONDENT_KEY_STORAGE_KEY);
  if (existing && existing.length >= 12) {
    return existing;
  }

  const next = `resp_${crypto.randomUUID().replace(/-/g, '')}`;
  window.localStorage.setItem(RESPONDENT_KEY_STORAGE_KEY, next);
  return next;
}

export function formatDateTime(timestamp?: number | null) {
  if (!timestamp) {
    return 'n/a';
  }

  return DateTime.fromMillis(timestamp).toLocaleString(DateTime.DATETIME_MED_WITH_SECONDS);
}

export function formatRelativeMinutes(timestamp: number) {
  const minutes = Math.max(0, Math.floor(DateTime.now().diff(DateTime.fromMillis(timestamp), 'minutes').minutes));
  if (minutes === 1) {
    return '1 minute ago';
  }
  return `${minutes} minutes ago`;
}

export function buildDefaultField(index: number): SurveyField {
  return {
    id: `field_${index + 1}`,
    kind: 'short_text',
    label: `Question ${index + 1}`,
    required: false,
    order: index,
    placeholder: '',
    helpText: '',
  };
}

function buildTemplateField(base: SurveyField, index: number): SurveyField {
  return {
    ...base,
    order: index,
  };
}

export const surveyTemplates: SurveyTemplate[] = [
  {
    key: 'blank',
    label: 'Blank',
    description: 'Start with an empty survey and add questions manually.',
    fields: [],
  },
  {
    key: 'customer_satisfaction',
    label: 'Customer Satisfaction',
    description: 'Quick CSAT-style survey with score and follow-up feedback.',
    fields: [
      buildTemplateField(
        {
          id: 'overall_rating',
          kind: 'rating_1_5',
          label: 'How satisfied are you overall?',
          required: true,
          order: 0,
          correctness: {
            mode: 'numeric_exact',
            expectedNumber: 5,
            tolerance: 0,
          },
        },
        0,
      ),
      buildTemplateField(
        {
          id: 'liked_most',
          kind: 'long_text',
          label: 'What did you like most?',
          required: true,
          order: 1,
          placeholder: 'Share specific highlights',
          validation: { minLength: 5, maxLength: 500 },
        },
        1,
      ),
      buildTemplateField(
        {
          id: 'would_recommend',
          kind: 'single_select',
          label: 'Would you recommend us?',
          required: true,
          order: 2,
          options: [
            { label: 'Yes', value: 'yes' },
            { label: 'No', value: 'no' },
          ],
          correctness: {
            mode: 'single_select_exact',
            expectedOptionValue: 'yes',
          },
        },
        2,
      ),
    ],
  },
  {
    key: 'product_feedback',
    label: 'Product Feedback',
    description: 'Collect feature and usability feedback from users.',
    fields: [
      buildTemplateField(
        {
          id: 'feature_value',
          kind: 'single_select',
          label: 'Which feature delivers the most value?',
          required: true,
          order: 0,
          options: [
            { label: 'Automation', value: 'automation' },
            { label: 'Analytics', value: 'analytics' },
            { label: 'Collaboration', value: 'collaboration' },
          ],
        },
        0,
      ),
      buildTemplateField(
        {
          id: 'improvement_areas',
          kind: 'multi_select',
          label: 'Which areas need improvement?',
          required: false,
          order: 1,
          options: [
            { label: 'Performance', value: 'performance' },
            { label: 'UX', value: 'ux' },
            { label: 'Integrations', value: 'integrations' },
          ],
        },
        1,
      ),
      buildTemplateField(
        {
          id: 'details',
          kind: 'long_text',
          label: 'Tell us more about your feedback.',
          required: false,
          order: 2,
          placeholder: 'Optional details',
          validation: { maxLength: 1000 },
        },
        2,
      ),
    ],
  },
];
