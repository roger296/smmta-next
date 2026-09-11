import { API_BASE_URL } from '@/lib/api-client';
import { getToken } from '@/lib/auth';

/**
 * Opens a PDF served by an authenticated API route in a new tab.
 *
 * The route needs the admin's token, which a plain link cannot send, so the
 * file is fetched and handed to the browser as a blob. The tab is opened BEFORE
 * the fetch, while still inside the click, because browsers block a
 * window.open that happens after an await.
 */
export async function openAuthedPdf(path: string, what: string): Promise<void> {
  const tab = window.open('about:blank', '_blank');
  try {
    const base = API_BASE_URL.startsWith('http') ? API_BASE_URL : `${window.location.origin}${API_BASE_URL}`;
    const token = getToken();
    const res = await fetch(`${base}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Could not load the ${what} (status ${res.status})`);
    const url = URL.createObjectURL(await res.blob());
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
