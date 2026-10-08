// Runs the shipped bundles against a local HTTPS model of the legacy and v3
// contracts. All data, tokens and TLS credentials are generated test fixtures.
const { execFile, execFileSync } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { Crc32c } = require('@aws-crypto/crc32c');

const limit = 30 * 1024 * 1024;
const apiToken = 'synthetic-api-token';
const uploadToken = 'synthetic-upload-token';
const fileId = '00000000-0000-4000-8000-000000000001';
const targetId = '00000000-0000-4000-8000-000000000002';
const oldId = '00000000-0000-4000-8000-000000000003';
let directory, cert, key, eventPath, smallWorkspace, largeWorkspace;

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-bundle-test-'));
  smallWorkspace = path.join(directory, 'small');
  largeWorkspace = path.join(directory, 'large');
  await fs.mkdir(smallWorkspace);
  await fs.mkdir(largeWorkspace);
  await fs.writeFile(path.join(smallWorkspace, 'source.txt'), 'Synthetic source fixture\n');
  await fs.writeFile(path.join(largeWorkspace, 'source.bin'), randomBytes(32 * 1024 * 1024));
  eventPath = path.join(directory, 'event.json');
  await fs.writeFile(eventPath, JSON.stringify({
    pull_request: { number: 42, title: 'Synthetic change', head: { ref: 'feature' }, base: { ref: 'main' } },
    repository: { name: 'example', owner: { login: 'example' } },
  }));
  const configPath = path.join(directory, 'openssl.cnf');
  await fs.writeFile(configPath, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,digitalSignature,keyEncipherment\n');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', path.join(directory, 'key.pem'), '-out', path.join(directory, 'cert.pem'), '-config', configPath], { stdio: 'ignore' });
  key = await fs.readFile(path.join(directory, 'key.pem'));
  cert = await fs.readFile(path.join(directory, 'cert.pem'));
}, 30000);
afterAll(async () => { await fs.rm(directory, { recursive: true, force: true }); });

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

