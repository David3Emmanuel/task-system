import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Document source hook.
 *
 * Two modes:
 *  - "file": the app was served by `tsk serve <file>`. On mount it fetches the
 *    real file from `/doc`, and every text change is saved back (debounced) with
 *    an `If-Match` etag so an external edit (e.g. in Obsidian) can't be
 *    silently clobbered — a conflict reloads the file.
 *  - "demo": no `/doc` endpoint (plain `npm run dev` / static host). Falls back
 *    to the in-memory sample + localStorage.
 */

interface DocResponse {
  text: string;
  etag: string;
  name?: string;
}

export type DocMode = 'loading' | 'file' | 'demo';

const SAVE_DELAY = 350;
const POLL_MS = 2500;

async function getDoc(metaOnly: boolean): Promise<DocResponse> {
  const res = await fetch(`/doc${metaOnly ? '?meta=1' : ''}`);
  if (!res.ok) throw new Error(`/doc ${res.status}`);
  const data = await res.json();
  if (typeof data.text !== 'string' && typeof data.etag !== 'string') {
    throw new Error('unexpected /doc response');
  }
  return data;
}

export function useDocument(fallback: string) {
  const [text, setText] = useState<string>(fallback);
  const [mode, setMode] = useState<DocMode>('loading');
  const [notice, setNotice] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const textRef = useRef(text);
  textRef.current = text;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const etagRef = useRef<string | null>(null);
  const lastSavedRef = useRef(fallback);
  const saveTimer = useRef<number | null>(null);

  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 3500);
  }, []);

  const adopt = useCallback((doc: DocResponse) => {
    setText(doc.text);
    lastSavedRef.current = doc.text;
    etagRef.current = doc.etag;
    if (doc.name) setFileName(doc.name);
  }, []);

  const doSave = useCallback(async () => {
    const current = textRef.current;
    try {
      const res = await fetch('/doc', {
        method: 'PUT',
        headers: { 'content-type': 'text/plain', 'if-match': etagRef.current ?? '' },
        body: current,
      });
      if (res.status === 409) {
        // File changed elsewhere — reload rather than overwrite.
        const currentOnDisk = (await res.json()) as DocResponse;
        adopt(currentOnDisk);
        showNotice('File changed on disk — reloaded the latest version.');
        return;
      }
      if (res.ok) {
        const data = (await res.json()) as { etag: string };
        etagRef.current = data.etag;
        lastSavedRef.current = current;
      }
    } catch {
      // offline / transient; leave it to the next change or poll.
    }
  }, [adopt, showNotice]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void doSave(), SAVE_DELAY);
  }, [doSave]);

  const updateText = useCallback(
    (t: string) => {
      setText(t);
      if (modeRef.current === 'file') scheduleSave();
    },
    [scheduleSave],
  );

  // Detect mode on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const doc = await getDoc(false);
        if (cancelled) return;
        adopt(doc);
        setMode('file');
      } catch {
        if (!cancelled) setMode('demo');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adopt]);

  // Poll for external changes; adopt only when there are no unsaved edits.
  useEffect(() => {
    if (mode !== 'file') return;
    const id = window.setInterval(() => {
      void (async () => {
        try {
          const meta = await getDoc(true);
          if (meta.etag === etagRef.current) return;
          if (lastSavedRef.current !== textRef.current) return; // unsaved edits pending
          const full = await getDoc(false);
          adopt(full);
          showNotice('File updated from disk.');
        } catch {
          /* ignore */
        }
      })();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [mode, adopt, showNotice]);

  return { text, mode, notice, fileName, updateText };
}
