import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorBoundary } from './error-boundary';

function Bomb(): React.ReactElement {
  throw new Error('Boom');
}

describe('ErrorBoundary', () => {
  it('renders children normally when no error', () => {
    render(
      <ErrorBoundary>
        <p>Hello</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('renders fallback when a child throws', () => {
    // Suppress React's "uncaught error" console noise
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(
        <ErrorBoundary>
          <Bomb />
        </ErrorBoundary>,
      );
      expect(screen.getByRole('alert')).toHaveTextContent(/ran into an error/i);
      expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('retry button clears the error', async () => {
    const user = userEvent.setup();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // After first render, the component stores error state.
      // Clicking Retry resets state; remount would succeed if the throwing child is removed.
      let shouldThrow = true;
      function MaybeBomb() {
        if (shouldThrow) throw new Error('Boom');
        return <p>Recovered</p>;
      }
      const { rerender } = render(
        <ErrorBoundary>
          <MaybeBomb />
        </ErrorBoundary>,
      );
      expect(screen.getByRole('alert')).toBeInTheDocument();

      shouldThrow = false;
      await user.click(screen.getByRole('button', { name: /retry/i }));
      rerender(
        <ErrorBoundary>
          <MaybeBomb />
        </ErrorBoundary>,
      );
      expect(screen.getByText('Recovered')).toBeInTheDocument();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
