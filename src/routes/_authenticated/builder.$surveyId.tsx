import { createFileRoute } from '@tanstack/react-router';
import { SurveyBuilderView, normalizeSurveyIdParam } from './surveys.$surveyId.builder';

export const Route = createFileRoute('/_authenticated/builder/$surveyId')({
  component: StandaloneBuilderRoutePage,
});

function StandaloneBuilderRoutePage() {
  const { surveyId } = Route.useParams();
  return <SurveyBuilderView surveyId={normalizeSurveyIdParam(surveyId)} />;
}
