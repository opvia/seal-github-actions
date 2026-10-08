import * as core from '@actions/core';
import { createHash } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getCodebaseSnapshotInputs, type CodebaseSnapshotInputs } from '../../common/src/github-context.js';
import { uploadSealFile } from '../../common/src/seal-api.js';
import { uploadSnapshotFile } from './upload.js';

jest.mock('@actions/core');
jest.mock('../../common/src/seal-api.js');

const limit = 30 * 1024 * 1024;
const token = 'synthetic-seal-token';
const uploadToken = 'synthetic-upload-token';
const uploadUrl = 'https://storage.example.test/object?signature=synthetic';
const inputs: CodebaseSnapshotInputs = {
	sealApiToken: token,
	sealApiBaseUrl: 'https://seal.example.test/api/',
	sealTemplateId: 'template',
	sealSystem: 'engineering',
	sealFileTypeTitle: 'GitHub Artifacts',
	snapshotFieldName: 'Code Snapshot',
	excludePatterns: '',
	archiveType: 'zip',
	largeFileUploadMode: 'signed',
	signedUploadTemplateId: '',
};
let directory: string;
let smallFile: string;
let largeFile: string;
let fetchMock: jest.SpiedFunction<typeof fetch>;
const prepared = () => ({
	method: 'PUT', uploadUrl, uploadToken,
	expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
	headers: { 'Content-Type': 'application/octet-stream' },
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeAll(async () => {
	directory = await mkdtemp(path.join(os.tmpdir(), 'snapshot-upload-test-'));
	smallFile = path.join(directory, 'boundary.zip');
	largeFile = path.join(directory, 'large.zip');
	for (const [filename, size] of [[smallFile, limit], [largeFile, limit + 1]] as const) {
		const handle = await open(filename, 'w');
		await handle.truncate(size);
		await handle.close();
	}
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
beforeEach(() => {
	jest.clearAllMocks();
	fetchMock = jest.spyOn(globalThis, 'fetch');
	jest.mocked(uploadSealFile).mockResolvedValue('direct-file');
});
afterEach(() => { fetchMock.mockRestore(); });

test.each(['', 'file-template'])('the exact 30 MiB boundary stays direct with the explicit system and template %s', async signedUploadTemplateId => {
	await expect(uploadSnapshotFile({ ...inputs, signedUploadTemplateId }, smallFile, 'snapshot.zip')).resolves.toBe('direct-file');
	expect(uploadSealFile).toHaveBeenCalledWith(inputs.sealApiBaseUrl, token, smallFile, 'snapshot.zip', inputs.sealFileTypeTitle, 'engineering');
	expect(fetchMock).not.toHaveBeenCalled();
});

test('default direct mode preserves the legacy endpoint and default system even for large files', async () => {
	await uploadSnapshotFile({ ...inputs, largeFileUploadMode: 'direct' }, largeFile, 'snapshot.zip');
	expect(uploadSealFile).toHaveBeenCalledWith(inputs.sealApiBaseUrl, token, largeFile, 'snapshot.zip', inputs.sealFileTypeTitle, undefined);
	expect(fetchMock).not.toHaveBeenCalled();
});

test('requires an explicit system before any upload', async () => {
	await expect(uploadSnapshotFile({ ...inputs, sealSystem: '' }, largeFile, 'snapshot.zip')).rejects.toThrow('seal_system is required');
	expect(fetchMock).not.toHaveBeenCalled();
	expect(uploadSealFile).not.toHaveBeenCalled();
});

test('streams >30 MiB using the old three-step contract, checksum and a separate file entity', async () => {
	fetchMock.mockResolvedValueOnce(json(prepared()));
	fetchMock.mockImplementationOnce(async (_url, init) => {
		expect(init?.method).toBe('PUT');
		expect(init?.redirect).toBe('error');
		const headers = new Headers(init?.headers);
		expect(headers.has('authorization')).toBe(false);
		expect(headers.get('content-type')).toBe('application/octet-stream');
		expect(headers.get('content-length')).toBe(String(limit + 1));
		const reader = new Response(init?.body).body?.getReader();
		if (!reader) throw new Error('Missing stream');
		const hash = createHash('md5');
		let bytes = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			hash.update(value);
			bytes += value.length;
		}
		expect(bytes).toBe(limit + 1);
		expect(headers.get('content-md5')).toBe(hash.digest('base64'));
		return new Response(null, { status: 200 });
	});
	fetchMock.mockResolvedValueOnce(json({ id: 'new-file-entity', fields: {} }));
	await expect(uploadSnapshotFile(inputs, largeFile, 'snapshot.zip')).resolves.toBe('new-file-entity');
	expect(fetchMock).toHaveBeenCalledTimes(3);
	expect(fetchMock.mock.calls[0]?.[0]).toBe('https://seal.example.test/api/v3/files/prepare-upload');
	expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
		filename: 'snapshot.zip', contentType: 'application/octet-stream',
		typeTitle: 'GitHub Artifacts', system: 'engineering',
	});
	expect(fetchMock.mock.calls[1]?.[0]).toBe(uploadUrl);
	expect(fetchMock.mock.calls[2]?.[0]).toBe('https://seal.example.test/api/v3/files/complete-upload');
	expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({ uploadToken });
	for (const index of [0, 2]) {
		expect(new Headers(fetchMock.mock.calls[index]?.[1]?.headers).get('authorization')).toBe(`Bearer ${token}`);
	}
	expect(core.setSecret).toHaveBeenCalledWith(uploadUrl);
	expect(core.setSecret).toHaveBeenCalledWith(uploadToken);
	expect(uploadSealFile).not.toHaveBeenCalled();
});

test('uses an explicit file template for the newer signed upload API', async () => {
	fetchMock.mockResolvedValueOnce(json(prepared()))
		.mockResolvedValueOnce(new Response(null, { status: 200 }))
		.mockResolvedValueOnce(json({ id: 'new-file-entity' }));
	await expect(uploadSnapshotFile({ ...inputs, signedUploadTemplateId: 'file-template' }, largeFile, 'snapshot.zip')).resolves.toBe('new-file-entity');
	expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
		filename: 'snapshot.zip', contentType: 'application/octet-stream',
		templateId: 'file-template', system: 'engineering',
	});
	expect(fetchMock).toHaveBeenCalledTimes(3);
	expect(uploadSealFile).not.toHaveBeenCalled();
});

