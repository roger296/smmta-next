import { API_BASE_URL } from '@/lib/api-client';
import { getToken } from '@/lib/auth';

/**
 * PDFs served by authenticated API routes.
 *
 * The routes need the admin's token, which a plain link cannot send, so the
 * file is fetched with it and handed to the browser as a blob.
 */
export async function fetchAuthedPdf(path: string, what: string): Promise<Blob> {
  const base = API_BASE_URL.startsWith('http') ? API_BASE_URL : `${window.location.origin}${API_BASE_URL}`;
  const token = getToken();
  const res = await fetch(`${base}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Could not load the ${what} (status ${res.status})`);
  return res.blob();
}

/**
 * Opens a PDF in a new tab. The tab is opened BEFORE the fetch, while still
 * inside the click, because browsers block a window.open that happens after an
 * await.
 */
export async function openAuthedPdf(path: string, what: string): Promise<void> {
  const tab = window.open('about:blank', '_blank');
  try {
    const url = URL.createObjectURL(await fetchAuthedPdf(path, what));
    if (tab) {
      tab.location.href = url;
    } else {
      window.location.assign(url);
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    tab?.close();
    throw err;
  }
}

/**
 * Loads a PDF into a hidden frame and opens the browser's print dialog for it,
 * so it prints as one document without leaving the page. Where a browser will
 * not print a PDF from a frame, the PDF opens in a tab instead, which has its
 * own print button.
 */
export async function printAuthedPdf(path: string, what: string): Promise<void> {
  const url = URL.createObjectURL(await fetchAuthedPdf(path, what));
  const frame = document.createElement('iframe');
  Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
  frame.src = url;
  document.body.appendChild(frame);
  await new Promise<void>((resolve) => {
    frame.onload = () => resolve();
  });
  try {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
  } catch {
    window.open(url, '_blank');
  }
  // Left in place long enough for the print dialog to finish with it.
  setTimeout(() => {
    frame.remove();
    URL.revokeObjectURL(url);
  }, 300_000);
}
