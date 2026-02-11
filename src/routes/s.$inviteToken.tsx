import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { convexApi } from '@/lib/convex-api';
import { getOrCreateRespondentKey, type SurveyField } from '@/lib/survey';
import { posthogCapture } from '@/lib/posthog';

export const Route = createFileRoute('/s/$inviteToken')({
  component: SurveyRespondentPage,
});

type ResolvedInvite = {
  inviteState: 'active' | 'invalid' | 'revoked' | 'expired' | 'exhausted';
  survey: { surveyId: string; title: string; description?: string; slug: string } | null;
  version:
    | {
        surveyVersionId: string;
        version: number;
        fields: SurveyField[];
        settings?: {
          title?: string;
          description?: string;
          showProgressBar?: boolean;
        };
      }
    | null;
  invite: { inviteId: string; completionCount: number; maxCompletions: number; expiresAt?: number } | null;
};

type SessionSnapshot = {
  sessionPublicId: string;
  status: 'in_progress' | 'idle' | 'abandoned' | 'completed';
  surveyId: string;
  surveyVersionId: string;
  answersDraft: Record<string, string | number | boolean | string[] | null>;
  startedAt: number;
  lastActivityAt: number;
  completedAt?: number;
};

function inviteUnavailableReason(state: ResolvedInvite['inviteState']) {
  switch (state) {
    case 'expired':
      return 'This invite has expired.';
    case 'revoked':
      return 'This invite was revoked by the survey owner.';
    case 'exhausted':
      return 'This invite has reached its maximum completion limit.';
    case 'invalid':
    default:
      return 'Invite token is invalid.';
  }
}

function getStoredSessionId(inviteToken: string) {
  if (typeof window === 'undefined') {
    return null;
  }
  return window.localStorage.getItem(`survey:session:${inviteToken}`);
}

function setStoredSessionId(inviteToken: string, sessionPublicId: string) {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(`survey:session:${inviteToken}`, sessionPublicId);
}

