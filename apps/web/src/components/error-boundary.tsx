import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AlertTriangle } from 'lucide-react';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Log to console — could be sent to Sentry/etc. later
    // eslint-disable-next-line no-console
    console.error('ErrorBoundary caught:', error);
  }

  private handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-[var(--color-destructive)]" aria-hidden />
              <CardTitle>Something went wrong</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4" role="alert">
            <p className="text-sm">
              The page ran into an error and couldn't finish rendering.
            </p>
            {import.meta.env.DEV && (
              <details className="text-xs text-[var(--color-muted-foreground)]">
                <summary className="cursor-pointer font-medium">Error details (dev)</summary>
                <pre className="mt-2 whitespace-pre-wrap break-words">
                  {this.state.error.message}
                  {'\n\n'}
                  {this.state.error.stack}
                </pre>
              </details>
            )}
            <div className="flex gap-2">
              <Button onClick={this.handleRetry}>Retry</Button>
              <Button variant="outline" onClick={() => window.location.reload()}>
                Reload page
              </Button>
            </div>
          </CardContent>
        </Card>
      );
    }
    return this.props.children;
  }
}
