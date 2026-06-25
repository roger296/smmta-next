import { useState } from 'react';
import { StartScreen } from './screens/StartScreen';
import { CountScreen } from './screens/CountScreen';
import { ConsolidateScreen } from './screens/ConsolidateScreen';
import { loadSession, saveSession } from './lib/storage';
import type { Session } from './lib/types';

type View = 'start' | 'count' | 'consolidate';

function initialView(session: Session | null): View {
  if (typeof location !== 'undefined' && location.hash.includes('consolidate')) return 'consolidate';
  return session ? 'count' : 'start';
}

export default function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [view, setView] = useState<View>(() => initialView(loadSession()));

  if (view === 'consolidate') {
    return (
      <ConsolidateScreen
        initialCode={session?.accessCode ?? ''}
        onExit={() => setView(session ? 'count' : 'start')}
      />
    );
  }

  if (view === 'count' && session) {
    return <CountScreen session={session} onExit={() => setView('start')} />;
  }

  return (
    <StartScreen
      initial={session}
      onStart={(s) => {
        saveSession(s);
        setSession(s);
        setView('count');
      }}
      onOpenAdmin={() => setView('consolidate')}
    />
  );
}