function SurveyRespondentPage() {
  const navigate = useNavigate();
  const { inviteToken } = Route.useParams();

  const resolved = useQuery(convexApi.respondent.resolveInvite, {
    inviteToken,
  }) as ResolvedInvite | undefined;

  const startOrResumeSession = useMutation(convexApi.respondent.startOrResumeSession);
  const saveAnswer = useMutation(convexApi.respondent.saveAnswer);
  const submitSession = useMutation(convexApi.respondent.submitSession);

  const [respondentKey, setRespondentKey] = useState<string | null>(null);
  const [sessionPublicId, setSessionPublicId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string | number | boolean | string[] | null>>({});
  const [savingFieldId, setSavingFieldId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setRespondentKey(getOrCreateRespondentKey());
    const prior = getStoredSessionId(inviteToken);
    if (prior) {
      setSessionPublicId(prior);
    }
  }, [inviteToken]);

  const session = useQuery(
    convexApi.respondent.getSessionSnapshot,
    sessionPublicId
      ? {
          sessionPublicId,
        }
      : 'skip',
  ) as SessionSnapshot | null | undefined;

  useEffect(() => {
    if (session?.answersDraft) {
      setAnswers(session.answersDraft);
    }
  }, [session?.sessionPublicId, session?.lastActivityAt]);

  const fields = useMemo(() => {
    if (!resolved?.version?.fields) {
      return [];
    }
    return [...resolved.version.fields].sort((a, b) => a.order - b.order);
  }, [resolved?.version?.fields]);

  const answeredCount = useMemo(
    () =>
      fields.filter((field) => {
        const value = answers[field.id];
        if (value === undefined || value === null) return false;
        if (typeof value === 'string') return value.trim().length > 0;
        if (Array.isArray(value)) return value.length > 0;
        return true;
      }).length,
    [answers, fields],
  );

  const questionCount = fields.length;
  const progressPercent = questionCount === 0 ? 0 : Math.round((answeredCount / questionCount) * 100);

  const onStartOrResume = async () => {
    if (!respondentKey) {
      return;
    }

    const result = (await startOrResumeSession({
      inviteToken,
      respondentKey,
      priorSessionId: getStoredSessionId(inviteToken) ?? undefined,
    })) as {
      sessionPublicId: string;
      status: 'in_progress' | 'idle' | 'abandoned' | 'completed';
      progress: { progressPercent: number };
    };

    setSessionPublicId(result.sessionPublicId);
    setStoredSessionId(inviteToken, result.sessionPublicId);

    posthogCapture('respondent_session_started_or_resumed', {
      sessionPublicId: result.sessionPublicId,
      inviteToken,
      progressPercent: result.progress.progressPercent,
    });
  };

  const persistField = async (
    field: SurveyField,
    value: string | number | boolean | string[] | null,
  ) => {
    if (!sessionPublicId) {
      return;
    }

    setSavingFieldId(field.id);
    try {
      await saveAnswer({
        sessionPublicId,
        fieldId: field.id,
        value,
      });

      posthogCapture('respondent_answer_saved_ui', {
        sessionPublicId,
        fieldId: field.id,
      });
    } finally {
      setSavingFieldId((current) => (current === field.id ? null : current));
    }
  };

  const onSubmit = async () => {
    if (!sessionPublicId) {
      return;
    }

    setSubmitting(true);
    try {
      await submitSession({
        sessionPublicId,
      });

      posthogCapture('respondent_submitted_ui', {
        sessionPublicId,
      });

      void navigate({
        to: '/s/$inviteToken/complete',
        params: { inviteToken },
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto min-h-screen w-full max-w-3xl px-4 py-8">
      {resolved === undefined ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground text-xs/relaxed">Loading invite...</p>
          </CardContent>
        </Card>
      ) : resolved.inviteState !== 'active' || !resolved.survey || !resolved.version ? (
        <Card>
          <CardHeader>
            <CardTitle>Invite unavailable</CardTitle>
            <CardDescription>{inviteUnavailableReason(resolved.inviteState)}</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{resolved.version.settings?.title ?? resolved.survey.title}</CardTitle>
            <CardDescription>{resolved.version.settings?.description ?? resolved.survey.description}</CardDescription>
          </CardHeader>

          {!sessionPublicId || !session ? (
            <CardContent>
              <p className="text-muted-foreground mb-3 text-xs/relaxed">
                This survey is invite-only and anonymous. You can resume on this device until submission.
              </p>
              <Button onClick={() => void onStartOrResume()}>
                Start or Resume Survey
              </Button>
            </CardContent>
          ) : (
            <>
              {resolved.version.settings?.showProgressBar !== false ? (
                <CardContent className="pb-0">
                  <div className="mb-2 flex items-center justify-between text-xs/relaxed">
                    <span>Progress</span>
                    <span>{progressPercent}%</span>
                  </div>
                  <div className="bg-muted h-2 w-full rounded-full">
                    <div className="bg-primary h-2 rounded-full" style={{ width: `${progressPercent}%` }} />
                  </div>
                </CardContent>
              ) : null}

              <CardContent className="space-y-4 pt-4">
                {fields.map((field) => (
                  <div key={field.id} className="rounded-md border p-3">
                    <Field>
                      <FieldLabel>
                        {field.label}
                        {field.required ? ' *' : ''}
                      </FieldLabel>
                      {field.helpText ? <FieldDescription>{field.helpText}</FieldDescription> : null}

                      <FieldInput
                        field={field}
                        value={answers[field.id]}
                        onChange={(value) => {
                          setAnswers((previous) => ({
                            ...previous,
                            [field.id]: value,
                          }));
                        }}
                        onBlur={(value) => {
                          void persistField(field, value);
                        }}
                      />

                      {savingFieldId === field.id ? (
                        <p className="text-muted-foreground text-[11px]">Saving...</p>
                      ) : null}
                    </Field>
                  </div>
                ))}
              </CardContent>
              <CardFooter className="flex items-center justify-between">
                <p className="text-muted-foreground text-xs/relaxed">
                  Session: <span className="font-mono text-[11px]">{session.sessionPublicId}</span>
                </p>
                <Button disabled={submitting} onClick={() => void onSubmit()}>
                  {submitting ? 'Submitting...' : 'Submit Survey'}
                </Button>
              </CardFooter>
            </>
          )}
        </Card>
      )}
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
  onBlur,
}: {
  field: SurveyField;
  value: string | number | boolean | string[] | null | undefined;
  onChange: (value: string | number | boolean | string[] | null) => void;
  onBlur: (value: string | number | boolean | string[] | null) => void;
}) {
  if (field.kind === 'long_text') {
    return (
      <Textarea
        rows={4}
        value={typeof value === 'string' ? value : ''}
        placeholder={field.placeholder}
        onChange={(event) => onChange(event.target.value)}
        onBlur={(event) => onBlur(event.target.value)}
      />
    );
  }

  if (field.kind === 'single_select' && field.options) {
    return (
      <RadioGroup>
        {field.options.map((option) => (
          <label key={option.value} className="flex items-center gap-2 text-xs/relaxed">
            <RadioGroupItem
              name={field.id}
              checked={value === option.value}
              onChange={() => {
                onChange(option.value);
                onBlur(option.value);
              }}
            />
            {option.label}
          </label>
        ))}
      </RadioGroup>
    );
  }

  if (field.kind === 'multi_select' && field.options) {
    const selectedValues = Array.isArray(value) ? value : [];

    return (
      <div className="flex flex-col gap-2">
        {field.options.map((option) => (
          <label key={option.value} className="flex items-center gap-2 text-xs/relaxed">
            <Checkbox
              checked={selectedValues.includes(option.value)}
              onChange={(event) => {
                const next = event.currentTarget.checked
                  ? [...selectedValues, option.value]
                  : selectedValues.filter((entry) => entry !== option.value);
                onChange(next);
                onBlur(next);
              }}
            />
            {option.label}
          </label>
        ))}
      </div>
    );
  }

  if (field.kind === 'rating_1_5') {
    const current = typeof value === 'number' ? value : 0;
    return (
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((rating) => (
          <button
            key={rating}
            type="button"
            className={`rounded-md border px-3 py-1 text-xs/relaxed ${current === rating ? 'bg-primary text-primary-foreground' : ''}`}
            onClick={() => {
              onChange(rating);
              onBlur(rating);
            }}
          >
            {rating}
          </button>
        ))}
      </div>
    );
  }

  if (field.kind === 'number') {
    return (
      <Input
        type="number"
        value={typeof value === 'number' ? String(value) : ''}
        placeholder={field.placeholder}
        onChange={(event) => onChange(Number(event.target.value))}
        onBlur={(event) => onBlur(Number(event.target.value))}
      />
    );
  }

  return (
    <Input
      type={field.kind === 'email' ? 'email' : field.kind === 'date' ? 'date' : 'text'}
      value={typeof value === 'string' ? value : ''}
      placeholder={field.placeholder}
      onChange={(event) => onChange(event.target.value)}
      onBlur={(event) => onBlur(event.target.value)}
    />
  );
}