test.each([401, 403, 404, 422, 500])('prepare HTTP %s stops with no fallback or leaked response', async (status) => {
	fetchMock.mockResolvedValueOnce(json({ message: `${token} ${uploadUrl} ${uploadToken}` }, status));
	await expect(uploadSnapshotFile(inputs, largeFile, 'snapshot.zip')).rejects.toThrow(`Prepare upload failed (HTTP ${status}).`);
	expect(fetchMock).toHaveBeenCalledTimes(1);
	expect(uploadSealFile).not.toHaveBeenCalled();
});

test.each([400, 403, 500])('storage HTTP %s never completes or retries', async (status) => {
	fetchMock.mockResolvedValueOnce(json(prepared())).mockResolvedValueOnce(json({ secret: uploadUrl }, status));
	await expect(uploadSnapshotFile(inputs, largeFile, 'snapshot.zip')).rejects.toThrow(`Storage upload failed (HTTP ${status}).`);
	expect(fetchMock).toHaveBeenCalledTimes(2);
	expect(uploadSealFile).not.toHaveBeenCalled();
});

test('network errors containing credentials are sanitized', async () => {
	fetchMock.mockResolvedValueOnce(json(prepared())).mockRejectedValueOnce(new Error(`${uploadUrl} ${uploadToken}`));
	await expect(uploadSnapshotFile(inputs, largeFile, 'snapshot.zip')).rejects.toThrow('Storage upload failed: network or redirect error.');
	expect(fetchMock).toHaveBeenCalledTimes(2);
});

test.each([
	{ method: 'POST' }, { uploadToken: '' }, { expiresAt: 'invalid' },
	{ expiresAt: '2000-01-01T00:00:00.000Z' }, { uploadUrl: 'http://storage.example.test/object' },
	{ headers: { Authorization: token } }, { headers: { 'Content-Type': 5 } },
	{ headers: { 'Content-Type': `invalid\n${uploadToken}` } },
])('rejects malformed, expired or unsafe upload target %j', async (override) => {
	fetchMock.mockResolvedValueOnce(json({ ...prepared(), ...override }));
	await expect(uploadSnapshotFile(inputs, largeFile, 'snapshot.zip')).rejects.toThrow();
	expect(fetchMock).toHaveBeenCalledTimes(1);
	expect(uploadSealFile).not.toHaveBeenCalled();
});

test.each([json({ message: uploadToken }, 403), json({}), new Response('not-json')])('completion failure is not retried or replaced by direct upload', async (response) => {
	fetchMock.mockResolvedValueOnce(json(prepared())).mockResolvedValueOnce(new Response(null, { status: 200 })).mockResolvedValueOnce(response);
	await expect(uploadSnapshotFile(inputs, largeFile, 'snapshot.zip')).rejects.toThrow(/Complete upload/);
	expect(fetchMock).toHaveBeenCalledTimes(3);
	expect(uploadSealFile).not.toHaveBeenCalled();
});

describe('workflow inputs', () => {
	const inputValues: Record<string, string> = {
		seal_api_token: token, seal_api_base_url: inputs.sealApiBaseUrl, seal_template_id: 'template',
	};
	test('defaults to direct and does not require a system', () => {
		jest.mocked(core.getInput).mockImplementation(name => inputValues[name] || '');
		expect(getCodebaseSnapshotInputs()).toMatchObject({ largeFileUploadMode: 'direct', sealSystem: '', signedUploadTemplateId: '' });
	});

	test('reads the signed upload template separately from the change control template', () => {
		jest.mocked(core.getInput).mockImplementation(name => name === 'signed_upload_template_id' ? 'file-template' : inputValues[name] || '');
		expect(getCodebaseSnapshotInputs()).toMatchObject({ sealTemplateId: 'template', signedUploadTemplateId: 'file-template' });
	});
	test('rejects signed mode without a system', () => {
		jest.mocked(core.getInput).mockImplementation(name => name === 'large_file_upload_mode' ? 'signed' : inputValues[name] || '');
		expect(() => getCodebaseSnapshotInputs()).toThrow('seal_system is required');
	});
	test('rejects unknown modes', () => {
		jest.mocked(core.getInput).mockImplementation(name => name === 'large_file_upload_mode' ? 'automatic' : inputValues[name] || '');
		expect(() => getCodebaseSnapshotInputs()).toThrow("must be 'direct' or 'signed'");
	});
});
