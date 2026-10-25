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
 *
 * The hook also reports what the UI must not hide: which mode is active, why a
 * demo fallback happened, and the state of the current save.
 */

interface DocResponse {
  text: string;
  etag: string;
  name?: string;
}

export type DocMode = 'loading' | 'file' | 'demo';
export type SaveState = 'idle' | 'saving' | 'saved' | 'error';
export type DemoCause = 'no-server' | 'unreachable' | null;

const SAVE_DELAY = 350;
const POLL_MS = 2500;

/** A `/doc` failure, classified so the UI can say *why* it fell back. */
class DocError extends Error {
  constructor(
    readonly kind: 'no-server' | 'unreachable',
    message: string,
  ) {
    super(message);
  }
}

async function getDoc(metaOnly: boolean): Promise<DocResponse> {
  let res: Response;
  try {
    res = await fetch(`/doc${metaOnly ? '?meta=1' : ''}`);
  } catch {
    throw new DocError('unreachable', 'could not reach /doc');
  }
  if (!res.ok) throw new DocError('no-server', `/doc ${res.status}`);
  const data = await res.json();
  if (typeof data.text !== 'string' && typeof data.etag !== 'string') {
    throw new DocError('no-server', 'unexpected /doc response');
  }
  return data;
}

function causeOf(err: unknown): 'no-server' | 'unreachable' {
  return err instanceof DocError ? err.kind : 'no-server';
}

export function useDocument(fallback: string) {
  const [text, setText] = useState<string>(fallback);
  const [mode, setMode] = useState<DocMode>('loading');
  const [demoCause, setDemoCause] = useState<DemoCause>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
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

  const doSave = useCallback(
    async (opts?: { keepalive?: boolean }) => {
      const current = textRef.current;
      setSaveState('saving');
      try {
        const res = await fetch('/doc', {
          method: 'PUT',
          headers: { 'content-type': 'text/plain', 'if-match': etagRef.current ?? '' },
          body: current,
          keepalive: opts?.keepalive,
        });
        if (res.status === 409) {
          // File changed elsewhere — reload rather than overwrite.
          const currentOnDisk = (await res.json()) as DocResponse;
          adopt(currentOnDisk);
          showNotice('File changed on disk — reloaded the latest version.');
          setSaveState('idle');
          return;
        }
        if (!res.ok) throw new Error(`/doc ${res.status}`);
        const data = (await res.json()) as { etag: string };
        etagRef.current = data.etag;
        lastSavedRef.current = current;
        setSaveState('saved');
      } catch {
        // Surface it: a silent failure is how edits get lost.
        setSaveState('error');
      }
    },
    [adopt, showNotice],
  );

  const scheduleSave = useCallback(() => {
    setSaveState('saving');
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
        setDemoCause(null);
        setSaveState('idle');
        setMode('file');
      } catch (err) {
        if (!cancelled) {
          setDemoCause(causeOf(err));
          setMode('demo');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adopt]);

  // Flush a pending edit when the page is hidden or unloaded.
  useEffect(() => {
    if (mode !== 'file') return;
    const flush = () => {
      if (modeRef.current !== 'file') return;
      if (lastSavedRef.current === textRef.current) return;
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      void doSave({ keepalive: true });
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [mode, doSave]);

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

  /** Reconnect after a demo fallback. */
  const retry = useCallback(() => {
    setMode('loading');
    void (async () => {
      try {
        const doc = await getDoc(false);
        adopt(doc);
        setDemoCause(null);
        setSaveState('idle');
        setMode('file');
      } catch (err) {
        setDemoCause(causeOf(err));
        setMode('demo');
      }
    })();
  }, [adopt]);

  /** Re-run a failed save. */
  const retrySave = useCallback(() => void doSave(), [doSave]);

  return { text, mode, notice, fileName, updateText, saveState, demoCause, retry, retrySave };
}
