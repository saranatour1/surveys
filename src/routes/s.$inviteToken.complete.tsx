import { createFileRoute, Link } from '@tanstack/react-router';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export const Route = createFileRoute('/s/$inviteToken/complete')({
  component: SurveyCompletePage,
});

function SurveyCompletePage() {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-xl items-center px-4 py-8">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Thanks for your response</CardTitle>
          <CardDescription>Your survey response was saved successfully.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-xs/relaxed">
            This invite is configured for one completion by default. If you need to update your response, contact the survey owner.
          </p>
        </CardContent>
        <CardFooter>
          <Link to="/">
            <Button variant="outline">Return to Home</Button>
          </Link>
        </CardFooter>
      </Card>
    </div>
  );
}
