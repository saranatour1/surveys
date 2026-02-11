import { Link, createFileRoute } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { AdminShell } from '@/components/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { convexApi } from '@/lib/convex-api';
import {
  buildDefaultField,
  surveyTemplates,
  type FieldCorrectness,
  type FieldKind,
  type SurveyField,
} from '@/lib/survey';
import { posthogCapture } from '@/lib/posthog';

export const Route = createFileRoute('/_authenticated/surveys/$surveyId/builder')({
  component: SurveyBuilderRoutePage,
});

type VersionSummary = {
  surveyVersionId: string;
  version: number;
  publishedAt?: number;
  createdAt: number;
  fieldCount: number;
};

type SurveyDetail = {
  surveyId: string;
  slug: string;
  title: string;
  description?: string;
  status: 'draft' | 'published' | 'archived';
  currentVersionId?: string;
  versions: VersionSummary[];
  currentVersion: {
    surveyVersionId: string;
    version: number;
    fields: SurveyField[];
    settings: {
      title?: string;
      description?: string;
      showProgressBar?: boolean;
    };
  } | null;
};

type EditorTab = 'basics' | 'validation' | 'correctness';

type OptionRow = { label: string; value: string };

const fieldKinds: Array<{ value: SurveyField['kind']; label: string }> = [
  { value: 'short_text', label: 'Short text' },
  { value: 'long_text', label: 'Long text' },
  { value: 'single_select', label: 'Single select' },
  { value: 'multi_select', label: 'Multi select' },
  { value: 'number', label: 'Number' },
  { value: 'email', label: 'Email' },
  { value: 'date', label: 'Date' },
  { value: 'rating_1_5', label: 'Rating (1-5)' },
];

function normalizeFieldOrder(fields: SurveyField[]) {
  return fields.map((field, index) => ({ ...field, order: index }));
}

function moveField(fields: SurveyField[], index: number, direction: -1 | 1) {
  const next = [...fields];
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= next.length) {
    return next;
  }
  const [removed] = next.splice(index, 1);
  next.splice(targetIndex, 0, removed);
  return normalizeFieldOrder(next);
}

function toOptionValue(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'option';
}

function parseOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

function withValidationValue(
  field: SurveyField,
  key: 'minLength' | 'maxLength' | 'pattern' | 'min' | 'max',
  value: string | number | undefined,
): SurveyField {
  const nextValidation = {
    ...(field.validation ?? {}),
    [key]: value,
  };

  if (value === undefined || value === '') {
    delete nextValidation[key];
  }

  return {
    ...field,
    validation: Object.keys(nextValidation).length > 0 ? nextValidation : undefined,
  };
}

function supportsCorrectness(kind: FieldKind): boolean {
  return kind !== 'email' && kind !== 'date';
}

function defaultCorrectnessForField(field: SurveyField): FieldCorrectness | undefined {
  if (field.kind === 'short_text' || field.kind === 'long_text') {
    return {
      mode: 'text_exact',
      expectedText: '',
      normalization: 'trim_lower',
    };
  }

  if (field.kind === 'single_select') {
    const first = field.options?.[0]?.value;
    if (!first) {
      return undefined;
    }
    return {
      mode: 'single_select_exact',
      expectedOptionValue: first,
    };
  }

  if (field.kind === 'multi_select') {
    const first = field.options?.[0]?.value;
    if (!first) {
      return undefined;
    }
    return {
      mode: 'multi_select_exact',
      expectedOptionValues: [first],
    };
  }

  if (field.kind === 'number' || field.kind === 'rating_1_5') {
    return {
      mode: 'numeric_exact',
      expectedNumber: 0,
    };
  }

  return undefined;
}