async function scenario({ mode = '', large = false, archive = 'zip', failure = '', artifacts = false, templateId = '' }) {
  const calls = [];
  const serverErrors = [];
  let uploaded = false;
  let baseUrl;
  const server = https.createServer({ key, cert }, async (req, res) => {
    const url = new URL(req.url, baseUrl);
    const route = url.pathname;
    calls.push(`${req.method} ${route}`);
    function json(body, status = 200) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    }
    try {
      if (route === '/storage/upload') {
        expect(req.method).toBe('PUT');
        expect(req.headers.authorization).toBeUndefined();
        expect(req.headers['content-type']).toBe('application/octet-stream');
        expect(Number(req.headers['content-length'])).toBeGreaterThan(limit);
        const hash = createHash('md5');
        let bytes = 0;
        for await (const chunk of req) { hash.update(chunk); bytes += chunk.length; }
        expect(bytes).toBe(Number(req.headers['content-length']));
        expect(req.headers['content-md5']).toBe(hash.digest('base64'));
        if (failure === 'storage') return json({ message: `Checksum mismatch: ${uploadToken}` }, 400);
        uploaded = true;
        return json({});
      }
      expect(req.headers.authorization).toBe(`Bearer ${apiToken}`);
      if (route === '/api/v2/entities/search') {
        expect(url.searchParams.get('system')).toBe(mode === 'signed' ? 'engineering' : null);
        await readJson(req);
        return json({ results: [{ id: targetId }] });
      }
      if (route === `/api/entities/${targetId}`) return json({
        id: targetId, sourceInfo: { template: { id: 'template' } },
        fields: { 'Code Snapshot': { type: 'REFERENCE', value: [{ id: oldId, version: 1 }] } },
      });
      if (route === `/api/entities/${targetId}/change-set`) return json({ index: '42' });
      if (route === '/api/files') {
        expect(url.searchParams.get('system')).toBe(mode === 'signed' && !artifacts ? 'engineering' : null);
        expect(url.searchParams.get('typeTitle')).toBe('GitHub Artifacts');
        const crc = new Crc32c();
        for await (const chunk of req) crc.update(chunk);
        expect(url.searchParams.get('crc32cHash')).toBe(String(crc.digest()));
        if (large) return json({ message: 'Direct upload limit is 30 MiB' }, 413);
        uploaded = true;
        return json({ id: fileId }, 201);
      }
      if (route === '/api/v3/files/prepare-upload') {
        expect(await readJson(req)).toEqual({
          filename: expect.stringMatching(archive === 'tar' ? /\.tar\.gz$/ : /\.zip$/),
          contentType: 'application/octet-stream', system: 'engineering',
          ...(templateId ? { templateId } : { typeTitle: 'GitHub Artifacts' }),
        });
        if (failure === 'prepare') return json({ message: 'Route unavailable' }, 404);
        return json({ method: 'PUT', uploadUrl: `${baseUrl}/storage/upload?signature=synthetic`, uploadToken,
          expiresAt: new Date(Date.now() + 1800000).toISOString(), headers: { 'Content-Type': 'application/octet-stream' } });
      }
      if (route === '/api/v3/files/complete-upload') {
        expect(uploaded).toBe(true);
        expect(await readJson(req)).toEqual({ uploadToken });
        if (failure === 'complete') return json({ message: `Cannot complete ${uploadToken}` }, 403);
        return json({ id: fileId });
      }
      if (route === `/api/entities/${fileId}/add-to-change-set`) {
        expect(uploaded).toBe(true);
        expect(await readJson(req)).toEqual({ changeSetIndex: '42' });
        return json({});
      }
      if (route === `/api/entities/${oldId}/archive`) return json({});
      if (route === `/api/entities/${fileId}`) return json({ id: fileId, version: 7 });
      if (route === `/api/entities/${targetId}/fields/Code%20Snapshot`) {
        expect(req.method).toBe('PATCH');
        expect(await readJson(req)).toEqual({ value: [{ id: fileId, version: 7 }] });
        return json({});
      }
      throw new Error(`Unexpected request ${req.method} ${route}`);
    } catch (error) {
      serverErrors.push(error);
      json({ message: 'Test contract assertion failed' }, 500);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `https://127.0.0.1:${server.address().port}`;
  const workspace = large ? largeWorkspace : smallWorkspace;
  const bundle = path.resolve(__dirname, artifacts ? '../upload-artifacts/dist/index.js' : 'dist/index.js');
  // Supply only synthetic inputs and basic process configuration to the child.
  const env = {
    PATH: process.env.PATH, TMPDIR: directory, NODE_EXTRA_CA_CERTS: path.join(directory, 'cert.pem'),
    GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: 'example/example', GITHUB_SHA: '0'.repeat(40), GITHUB_WORKSPACE: workspace,
    INPUT_SEAL_API_TOKEN: apiToken, INPUT_SEAL_API_BASE_URL: `${baseUrl}/api/`,
    INPUT_SEAL_TEMPLATE_ID: 'template', INPUT_SEAL_FILE_TYPE_TITLE: 'GitHub Artifacts',
    INPUT_SEAL_SYSTEM: mode === 'signed' ? 'engineering' : '', INPUT_LARGE_FILE_UPLOAD_MODE: mode,
    INPUT_ARCHIVE_TYPE: archive, INPUT_ARTIFACT_PATTERNS: path.join(workspace, '*'),
    INPUT_SEAL_FIELD_NAME: 'Code Snapshot',
    INPUT_SIGNED_UPLOAD_TEMPLATE_ID: templateId,
  };
  try {
    const result = await new Promise(resolve => execFile(process.execPath, [bundle],
      { env, cwd: workspace, timeout: 90000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error?.code || 0, output: stdout + stderr })));
    expect(serverErrors).toEqual([]);
    // GitHub's runner consumes add-mask commands. Ignore those commands when
    // checking that regular log and error messages do not contain credentials.
    if (!artifacts) {
      const logs = result.output.split('\n').filter(line => !line.startsWith('::add-mask::')).join('\n');
      expect(logs).not.toContain(apiToken);
      expect(logs).not.toContain(uploadToken);
      expect(logs).not.toContain('signature=synthetic');
      expect((await fs.readdir(directory)).filter(name => name.startsWith('codebase-snapshot-'))).toEqual([]);
    }
    return { ...result, calls };
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test.each([
  { name: 'default small snapshot', options: {} },
  { name: 'signed mode small snapshot', options: { mode: 'signed' } },
  { name: 'default artifact upload', options: { artifacts: true } },
])('$name retains direct upload and links the file version', async ({ options }) => {
  const result = await scenario(options);
  expect(result.code).toBe(0);
  expect(result.calls).toContain('POST /api/files');
  expect(result.calls.some(call => call.includes('/v3/'))).toBe(false);
  expect(result.calls.at(-1)).toBe(`PATCH /api/entities/${targetId}/fields/Code%20Snapshot`);
}, 120000);

test.each([
  { archive: 'zip', templateId: '' }, { archive: 'tar', templateId: '' },
  { archive: 'zip', templateId: 'file-template' }, { archive: 'tar', templateId: 'file-template' },
])('large $archive snapshot with template "$templateId" completes, joins the changeset and replaces the reference', async ({ archive, templateId }) => {
  const result = await scenario({ mode: 'signed', large: true, archive, templateId });
  expect(result.code).toBe(0);
  expect(result.calls.slice(3)).toEqual([
    'POST /api/v3/files/prepare-upload', 'PUT /storage/upload', 'POST /api/v3/files/complete-upload',
    `POST /api/entities/${fileId}/add-to-change-set`, `POST /api/entities/${oldId}/archive`,
    `GET /api/entities/${fileId}`, `PATCH /api/entities/${targetId}/fields/Code%20Snapshot`,
  ]);
}, 120000);

test.each(['prepare', 'storage', 'complete'])('failed %s step leaves the previous snapshot untouched', async failure => {
  const result = await scenario({ mode: 'signed', large: true, failure });
  expect(result.code).toBe(1);
  expect(result.calls).not.toContain('POST /api/files');
  expect(result.calls.some(call => /add-to-change-set|archive|fields\//.test(call))).toBe(false);
  const expectedLast = { prepare: 'POST /api/v3/files/prepare-upload', storage: 'PUT /storage/upload', complete: 'POST /api/v3/files/complete-upload' };
  expect(result.calls.at(-1)).toBe(expectedLast[failure]);
}, 120000);

test('large default snapshot still uses only the legacy endpoint', async () => {
  const result = await scenario({ large: true });
  expect(result.code).toBe(1);
  expect(result.calls.at(-1)).toBe('POST /api/files');
  expect(result.calls.some(call => call.includes('/v3/'))).toBe(false);
}, 120000);
