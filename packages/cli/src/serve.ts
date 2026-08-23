/**
 * `tsk serve` — serve the Task-System web app backed by a real Markdown file.
 *
 * Design notes (what could go wrong, and how this handles it):
 *
 *  - Atomic writes: the file is written via `writeTextAtomic` (temp + rename),
 *    so a crash mid-write never leaves a half-written file.
 *  - Conflicts / external edits: every response carries an `etag` (a hash of
 *    the current file content). A client PUT includes `If-Match: <etag>`; if
 *    the file changed since the client last read it (e.g. edited in Obsidian),
 *    the server returns 409 with the current text so the client can reload
 *    rather than silently clobber the external edit.
 *  - Localhost-only: the server binds to 127.0.0.1, so the file is never
 *    exposed to the network.
 *  - Static path safety: requests are resolved under `webRoot` and rejected if
 *    they escape it (no directory traversal).
 *  - Missing file: the CLI creates an empty document before serving.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, emptyDocument, parse } from '@task-system/core';
import { readText, writeTextAtomic } from './io.js';

export interface ServeOptions {
  /** Absolute path to the Markdown file to back the app. */
  filePath: string;
  /** Directory containing the built web app (index.html + assets). */
  webRoot: string;
  /** Port to listen on. 0 picks a free port (used by tests). */
  port?: number;
  host?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function etagOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

export function createServeHandler(opts: ServeOptions) {
  const webRoot = resolve(opts.webRoot);

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    // ---- /doc API ----
    if (pathname === '/doc') {
      if (req.method === 'GET') {
        const text = readText(opts.filePath);
        if (url.searchParams.has('meta')) {
          sendJson(res, 200, { etag: etagOf(text) });
        } else {
          sendJson(res, 200, { text, etag: etagOf(text), name: basename(opts.filePath) });
        }
        return;
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        const current = readText(opts.filePath);
        const currentEtag = etagOf(current);
        const ifMatch = req.headers['if-match'];
        // Require the client to have read the current version first; otherwise
        // a blind write could clobber a concurrent edit.
        if (!ifMatch || ifMatch !== currentEtag) {
          sendJson(res, 409, { error: 'conflict', text: current, etag: currentEtag });
          return;
        }
        writeTextAtomic(opts.filePath, body);
        sendJson(res, 200, { etag: etagOf(body) });
        return;
      }
      res.statusCode = 405;
      res.end();
      return;
    }

    // ---- static assets (the built web app) ----
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1).replace(/^\/+/, '');
    const target = resolve(webRoot, relative);
    if (!(target === webRoot || target.startsWith(webRoot + sep))) {
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }
    try {
      const data = readFileSync(target);
      res.setHeader(
        'content-type',
        CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
      );
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  };
}

export interface StartedServer {
  server: Server;
  port: number;
  url: string;
}

/** Start the server and resolve once it is listening. */
export function startServe(opts: ServeOptions): Promise<StartedServer> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer(createServeHandler(opts));
    const host = opts.host ?? '127.0.0.1';
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(`Port ${opts.port ?? 4173} is already in use. Use --port to pick another.`),
        );
      } else {
        reject(err);
      }
    });
    server.listen(opts.port ?? 4173, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 4173);
      resolvePromise({ server, port, url: `http://${host}:${port}` });
    });
  });
}

/** Resolve the built web app directory relative to this package's location. */
export function resolveWebRoot(): string {
  return fileURLToPath(new URL('../../../apps/web/dist', import.meta.url));
}

/** The repo root, derived from `<root>/apps/web/dist`. */
function repoRootOf(webRoot: string): string {
  return resolve(webRoot, '..', '..', '..');
}

export type ServePrepResult = 'created' | 'formatted' | 'unchanged';

/**
 * Prepare the served file: create it (with an empty document) if missing, and
 * optionally canonicalize it (sort into sections) before the app loads. Returns
 * what happened so the caller can tell the user. Uses atomic writes.
 */
export function prepareServeFile(filePath: string, formatFile: boolean): ServePrepResult {
  if (!existsSync(filePath)) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeTextAtomic(filePath, format(emptyDocument()));
    return 'created';
  }
  if (!formatFile) return 'unchanged';
  const before = readText(filePath);
  const canonical = format(parse(before));
  if (canonical === before) return 'unchanged';
  writeTextAtomic(filePath, canonical);
  return 'formatted';
}

function newestMtime(dir: string): number {
  let max = 0;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    max = Math.max(max, st.isDirectory() ? newestMtime(p) : st.mtimeMs);
  }
  return max;
}

/**
 * Whether the web app needs rebuilding: no index.html, or any source file is
 * newer than the current build output.
 */
export function needsRebuild(webRoot: string): boolean {
  if (!existsSync(join(webRoot, 'index.html'))) return true;
  const src = join(repoRootOf(webRoot), 'apps', 'web', 'src');
  if (!existsSync(src)) return true;
  return newestMtime(src) > newestMtime(webRoot);
}

/**
 * Build the web app if it is missing or stale. Prints progress so the caller
 * knows the server is building rather than hung. Throws if the build fails.
 */
export async function ensureWebBuilt(webRoot: string): Promise<void> {
  if (!needsRebuild(webRoot)) return;
  const root = repoRootOf(webRoot);
  console.log('Building the web app (first run or source changed)…');
  await new Promise<void>((resolvePromise, reject) => {
    // shell:true resolves npm/npm.cmd on Windows. The command string is fixed
    // and fully controlled, so there is no injection concern.
    const child = spawn('npm run build', { cwd: root, stdio: 'inherit', shell: true });
    child.on('error', (err) => reject(new Error(`could not run build: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(
            `web app build failed (exit ${code ?? 'signal'}). Check node_modules are installed.`,
          ),
        );
    });
  });
  console.log('Web app built.');
}
