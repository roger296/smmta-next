import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './globals.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Register the PWA service worker (iPad install + offline shell, spec §A1).
// Dev keeps it off so HMR isn't intercepted.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // best-effort — the SPA works without the SW
    });
  });
}
