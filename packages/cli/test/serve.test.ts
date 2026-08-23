import { expect, test, describe, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServe, createServeHandler, needsRebuild, type StartedServer } from '../src/serve.js';

const running: StartedServer[] = [];

async function withServer(
  fileContent: string,
  extra: { staticFile?: string; staticContent?: string } = {},
): Promise<{ base: string; file: string; server: StartedServer }> {
  const dir = mkdtempSync(join(tmpdir(), 'tsk-serve-'));
  const file = join(dir, 'tasks.md');
  writeFileSync(file, fileContent);
  if (extra.staticFile) writeFileSync(join(dir, extra.staticFile), extra.staticContent ?? '');
  const server = await startServe({ filePath: file, webRoot: dir, port: 0 });
  running.push(server);
  const addr = server.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { base: `http://127.0.0.1:${port}`, file, server };
}

afterAll(() => {
  for (const s of running) s.server.close();
});

describe('tsk serve /doc', () => {
  test('GET returns the file text, an etag, and the basename', async () => {
    const { base, file } = await withServer('# T\n\n- [ ] A\n');
    const res = await fetch(`${base}/doc`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toBe('# T\n\n- [ ] A\n');
    expect(body.name).toBe('tasks.md');
    expect(typeof body.etag).toBe('string');
    expect(file).toBeTruthy();
  });

  test('GET ?meta=1 returns only the etag (lightweight polling)', async () => {
    const { base } = await withServer('# T\n');
    const res = await fetch(`${base}/doc?meta=1`);
    const body = await res.json();
    expect(body.text).toBeUndefined();
    expect(typeof body.etag).toBe('string');
  });

  test('PUT with a matching If-Match writes the file atomically', async () => {
    const { base, file } = await withServer('# T\n');
    const { etag } = await (await fetch(`${base}/doc`)).json();
    const res = await fetch(`${base}/doc`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain', 'if-match': etag },
      body: '# T\n\n- [ ] New 📅 2026-03-01\n',
    });
    expect(res.status).toBe(200);
    expect(readFileSync(file, 'utf8')).toContain('- [ ] New 📅 2026-03-01');
  });

  test('PUT with a stale If-Match is rejected (409) and does not clobber', async () => {
    const { base, file } = await withServer('# T\n');
    await fetch(`${base}/doc`, {
      method: 'PUT',
      headers: { 'if-match': 'stale-etag' },
      body: 'clobbered\n',
    });
    expect(readFileSync(file, 'utf8')).toBe('# T\n');
  });

  test('PUT with no If-Match still rejects a conflicting change', async () => {
    // No If-Match header on the first read is treated as "you didn't read yet"
    // and is rejected, so a blind client can't overwrite a concurrent edit.
    const { base, file } = await withServer('# T\n');
    const res = await fetch(`${base}/doc`, { method: 'PUT', body: 'x\n' });
    expect(res.status).toBe(409);
    expect(readFileSync(file, 'utf8')).toBe('# T\n');
  });
});

describe('tsk serve static assets', () => {
  test('GET / serves index.html', async () => {
    const { base } = await withServer('# T\n', {
      staticFile: 'index.html',
      staticContent: '<html>hi</html>',
    });
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>hi</html>');
  });

  test('GET an asset serves it with a content type', async () => {
    const { base } = await withServer('# T\n', {
      staticFile: 'app.js',
      staticContent: 'console.log(1)',
    });
    const res = await fetch(`${base}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
  });

  test('GET a missing asset is 404', async () => {
    const { base } = await withServer('# T\n');
    const res = await fetch(`${base}/nope.png`);
    expect(res.status).toBe(404);
  });

  test('encoded path traversal cannot leak files outside webRoot', async () => {
    // The WHATWG URL parser normalizes even percent-encoded "..", so a
    // traversal attempt never resolves outside webRoot and cannot serve the
    // secret file placed next to it.
    const root = mkdtempSync(join(tmpdir(), 'tsk-serve-'));
    const webRoot = join(root, 'web');
    writeFileSync(join(root, 'secret.txt'), 'TOP-SECRET');
    const file = join(webRoot, 'tasks.md');
    const handler = createServeHandler({ filePath: file, webRoot });

    const status = await new Promise<number>((resolve) => {
      const res = {
        statusCode: 200,
        setHeader() {},
        end(data?: unknown) {
          resolve(this.statusCode);
        },
      };
      const req = { url: '/%2e%2e/secret.txt', method: 'GET', headers: {} };
      void handler(req as never, res as never);
    });
    // It must not serve the file outside webRoot (a 200 with secret content).
    expect(status).not.toBe(200);
  });
});

describe('needsRebuild', () => {
  test('is true when there is no index.html', () => {
    const root = mkdtempSync(join(tmpdir(), 'tsk-serve-'));
    const webRoot = join(root, 'apps', 'web', 'dist');
    expect(needsRebuild(webRoot)).toBe(true);
  });

  test('is false when the build is newer than the source', () => {
    const root = mkdtempSync(join(tmpdir(), 'tsk-serve-'));
    const webRoot = join(root, 'apps', 'web', 'dist');
    const src = join(root, 'apps', 'web', 'src');
    mkdirSync(webRoot, { recursive: true });
    mkdirSync(src, { recursive: true });
    writeFileSync(join(webRoot, 'index.html'), '<html></html>');
    writeFileSync(join(src, 'App.tsx'), 'export const App = () => null;');
    // Force the source to be older than the build.
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(src, 'App.tsx'), old, old);
    expect(needsRebuild(webRoot)).toBe(false);
  });

  test('is true when the source is newer than the build', () => {
    const root = mkdtempSync(join(tmpdir(), 'tsk-serve-'));
    const webRoot = join(root, 'apps', 'web', 'dist');
    const src = join(root, 'apps', 'web', 'src');
    mkdirSync(webRoot, { recursive: true });
    mkdirSync(src, { recursive: true });
    writeFileSync(join(webRoot, 'index.html'), '<html></html>');
    writeFileSync(join(src, 'App.tsx'), 'export const App = () => null;');
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(webRoot, 'index.html'), old, old);
    expect(needsRebuild(webRoot)).toBe(true);
  });
});