function syncCorrectnessWithOptions(field: SurveyField): SurveyField {
  const correctness = field.correctness;
  if (!correctness) {
    return field;
  }

  if (correctness.mode === 'single_select_exact') {
    const options = field.options ?? [];
    if (options.length === 0) {
      return { ...field, correctness: undefined };
    }
    if (!options.some((option) => option.value === correctness.expectedOptionValue)) {
      return {
        ...field,
        correctness: {
          mode: 'single_select_exact',
          expectedOptionValue: options[0].value,
        },
      };
    }
    return field;
  }

  if (correctness.mode === 'multi_select_exact') {
    const options = field.options ?? [];
    if (options.length === 0) {
      return { ...field, correctness: undefined };
    }
    const optionValues = new Set(options.map((option) => option.value));
    const nextExpected = correctness.expectedOptionValues.filter((value) => optionValues.has(value));

    return {
      ...field,
      correctness: {
        mode: 'multi_select_exact',
        expectedOptionValues: nextExpected.length > 0 ? nextExpected : [options[0].value],
      },
    };
  }

  return field;
}

function summarizeValidation(field: SurveyField): string {
  const rules: string[] = [];
  if (field.required) {
    rules.push('required');
  }
  if (field.validation?.minLength !== undefined) {
    rules.push(`minLen ${field.validation.minLength}`);
  }
  if (field.validation?.maxLength !== undefined) {
    rules.push(`maxLen ${field.validation.maxLength}`);
  }
  if (field.validation?.min !== undefined) {
    rules.push(`min ${field.validation.min}`);
  }
  if (field.validation?.max !== undefined) {
    rules.push(`max ${field.validation.max}`);
  }
  if (field.validation?.pattern) {
    rules.push('pattern');
  }

  return rules.length > 0 ? rules.join(', ') : 'None';
}

function summarizeCorrectness(field: SurveyField): string {
  if (!field.correctness) {
    return 'Off';
  }
  switch (field.correctness.mode) {
    case 'text_exact':
      return 'Text exact';
    case 'single_select_exact':
      return 'Single exact';
    case 'multi_select_exact':
      return `Multi exact (${field.correctness.expectedOptionValues.length})`;
    case 'numeric_exact':
      return field.correctness.tolerance !== undefined
        ? `Numeric +/- ${field.correctness.tolerance}`
        : 'Numeric exact';
  }
}

function cloneTemplateFields(fields: SurveyField[]): SurveyField[] {
  return normalizeFieldOrder(
    fields.map((field) => ({
      ...field,
      options: field.options?.map((option) => ({ ...option })),
      validation: field.validation ? { ...field.validation } : undefined,
      correctness: field.correctness
        ? field.correctness.mode === 'multi_select_exact'
          ? { ...field.correctness, expectedOptionValues: [...field.correctness.expectedOptionValues] }
          : { ...field.correctness }
        : undefined,
    })),
  );
}

export function normalizeSurveyIdParam(rawSurveyId: string): string {
  return rawSurveyId.replace(/[{}]/g, '');
}

function SurveyBuilderRoutePage() {
  const { surveyId } = Route.useParams();
  return <SurveyBuilderView surveyId={normalizeSurveyIdParam(surveyId)} />;
}

