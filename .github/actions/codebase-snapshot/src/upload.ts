import * as core from '@actions/core';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { CodebaseSnapshotInputs } from '../../common/src/github-context.js';
import { uploadSealFile } from '../../common/src/seal-api.js';

const DIRECT_UPLOAD_LIMIT = 30 * 1024 * 1024;
const CONTENT_TYPE = 'application/octet-stream';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Do not expose error bodies, URLs or fetch error causes: these can contain
// signed credentials. A failed step is never retried through the direct API.
async function request(url: string, init: RequestInit, step: string): Promise<Response> {
	let response: Response;
	try {
		response = await fetch(url, { ...init, redirect: 'error' });
	} catch {
		throw new Error(`${step} failed: network or redirect error.`);
	}
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`${step} failed (HTTP ${response.status}).`);
	}
	return response;
}

async function readJson(response: Response, step: string): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new Error(`${step} returned invalid JSON.`);
	}
}

async function uploadSignedFile(
	inputs: CodebaseSnapshotInputs,
	filePath: string,
	filename: string,
	fileSize: number,
): Promise<string> {
	// Hash before preparing the URL so hashing does not consume its lifetime.
	// Content-MD5 is validated by the GCS XML PUT API and does not require a
	// change to Seal's existing signed URL contract.
	const hash = createHash('md5');
	for await (const chunk of createReadStream(filePath)) hash.update(chunk);
	const contentMd5 = hash.digest('base64');
	const baseUrl = inputs.sealApiBaseUrl.replace(/\/$/, '');
	const apiHeaders = {
		Authorization: `Bearer ${inputs.sealApiToken.trim()}`,
		'Content-Type': 'application/json',
		Accept: 'application/json',
	};
	const prepared = await readJson(await request(`${baseUrl}/v3/files/prepare-upload`, {
		method: 'POST',
		headers: apiHeaders,
		body: JSON.stringify({
			filename,
			contentType: CONTENT_TYPE,
			...(inputs.signedUploadTemplateId
				? { templateId: inputs.signedUploadTemplateId }
				: { typeTitle: inputs.sealFileTypeTitle }),
			system: inputs.sealSystem,
		}),
	}, 'Prepare upload'), 'Prepare upload');

	if (isRecord(prepared)) {
		if (typeof prepared.uploadUrl === 'string') core.setSecret(prepared.uploadUrl);
		if (typeof prepared.uploadToken === 'string') core.setSecret(prepared.uploadToken);
	}
	if (!isRecord(prepared) || prepared.method !== 'PUT'
		|| typeof prepared.uploadUrl !== 'string'
		|| typeof prepared.uploadToken !== 'string' || !prepared.uploadToken
		|| typeof prepared.expiresAt !== 'string'
		|| !Number.isFinite(Date.parse(prepared.expiresAt))
		|| !isRecord(prepared.headers)) {
		throw new Error('Prepare upload returned an invalid upload target.');
	}
	let uploadUrl: URL;
	try {
		uploadUrl = new URL(prepared.uploadUrl);
	} catch {
		throw new Error('Prepare upload returned an invalid upload URL.');
	}
	if (uploadUrl.protocol !== 'https:' || uploadUrl.username || uploadUrl.password) {
		throw new Error('Prepare upload must return an HTTPS upload URL without user credentials.');
	}
	if (Date.parse(prepared.expiresAt) <= Date.now()) {
		throw new Error('Prepared upload has expired; run the action again.');
	}
	const storageHeaders = new Headers();
	for (const [name, value] of Object.entries(prepared.headers)) {
		if (typeof value !== 'string' || name.toLowerCase() === 'authorization') {
			throw new Error('Prepare upload returned invalid storage headers.');
		}
		try {
			storageHeaders.set(name, value);
		} catch {
			throw new Error('Prepare upload returned invalid storage headers.');
		}
	}
	storageHeaders.set('Content-Length', String(fileSize));
	storageHeaders.set('Content-MD5', contentMd5);

	core.info(`Uploading snapshot using signed storage upload (${fileSize} bytes).`);
	const stream = createReadStream(filePath);
	try {
		const chunks = stream[Symbol.asyncIterator]();
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				const { done, value } = await chunks.next();
				if (done) controller.close();
				else controller.enqueue(value);
			},
			cancel() { stream.destroy(); },
		});
		const init: RequestInit & { duplex: 'half' } = {
			method: 'PUT',
			headers: storageHeaders,
			body,
			duplex: 'half',
		};
		const response = await request(uploadUrl.href, init, 'Storage upload');
		await response.body?.cancel();
	} finally {
		stream.destroy();
	}

	const completed = await readJson(await request(`${baseUrl}/v3/files/complete-upload`, {
		method: 'POST',
		headers: apiHeaders,
		body: JSON.stringify({ uploadToken: prepared.uploadToken }),
	}, 'Complete upload'), 'Complete upload');
	if (!isRecord(completed) || typeof completed.id !== 'string' || !completed.id) {
		throw new Error('Complete upload returned no file entity ID.');
	}
	return completed.id;
}

export async function uploadSnapshotFile(
	inputs: CodebaseSnapshotInputs,
	filePath: string,
	filename: string,
): Promise<string> {
	const signed = inputs.largeFileUploadMode === 'signed';
	if (signed && !inputs.sealSystem) {
		throw new Error('seal_system is required when large_file_upload_mode is signed.');
	}
	const { size } = await stat(filePath);
	if (signed && size > DIRECT_UPLOAD_LIMIT) {
		return uploadSignedFile(inputs, filePath, filename, size);
	}
	return uploadSealFile(
		inputs.sealApiBaseUrl, inputs.sealApiToken, filePath, filename,
		inputs.sealFileTypeTitle, signed ? inputs.sealSystem : undefined,
	);
}