export function SurveyBuilderView({ surveyId }: { surveyId: string }) {
  const survey = useQuery(convexApi.surveys.getSurveyDetail, { surveyId }) as SurveyDetail | null | undefined;
  const updateSurvey = useMutation(convexApi.surveys.updateSurvey);
  const createVersionDraft = useMutation(convexApi.surveys.createVersionDraft);
  const publishVersion = useMutation(convexApi.surveys.publishVersion);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [fields, setFields] = useState<SurveyField[]>([]);
  const [showProgressBar, setShowProgressBar] = useState(true);
  const [savingDraft, setSavingDraft] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editorTab, setEditorTab] = useState<EditorTab>('basics');
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);

  useEffect(() => {
    if (!survey) {
      return;
    }

    setTitle(survey.title);
    setDescription(survey.description ?? '');
    setFields(survey.currentVersion ? survey.currentVersion.fields : []);
    setShowProgressBar(survey.currentVersion?.settings.showProgressBar ?? true);
    setShowTemplatePicker(!survey.currentVersion);
    setEditingIndex(null);
  }, [survey?.surveyId, survey?.currentVersionId]);

  useEffect(() => {
    posthogCapture('admin_survey_builder_viewed', {
      surveyId,
      path: '/surveys/$surveyId/builder',
    });
  }, [surveyId]);

  const currentVersion = survey?.currentVersion;
  const latestVersion = useMemo(() => {
    if (!survey || survey.versions.length === 0) {
      return null;
    }
    return survey.versions[0];
  }, [survey]);

  const editingField = editingIndex === null ? null : fields[editingIndex] ?? null;

  const updateField = (index: number, updater: (field: SurveyField) => SurveyField) => {
    setFields((previous) => {
      const current = previous[index];
      if (!current) {
        return previous;
      }
      const next = [...previous];
      next[index] = updater(current);
      return normalizeFieldOrder(next);
    });
  };

  const setInfo = (message: string) => {
    setFeedbackMessage(message);
    setFeedbackError(null);
  };

  const setError = (message: string) => {
    setFeedbackError(message);
    setFeedbackMessage(null);
  };

  const onSaveMetadata = async () => {
    if (!survey) {
      return;
    }

    setFeedbackError(null);
    setFeedbackMessage(null);

    try {
      await updateSurvey({
        surveyId: survey.surveyId,
        title: title.trim() || survey.title,
        description: description.trim() || undefined,
      });

      setInfo('Metadata saved.');

      posthogCapture('survey_metadata_saved', {
        surveyId: survey.surveyId,
      });
    } catch (error) {
      setError(extractErrorMessage(error));
    }
  };

  const onAddField = () => {
    setFields((previous) => normalizeFieldOrder([...previous, buildDefaultField(previous.length)]));
    setInfo('Question added.');
  };

  const onSaveDraft = async () => {
    if (!survey) {
      return;
    }

    if (savingDraft) {
      setInfo('Draft save is already in progress.');
      return;
    }

    if (fields.length === 0) {
      setError('Add at least one question before saving a draft version.');
      return;
    }

    setFeedbackError(null);
    setFeedbackMessage(null);
    setSavingDraft(true);

    try {
      await createVersionDraft({
        surveyId: survey.surveyId,
        fields: normalizeFieldOrder(fields),
        settings: {
          title: title.trim() || survey.title,
          description: description.trim() || undefined,
          showProgressBar,
        },
      });

      setInfo('Draft version saved.');

      posthogCapture('survey_draft_saved', {
        surveyId: survey.surveyId,
        fieldCount: fields.length,
      });
    } catch (error) {
      setError(extractErrorMessage(error));
    } finally {
      setSavingDraft(false);
    }
  };

  const onPublishCurrent = async () => {
    if (!survey) {
      return;
    }

    if (publishing) {
      setInfo('Publish is already in progress.');
      return;
    }

    if (!latestVersion) {
      setError('Save a draft version before publishing.');
      return;
    }

    setFeedbackError(null);
    setFeedbackMessage(null);
    setPublishing(true);

    try {
      await publishVersion({
        surveyId: survey.surveyId,
        surveyVersionId: latestVersion.surveyVersionId,
      });

      setInfo(`Published version v${latestVersion.version}.`);

      posthogCapture('survey_publish_clicked', {
        surveyId: survey.surveyId,
        surveyVersionId: latestVersion.surveyVersionId,
      });
    } catch (error) {
      setError(extractErrorMessage(error));
    } finally {
      setPublishing(false);
    }
  };

  const onApplyTemplate = (templateKey: string) => {
    const template = surveyTemplates.find((entry) => entry.key === templateKey);
    if (!template) {
      setError('Template not found.');
      return;
    }

    setFields(cloneTemplateFields(template.fields));
    setShowTemplatePicker(false);
    setEditingIndex(null);
    setInfo(`${template.label} template applied.`);
  };

  if (survey === undefined) {
    return (
      <AdminShell heading="Survey Builder" description="Loading survey...">
        <p className="text-muted-foreground text-xs/relaxed">Loading survey details...</p>
      </AdminShell>
    );
  }

  if (!survey) {
    return (
      <AdminShell heading="Survey Builder" description="Survey not found">
        <p className="text-muted-foreground text-xs/relaxed">This survey does not exist or you no longer have access.</p>
      </AdminShell>
    );
  }

  return (
    <>
      <AdminShell heading={`Builder: ${survey.title}`} description={`Configure questions and publish versions for /${survey.slug}`}>
        <div className="mb-4 flex flex-wrap gap-2">
          <Link to="/surveys/$surveyId/invites" params={{ surveyId: survey.surveyId }}>
            <Button variant="outline" size="sm">Manage Invites</Button>
          </Link>
          <Link to="/surveys/$surveyId/analytics" params={{ surveyId: survey.surveyId }}>
            <Button variant="outline" size="sm">View Analytics</Button>
          </Link>
          <Badge variant="secondary">{fields.length} item(s)</Badge>
        </div>

        {showTemplatePicker ? (
          <Card className="mb-4">
            <CardHeader>
              <CardTitle>Start from a Template</CardTitle>
              <CardDescription>Choose a starter layout or begin blank. You can still edit everything afterward.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-3">
              {surveyTemplates.map((template) => (
                <button
                  key={template.key}
                  type="button"
                  className="hover:border-primary rounded-md border p-3 text-left transition-colors"
                  onClick={() => onApplyTemplate(template.key)}
                >
                  <p className="text-sm font-medium">{template.label}</p>
                  <p className="text-muted-foreground mt-1 text-xs/relaxed">{template.description}</p>
                </button>
              ))}
            </CardContent>
          </Card>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
          <Card>
            <CardHeader>
              <CardTitle>Survey Metadata</CardTitle>
              <CardDescription>Compact controls for title, description, and runner behavior.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Field>
                <FieldLabel>Title</FieldLabel>
                <Input value={title} onChange={(event) => setTitle(event.target.value)} />
              </Field>
              <Field>
                <FieldLabel>Description</FieldLabel>
                <Textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
              </Field>
              <label className="inline-flex items-center gap-2 text-xs/relaxed">
                <Checkbox checked={showProgressBar} onChange={(event) => setShowProgressBar(event.currentTarget.checked)} />
                Show progress bar to respondents
              </label>
              <Button variant="outline" size="sm" onClick={() => void onSaveMetadata()}>
                Save Metadata
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Questions</CardTitle>
              <CardDescription>
                Item-first editor with compact rows. Click Edit for full question settings and correctness rules.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {fields.length === 0 ? (
                <p className="text-muted-foreground text-xs/relaxed">No questions yet. Add your first item to begin.</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>#</TableHead>
                        <TableHead>ID</TableHead>
                        <TableHead>Label</TableHead>
                        <TableHead>Kind</TableHead>
                        <TableHead>Required</TableHead>
                        <TableHead>Validation</TableHead>
                        <TableHead>Correctness</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {fields.map((field, index) => (
                        <TableRow key={field.id}>
                          <TableCell>{index + 1}</TableCell>
                          <TableCell className="font-mono text-[11px]">{field.id}</TableCell>
                          <TableCell>{field.label}</TableCell>
                          <TableCell>{field.kind}</TableCell>
                          <TableCell>{field.required ? 'Yes' : 'No'}</TableCell>
                          <TableCell>{summarizeValidation(field)}</TableCell>
                          <TableCell>{summarizeCorrectness(field)}</TableCell>
                          <TableCell>
                            <div className="flex justify-end gap-1">
                              <Button variant="outline" size="sm" onClick={() => {
                                setEditingIndex(index);
                                setEditorTab('basics');
                              }}>
                                Edit
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setFields((previous) => moveField(previous, index, -1))}
                              >
                                Up
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setFields((previous) => moveField(previous, index, 1))}
                              >
                                Down
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setFields((previous) => normalizeFieldOrder(previous.filter((_, rowIndex) => rowIndex !== index)));
                                  if (editingIndex === index) {
                                    setEditingIndex(null);
                                  }
                                }}
                              >
                                Remove
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              <Button variant="outline" onClick={onAddField}>Add Item</Button>
            </CardContent>
            <CardFooter className="flex flex-col items-start gap-2">
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void onSaveDraft()}>
                  {savingDraft ? 'Saving Draft...' : 'Save Draft Version'}
                </Button>
                <Button variant="outline" onClick={() => void onPublishCurrent()}>
                  {publishing ? 'Publishing...' : 'Publish Latest Version'}
                </Button>
              </div>
              <p className="text-muted-foreground text-xs/relaxed">
                Latest version: {latestVersion ? `v${latestVersion.version}` : 'none'}
                {currentVersion ? ` | Active version: v${currentVersion.version}` : ''}
              </p>
              {feedbackMessage ? <p className="text-xs/relaxed text-emerald-700">{feedbackMessage}</p> : null}
              {feedbackError ? <p className="text-destructive text-xs/relaxed">{feedbackError}</p> : null}
            </CardFooter>
          </Card>
        </div>
      </AdminShell>

      {editingField ? (
        <>
          <button
            type="button"
            aria-label="Close item editor"
            className="fixed inset-0 z-40 bg-black/40"
            onClick={() => setEditingIndex(null)}
          />
          <aside className="bg-card fixed right-0 top-0 z-50 h-screen w-full max-w-xl overflow-y-auto border-l p-4 shadow-xl">
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold">Edit Item #{(editingIndex ?? 0) + 1}</h2>
                <p className="text-muted-foreground text-xs/relaxed">{editingField.label || 'Untitled question'}</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setEditingIndex(null)}>Close</Button>
            </div>

            <Tabs>
              <TabsList>
                <TabsTrigger active={editorTab === 'basics'} onClick={() => setEditorTab('basics')}>Basics</TabsTrigger>
                <TabsTrigger active={editorTab === 'validation'} onClick={() => setEditorTab('validation')}>Validation</TabsTrigger>
                <TabsTrigger active={editorTab === 'correctness'} onClick={() => setEditorTab('correctness')}>Correct Answer</TabsTrigger>
              </TabsList>

              <TabsContent className={editorTab === 'basics' ? '' : 'hidden'}>
                <div className="space-y-3 pt-1">
                  <Field>
                    <FieldLabel>Field ID</FieldLabel>
                    <Input
                      value={editingField.id}
                      onChange={(event) => {
                        const nextId = event.target.value;
                        updateField(editingIndex ?? 0, (current) => ({ ...current, id: nextId }));
                      }}
                    />
                  </Field>

                  <Field>
                    <FieldLabel>Question Label</FieldLabel>
                    <Input
                      value={editingField.label}
                      onChange={(event) => {
                        const nextLabel = event.target.value;
                        updateField(editingIndex ?? 0, (current) => ({ ...current, label: nextLabel }));
                      }}
                    />
                  </Field>

                  <Field>
                    <FieldLabel>Kind</FieldLabel>
                    <Select
                      value={editingField.kind}
                      onValueChange={(value) => {
                        const nextKind = value as FieldKind;
                        updateField(editingIndex ?? 0, (current) => {
                          const next: SurveyField = {
                            ...current,
                            kind: nextKind,
                            validation: undefined,
                            correctness: undefined,
                          };

                          if (nextKind === 'single_select' || nextKind === 'multi_select') {
                            next.options = current.options && current.options.length > 0
                              ? current.options
                              : [{ label: 'Option 1', value: 'option_1' }];
                          } else {
                            next.options = undefined;
                          }

                          return next;
                        });
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {fieldKinds.map((kind) => (
                          <SelectItem key={kind.value} value={kind.value}>{kind.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>

                  <label className="inline-flex items-center gap-2 text-xs/relaxed">
                    <Checkbox
                      checked={editingField.required}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        updateField(editingIndex ?? 0, (current) => ({ ...current, required: checked }));
                      }}
                    />
                    Required
                  </label>

                  <Field>
                    <FieldLabel>Placeholder</FieldLabel>
                    <Input
                      value={editingField.placeholder ?? ''}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        updateField(editingIndex ?? 0, (current) => ({ ...current, placeholder: nextValue }));
                      }}
                    />
                  </Field>

                  <Field>
                    <FieldLabel>Help text</FieldLabel>
                    <Textarea
                      rows={2}
                      value={editingField.helpText ?? ''}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        updateField(editingIndex ?? 0, (current) => ({ ...current, helpText: nextValue }));
                      }}
                    />
                  </Field>

                  {editingField.kind === 'single_select' || editingField.kind === 'multi_select' ? (
                    <Field>
                      <FieldLabel>Options</FieldLabel>
                      <div className="space-y-2 rounded-md border p-2">
                        {(editingField.options ?? []).map((option, optionIndex) => (
                          <div key={`${option.value}_${optionIndex}`} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                            <Input
                              value={option.label}
                              placeholder="Label"
                              onChange={(event) => {
                                const nextLabel = event.target.value;
                                updateField(editingIndex ?? 0, (current) => {
                                  const nextOptions = [...(current.options ?? [])];
                                  const existing = nextOptions[optionIndex];
                                  if (!existing) {
                                    return current;
                                  }
                                  nextOptions[optionIndex] = {
                                    ...existing,
                                    label: nextLabel,
                                    value: existing.value || toOptionValue(nextLabel),
                                  };
                                  return syncCorrectnessWithOptions({ ...current, options: nextOptions });
                                });
                              }}
                            />
                            <Input
                              value={option.value}
                              placeholder="value"
                              onChange={(event) => {
                                const nextValue = event.target.value;
                                updateField(editingIndex ?? 0, (current) => {
                                  const nextOptions = [...(current.options ?? [])];
                                  const existing = nextOptions[optionIndex];
                                  if (!existing) {
                                    return current;
                                  }
                                  nextOptions[optionIndex] = {
                                    ...existing,
                                    value: nextValue,
                                  };
                                  return syncCorrectnessWithOptions({ ...current, options: nextOptions });
                                });
                              }}
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                updateField(editingIndex ?? 0, (current) => {
                                  const nextOptions = (current.options ?? []).filter((_, index) => index !== optionIndex);
                                  return syncCorrectnessWithOptions({
                                    ...current,
                                    options: nextOptions,
                                  });
                                });
                              }}
                            >
                              Remove
                            </Button>
                          </div>
                        ))}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            updateField(editingIndex ?? 0, (current) => {
                              const nextOptions: OptionRow[] = [
                                ...(current.options ?? []),
                                {
                                  label: `Option ${(current.options?.length ?? 0) + 1}`,
                                  value: `option_${(current.options?.length ?? 0) + 1}`,
                                },
                              ];
                              return syncCorrectnessWithOptions({
                                ...current,
                                options: nextOptions,
                              });
                            });
                          }}
                        >
                          Add Option
                        </Button>
                      </div>
                      <FieldDescription>Use stable option values for reporting consistency.</FieldDescription>
                    </Field>
                  ) : null}
                </div>
              </TabsContent>

              <TabsContent className={editorTab === 'validation' ? '' : 'hidden'}>
                <div className="space-y-3 pt-1">
                  {(editingField.kind === 'short_text' || editingField.kind === 'long_text') ? (
                    <>
                      <Field>
                        <FieldLabel>Minimum length</FieldLabel>
                        <Input
                          type="number"
                          value={editingField.validation?.minLength ?? ''}
                          onChange={(event) => {
                            updateField(editingIndex ?? 0, (current) =>
                              withValidationValue(current, 'minLength', parseOptionalNumber(event.target.value)),
                            );
                          }}
                        />
                      </Field>
                      <Field>
                        <FieldLabel>Maximum length</FieldLabel>
                        <Input
                          type="number"
                          value={editingField.validation?.maxLength ?? ''}
                          onChange={(event) => {
                            updateField(editingIndex ?? 0, (current) =>
                              withValidationValue(current, 'maxLength', parseOptionalNumber(event.target.value)),
                            );
                          }}
                        />
                      </Field>
                      <Field>
                        <FieldLabel>Regex pattern</FieldLabel>
                        <Input
                          value={editingField.validation?.pattern ?? ''}
                          onChange={(event) => {
                            updateField(editingIndex ?? 0, (current) =>
                              withValidationValue(current, 'pattern', event.target.value.trim() || undefined),
                            );
                          }}
                        />
                      </Field>
                    </>
                  ) : null}

                  {(editingField.kind === 'number') ? (
                    <>
                      <Field>
                        <FieldLabel>Minimum value</FieldLabel>
                        <Input
                          type="number"
                          value={editingField.validation?.min ?? ''}
                          onChange={(event) => {
                            updateField(editingIndex ?? 0, (current) =>
                              withValidationValue(current, 'min', parseOptionalNumber(event.target.value)),
                            );
                          }}
                        />
                      </Field>
                      <Field>
                        <FieldLabel>Maximum value</FieldLabel>
                        <Input
                          type="number"
                          value={editingField.validation?.max ?? ''}
                          onChange={(event) => {
                            updateField(editingIndex ?? 0, (current) =>
                              withValidationValue(current, 'max', parseOptionalNumber(event.target.value)),
                            );
                          }}
                        />
                      </Field>
                    </>
                  ) : null}

                  {editingField.kind === 'rating_1_5' ? (
                    <p className="text-muted-foreground text-xs/relaxed">
                      Rating is fixed to 1-5 and cannot override min/max.
                    </p>
                  ) : null}

                  {editingField.kind !== 'short_text' &&
                  editingField.kind !== 'long_text' &&
                  editingField.kind !== 'number' &&
                  editingField.kind !== 'rating_1_5' ? (
                    <p className="text-muted-foreground text-xs/relaxed">No additional validation options for this field kind.</p>
                  ) : null}
                </div>
              </TabsContent>

              <TabsContent className={editorTab === 'correctness' ? '' : 'hidden'}>
                <div className="space-y-3 pt-1">
                  {!supportsCorrectness(editingField.kind) ? (
                    <p className="text-muted-foreground text-xs/relaxed">
                      Correct-answer grading is not supported for {editingField.kind} fields.
                    </p>
                  ) : (
                    <>
                      <label className="inline-flex items-center gap-2 text-xs/relaxed">
                        <Checkbox
                          checked={!!editingField.correctness}
                          onChange={(event) => {
                            const checked = event.currentTarget.checked;
                            updateField(editingIndex ?? 0, (current) => ({
                              ...current,
                              correctness: checked ? defaultCorrectnessForField(current) : undefined,
                            }));
                          }}
                        />
                        Configure correct answer for this field
                      </label>

                      {!editingField.correctness ? (
                        <p className="text-muted-foreground text-xs/relaxed">Enable correctness to configure expected answer rules.</p>
                      ) : (
                        <>
                          {editingField.correctness.mode === 'text_exact' ? (
                            <>
                              <Field>
                                <FieldLabel>Expected text</FieldLabel>
                                <Input
                                  value={editingField.correctness.expectedText}
                                  onChange={(event) => {
                                    const expectedText = event.target.value;
                                    updateField(editingIndex ?? 0, (current) => ({
                                      ...current,
                                      correctness:
                                        current.correctness?.mode === 'text_exact'
                                          ? {
                                              ...current.correctness,
                                              expectedText,
                                            }
                                          : current.correctness,
                                    }));
                                  }}
                                />
                                <FieldDescription>Graded with trim + case-insensitive matching.</FieldDescription>
                              </Field>
                            </>
                          ) : null}

                          {editingField.correctness.mode === 'single_select_exact' ? (
                            <Field>
                              <FieldLabel>Correct option</FieldLabel>
                              <Select
                                value={editingField.correctness.expectedOptionValue}
                                onValueChange={(value) => {
                                  if (!value) {
                                    return;
                                  }
                                  updateField(editingIndex ?? 0, (current) => ({
                                    ...current,
                                    correctness:
                                      current.correctness?.mode === 'single_select_exact'
                                        ? {
                                            ...current.correctness,
                                            expectedOptionValue: value,
                                          }
                                        : current.correctness,
                                  }));
                                }}
                              >
                                <SelectTrigger>
                                  <SelectValue placeholder="Choose correct option" />
                                </SelectTrigger>
                                <SelectContent>
                                  {(editingField.options ?? []).map((option) => (
                                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </Field>
                          ) : null}

                          {editingField.correctness.mode === 'multi_select_exact' ? (
                            <Field>
                              <FieldLabel>Correct option set</FieldLabel>
                              <div className="space-y-2 rounded-md border p-2">
                                {(editingField.options ?? []).map((option) => {
                                  const selected = editingField.correctness?.mode === 'multi_select_exact'
                                    ? editingField.correctness.expectedOptionValues.includes(option.value)
                                    : false;

                                  return (
                                    <label key={option.value} className="flex items-center gap-2 text-xs/relaxed">
                                      <Checkbox
                                        checked={selected}
                                        onChange={(event) => {
                                          const checked = event.currentTarget.checked;
                                          updateField(editingIndex ?? 0, (current) => {
                                            if (current.correctness?.mode !== 'multi_select_exact') {
                                              return current;
                                            }
                                            const set = new Set(current.correctness.expectedOptionValues);
                                            if (checked) {
                                              set.add(option.value);
                                            } else {
                                              set.delete(option.value);
                                            }
                                            return {
                                              ...current,
                                              correctness: {
                                                ...current.correctness,
                                                expectedOptionValues: Array.from(set),
                                              },
                                            };
                                          });
                                        }}
                                      />
                                      {option.label}
                                    </label>
                                  );
                                })}
                              </div>
                              <FieldDescription>Submission is correct only when selected options match this set exactly.</FieldDescription>
                            </Field>
                          ) : null}

                          {editingField.correctness.mode === 'numeric_exact' ? (
                            <>
                              <Field>
                                <FieldLabel>Expected number</FieldLabel>
                                <Input
                                  type="number"
                                  value={editingField.correctness.expectedNumber}
                                  onChange={(event) => {
                                    const expectedNumber = parseOptionalNumber(event.target.value) ?? 0;
                                    updateField(editingIndex ?? 0, (current) => ({
                                      ...current,
                                      correctness:
                                        current.correctness?.mode === 'numeric_exact'
                                          ? {
                                              ...current.correctness,
                                              expectedNumber,
                                            }
                                          : current.correctness,
                                    }));
                                  }}
                                />
                              </Field>
                              <Field>
                                <FieldLabel>Tolerance (optional)</FieldLabel>
                                <Input
                                  type="number"
                                  value={editingField.correctness.tolerance ?? ''}
                                  onChange={(event) => {
                                    updateField(editingIndex ?? 0, (current) => ({
                                      ...current,
                                      correctness:
                                        current.correctness?.mode === 'numeric_exact'
                                          ? {
                                              ...current.correctness,
                                              tolerance: parseOptionalNumber(event.target.value),
                                            }
                                          : current.correctness,
                                    }));
                                  }}
                                />
                                <FieldDescription>If blank, grading requires exact value match.</FieldDescription>
                              </Field>
                            </>
                          ) : null}
                        </>
                      )}
                    </>
                  )}
                </div>
              </TabsContent>
            </Tabs>
          </aside>
        </>
      ) : null}
    </>
  );
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null) {
    const nested = error as { data?: { message?: string }; message?: string };
    if (nested.data?.message) {
      return nested.data.message;
    }
    if (nested.message) {
      return nested.message;
    }
  }
  return 'Action failed. Please retry.';
}
