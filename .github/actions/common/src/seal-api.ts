import * as core from '@actions/core';
import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { Crc32c } from '@aws-crypto/crc32c';

// Simplified Seal Entity structure based on simplifiedEntitySchema and script usage
interface SealEntityLite {
	id: string;
	title: string;
	version?: number | null; // For Get Entity Details response
	sourceInfo?: {
		template?: {
			id?: string;
		};
	};
	fields?: {
		// include more field schemas
		[fieldName: string]: {
			type: 'REFERENCE';
			value: SealFileReference[];
		}
	}
}

// Response structure for successful file upload
interface SealFileUploadResponse {
	id: string;
}

export interface SealFileReference {
	id: string;
	version: number | null;
}

interface SealChangeSetResponse {
	id: string;
	index: string;
	name: string;
	status: 'OPEN' | 'IN_REVIEW' | 'CLOSED';
	description: string | null;
	entityRefs: SealFileReference[];
}

interface AddToChangeSetBody {
	changeSetIndex: string;
}

// --- Helper Functions ---

/**
 * Normalize an API URL to ensure it ends with a /
 */
function normalizeApiUrl(url: string): string {
	return url.endsWith('/') ? url : `${url}/`;
}

/**
 * Creates base Axios configuration for Seal API requests
 */
function createApiConfig(
	apiToken: string,
	extraHeaders: Record<string, string> = {},
): AxiosRequestConfig {
	if (!apiToken) {
		throw new Error('Seal API token is required.');
	}
	return {
		headers: {
			Authorization: `Bearer ${apiToken.trim()}`,
			'Content-Type': 'application/json', // Default, override as needed
			Accept: 'application/json',
			...extraHeaders,
		},
		validateStatus: (status: number) => status >= 200 && status < 500,
	};
}

/**
 * Calculates the CRC32C hash of a file.
 * @param filePath The absolute path to the file.
 * @returns A promise that resolves with the CRC32C hash as a stringified unsigned 32-bit integer.
 */
function calculateCRC32CHash(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hasher = new Crc32c();
		const stream = fs.createReadStream(filePath);

		stream.on('data', (chunk) => {
			if (Buffer.isBuffer(chunk)) {
				hasher.update(chunk);
			} else {
				reject(new Error(`Unexpected string chunk received while hashing file: ${filePath}`));
				stream.destroy();
				return;
			}
		});

		stream.on('end', () => {
			const hashNumber = hasher.digest();
			
			if (typeof hashNumber !== 'number') {
				reject(new Error(`CRC32C digest did not return a number. Type: ${typeof hashNumber}`));
				return;
			}

			resolve(hashNumber.toString());
		});

		stream.on('error', (err) => {
			reject(new Error(`Error reading file "${filePath}" for CRC32C calculation: ${err.message}`));
		});
	});
}

// --- API Functions ---

/**
 * Finds a unique Seal entity by PR number within its title and matching template ID.
 * @returns The ID of the found entity.
 * @throws If no unique entity is found or API error occurs.
 */
export async function findSealEntity(
	apiUrl: string,
	apiToken: string,
	prNumber: number,
	templateId: string,
): Promise<SealEntityLite > {
	const functionName = 'findSealEntity';
	const searchTerm = `#${prNumber}`;
	core.info(
		`[${functionName}] Searching for entity containing "${searchTerm}" with Template ID: ${templateId}`,
	);

	if (!templateId) {
		throw new Error('Seal Template ID is required for filtering search results.');
	}

	const baseUrl = normalizeApiUrl(apiUrl);
	const url = `${baseUrl}entities/search`;
	const config: AxiosRequestConfig = {
		...createApiConfig(apiToken),
		method: 'GET',
		url,
		params: { titleContains: searchTerm },
	};

	core.debug(`[${functionName}] Making GET request to ${url} with query ${searchTerm}`);
	let response: AxiosResponse<SealEntityLite[]>;
	try {
		const startTime = Date.now();
		response = await axios(config);
		const requestDuration = Date.now() - startTime;
		core.info(`[${functionName}] API response status: ${response.status} (${requestDuration}ms)`);
	} catch (error: unknown) {
		let message = 'Unknown error';
		if (error instanceof Error) message = error.message;

		if (axios.isAxiosError(error)) {
			core.error(`[${functionName}] API request failed: ${message}`);
			core.error(`[${functionName}] Response Data: ${JSON.stringify(error.response?.data)}`);
			message = `Axios error: ${message}`;
		} else {
			core.error(`[${functionName}] Non-axios error during request: ${error}`);
		}
		throw new Error(`Failed to search for Seal entity: ${message}`);
	}

	if (response.status !== 200) {
		core.error(
			`[${functionName}] API search error: ${response.status} ${response.statusText}`,
		);
		core.error(`[${functionName}] API search error body: ${JSON.stringify(response.data)}`);
		throw new Error(
			`Seal API search failed with status ${response.status}: ${JSON.stringify(response.data)}`,
		);
	}

	const searchResults = response.data;
	core.debug(
		`[${functionName}] Raw search results count: ${searchResults?.length ?? 0}`,
	);

	if (!Array.isArray(searchResults)) {
		core.error(`[${functionName}] API search response was not an array.`);
		throw new Error('Invalid response format from Seal API search.');
	}

	const matchingEntities = searchResults.filter((entity) => {
		const matches = entity?.sourceInfo?.template?.id === templateId;
		core.debug(
			` -> Entity ${entity.id}: Template ${entity?.sourceInfo?.template?.id} === ${templateId}? ${matches}`,
		);
		return matches;
	});

	if (matchingEntities.length === 0) {
		core.error(
			`[${functionName}] No entity found matching title "${searchTerm}" and template ID "${templateId}".`,
		);
		throw new Error(
			`No Seal entity found matching title "${searchTerm}" and template ID "${templateId}".`,
		);
	}

	if (matchingEntities.length > 1) {
		core.error(
			`[${functionName}] Found multiple entities (${matchingEntities.map((e) => e.id).join(', ')}) matching criteria. Cannot proceed.`,
		);
		throw new Error(
			`Found multiple entities matching title "${searchTerm}" and template ID "${templateId}". Cannot link artifact/snapshot.`,
		);
	}

	const entity = matchingEntities[0];
	if (!entity) {
		core.error(`[${functionName}] Found unique Seal entity: ${entity}`);
		throw new Error(`Found unique Seal entity: ${entity}`);
	}
	core.info(`[${functionName}] Found unique Seal entity: ${entity}`);
	return entity;
}

/**
 * Retrieves the index of the changeset associated with a given Seal entity.
 * @returns The changeset index string.
 * @throws If the entity is not found, not part of a changeset, or API error occurs.
 */
export async function getSealEntityChangeSetIndex(
	apiUrl: string,
	apiToken: string,
	entityId: string,
): Promise<string> {
	const functionName = 'getSealEntityChangeSetIndex';
	core.info(`[${functionName}] Getting changeset index for Entity ID: ${entityId}`);

	const baseUrl = normalizeApiUrl(apiUrl);
	const url = `${baseUrl}entities/${entityId}/change-set`;
	const config: AxiosRequestConfig = {
		...createApiConfig(apiToken),
		method: 'GET',
		url,
	};

	core.debug(`[${functionName}] Making GET request to ${url}`);
	let response: AxiosResponse<SealChangeSetResponse>;
	try {
		response = await axios(config);
		core.info(`[${functionName}] API response status: ${response.status}`);
	} catch (error: unknown) {
		core.error(`[${functionName}] API request failed: ${error instanceof Error ? error.message : String(error)}`);
		if (axios.isAxiosError(error)) {
			const status = error.response?.status ?? 'Unknown Status';
			const data = error.response?.data ?? 'No response data';
			core.error(`[${functionName}] Response Status: ${status}`);
			core.error(`[${functionName}] Response Data: ${JSON.stringify(data)}`);
			// Throw the response status and data from the error object
			throw new Error(`[${functionName}] API Error: ${status} - ${JSON.stringify(data)}`);
		}
		throw error; 
	}

	if (response.status !== 200) {
		core.error(
			`[${functionName}] API error getting changeset: ${response.status} ${response.statusText}`,
		);
		core.error(`[${functionName}] API error body: ${JSON.stringify(response.data)}`);
		throw new Error(
			`[${functionName}] API Error: ${response.status} - ${JSON.stringify(response.data)}`,
		);
	}

	const changeSetIndex = response.data?.index;
	if (!changeSetIndex || typeof changeSetIndex !== 'string') {
		core.error(
			`[${functionName}] Changeset request succeeded (Status: ${response.status}), but failed to extract index.`,
		);
		core.error(`[${functionName}] Response Body: ${JSON.stringify(response.data)}`);
		throw new Error(`[${functionName}] Missing or invalid changeset index in API response.`);
	}

	core.info(`[${functionName}] Found changeset index: ${changeSetIndex}`);
	return changeSetIndex;
}

/**
 * Adds a specified entity to a changeset identified by its index.
 * @throws If the API request fails.
 */
export async function addEntityToChangeSet(
	apiUrl: string,
	apiToken: string,
	entityIdToAdd: string,
	changeSetIndex: string,
): Promise<void> {
	const functionName = 'addEntityToChangeSet';
	core.info(
		`[${functionName}] Adding Entity ID ${entityIdToAdd} to ChangeSet Index ${changeSetIndex}`,
	);

	const baseUrl = normalizeApiUrl(apiUrl);
	const url = `${baseUrl}entities/${entityIdToAdd}/add-to-change-set`;
	const payload: AddToChangeSetBody = { changeSetIndex };

	const config: AxiosRequestConfig = {
		...createApiConfig(apiToken),
		method: 'POST',
		url,
		data: payload,
	};

	core.debug(`[${functionName}] Making POST request to ${url}`);
	core.debug(`[${functionName}] Payload: ${JSON.stringify(payload)}`);

	let response: AxiosResponse;
	try {
		response = await axios(config);
		core.info(`[${functionName}] API response status: ${response.status}`);
	} catch (error: unknown) {
		core.error(`[${functionName}] API request failed: ${error instanceof Error ? error.message : String(error)}`);
		if (axios.isAxiosError(error)) {
			const status = error.response?.status ?? 'Unknown Status';
			const data = error.response?.data ?? 'No response data';
			core.error(`[${functionName}] Response Status: ${status}`);
			core.error(`[${functionName}] Response Data: ${JSON.stringify(data)}`);
			// Throw the response status and data from the error object
			throw new Error(`[${functionName}] API Error: ${status} - ${JSON.stringify(data)}`);
		}
		throw error; 
	}

	if (response.status !== 200) {
		core.error(
			`[${functionName}] API error adding to changeset: ${response.status} ${response.statusText}`,
		);
		core.error(`[${functionName}] API error body: ${JSON.stringify(response.data)}`);
		throw new Error(
			`[${functionName}] API Error: ${response.status} - ${JSON.stringify(response.data)}`,
		);
	}

	core.info(
		`[${functionName}] Successfully added entity ${entityIdToAdd} to changeset ${changeSetIndex}.`,
	);
}

/**
 * Uploads a file to Seal, creating a new file entity.
 * @returns The ID of the newly created Seal file entity.
 * @throws If upload fails or API error occurs.
 */
export async function uploadSealFile(
	apiUrl: string,
	apiToken: string,
	filePath: string,
	sealFilename: string,
	fileTypeTitle: string,
): Promise<string> {
	const functionName = 'uploadSealFile';
	const baseFilename = path.basename(filePath);
	core.info(
		`[${functionName}] Uploading file "${baseFilename}" as "${sealFilename}" with type "${fileTypeTitle}"`, 
	);

	core.debug(`[${functionName}] Calculating CRC32C hash for ${baseFilename}...`);
	const crc32cHash = await calculateCRC32CHash(filePath);
	core.info(`[${functionName}] Calculated CRC32C Hash: ${crc32cHash}`);

	const baseUrl = normalizeApiUrl(apiUrl);
	const url = `${baseUrl}files`;
	const stats = fs.statSync(filePath);
	const fileSizeInBytes = stats.size;
	const fileStream = fs.createReadStream(filePath);

	const config: AxiosRequestConfig = {
		...createApiConfig(apiToken, {
			'Content-Type': 'application/octet-stream',
			'Content-Length': fileSizeInBytes.toString(),
		}),
		method: 'POST',
		url,
		params: {
			filename: sealFilename,
			typeTitle: fileTypeTitle,
			crc32cHash
		},
		data: fileStream,
		maxContentLength: Number.POSITIVE_INFINITY, // Needed for large file uploads
		maxBodyLength: Number.POSITIVE_INFINITY,
	};

	core.debug(`[${functionName}] Making POST request to ${url} with params: ${JSON.stringify(config.params)}`);
	let response: AxiosResponse<SealFileUploadResponse>;
	try {
		const startTime = Date.now();
		response = await axios(config);
		const requestDuration = Date.now() - startTime;
		core.info(`[${functionName}] API response status: ${response.status} (${requestDuration}ms)`);
	} catch (error: unknown) {
		let message = 'Unknown error';
		if (error instanceof Error) message = error.message;

		if (axios.isAxiosError(error)) {
			core.error(`[${functionName}] API request failed: ${message}`);
			core.error(`[${functionName}] Response Status: ${error.response?.status}`);
			core.error(`[${functionName}] Response Data: ${JSON.stringify(error.response?.data)}`);
			message = `Axios error: ${message}`;
		} else {
			core.error(`[${functionName}] Non-axios error during request: ${error}`);
		}
		throw new Error(`Failed to upload file "${sealFilename}" (CRC32C: ${crc32cHash}): ${message}`);
	}

	// Allow 200 or 201 for creation
	if (response.status !== 200 && response.status !== 201) {
		core.error(
			`[${functionName}] API upload error: ${response.status} ${response.statusText}`,
		);
		core.error(`[${functionName}] API upload error body: ${JSON.stringify(response.data)}`);
		throw new Error(
			`Seal API file upload failed with status ${response.status}: ${JSON.stringify(response.data)}`,
		);
	}

	const fileId = response.data?.id;
	if (!fileId) {
		core.error(
			`[${functionName}] File upload succeeded (Status: ${response.status}), but failed to extract file ID from response.`,
		);
		core.error(`[${functionName}] Response Body: ${JSON.stringify(response.data)}`);
		throw new Error('Missing file ID in Seal API response after upload.');
	}

	core.info(`[${functionName}] Successfully uploaded file. File Entity ID: ${fileId}`);
	return fileId;
}

/**
 * Gets the version of a Seal entity (typically a file entity).
 * @returns The entity version number, or null if retrieval fails or version is missing.
 */
export async function getSealFileVersion(
	apiUrl: string,
	apiToken: string,
	fileId: string,
): Promise<number | null> {
	const functionName = 'getSealFileVersion';
	core.debug(`[${functionName}] Fetching details for entity ID: ${fileId}`);

	const baseUrl = normalizeApiUrl(apiUrl);
	const url = `${baseUrl}entities/${fileId}`;
	const config: AxiosRequestConfig = {
		...createApiConfig(apiToken),
		method: 'GET',
		url,
	};

	let response: AxiosResponse<SealEntityLite>;
	try {
		response = await axios(config);
	} catch (error: unknown) {
		let message = 'Unknown error';
		if (error instanceof Error) message = error.message;
		// Log severe error but don't fail the action, just return null version
		core.error(`[${functionName}] Error fetching entity details for ${fileId}: ${message}`);
		if (axios.isAxiosError(error)) {
			core.error(`[${functionName}] Response Data: ${JSON.stringify(error.response?.data)}`);
		}
		return null;
	}

	if (response.status !== 200) {
		// Log warning but don't fail the action, just return null version
		core.warning(
			`[${functionName}] Failed to fetch entity details for ${fileId}. Status: ${response.status}. Response: ${JSON.stringify(response.data)}. Proceeding with version=null.`,
		);
		return null;
	}

	const version = response.data?.version;
	if (version === undefined || version === null) {
		core.debug(`[${functionName}] Version not found in response for entity ${fileId}. Using null.`);
		return null;
	}

	core.debug(`[${functionName}] Extracted version ${version} for entity ${fileId}`);
	// Ensure it's a number before returning
	return typeof version === 'number' ? version : null;
}

/**
 * Links one or more file references to a target entity field.
 * @throws If linking fails or API error occurs.
 */
export async function linkFilesToEntityField(
	apiUrl: string,
	apiToken: string,
	entityId: string,
	fieldName: string,
	fileReferences: SealFileReference[],
): Promise<void> {
	const functionName = 'linkFilesToEntityField';
	core.info(
		`[${functionName}] Linking ${fileReferences.length} file(s) to Entity ID ${entityId} in field "${fieldName}"...`,
	);

	if (fileReferences.length === 0) {
		core.warning(`[${functionName}] No file references provided. Skipping linking.`);
		return;
	}

	const baseUrl = normalizeApiUrl(apiUrl);
	// Field name needs to be URL encoded for the path
	const encodedFieldName = encodeURIComponent(fieldName);
	const url = `${baseUrl}entities/${entityId}/fields/${encodedFieldName}`;
	const payload = { value: fileReferences };

	const config: AxiosRequestConfig = {
		...createApiConfig(apiToken),
		method: 'PATCH',
		url,
		data: payload,
	};

	core.debug(`[${functionName}] Making PATCH request to ${url}`);
	core.debug(`[${functionName}] Payload: ${JSON.stringify(payload)}`);

	let response: AxiosResponse;
	try {
		const startTime = Date.now();
		response = await axios(config);
		const requestDuration = Date.now() - startTime;
		core.info(`[${functionName}] API response status: ${response.status} (${requestDuration}ms)`);
	} catch (error: unknown) {
		let message = 'Unknown error';
		if (error instanceof Error) message = error.message;

		if (axios.isAxiosError(error)) {
			core.error(`[${functionName}] API request failed: ${message}`);
			core.error(`[${functionName}] Response Data: ${JSON.stringify(error.response?.data)}`);
			message = `Axios error: ${message}`;
		} else {
			core.error(`[${functionName}] Non-axios error during request: ${error}`);
		}
		throw new Error(`Failed to link files to entity field "${fieldName}": ${message}`);
	}

	if (response.status !== 200) {
		core.error(
			`[${functionName}] API linking error: ${response.status} ${response.statusText}`,
		);
		core.error(`[${functionName}] API linking error body: ${JSON.stringify(response.data)}`);
		// Link failure should likely fail the action
		throw new Error(
			`Seal API linking failed with status ${response.status}: ${JSON.stringify(response.data)}. Files were uploaded but not linked.`,
		);
	}

	// Optional: Check response body for success/error messages if API provides them
	if (response.data?.message) {
		core.warning(
			`[${functionName}] Linking attempt seemed successful (Status ${response.status}) but response might indicate an issue: ${response.data.message}`,
		);
	} else {
		core.info(
			`[${functionName}] Successfully linked ${fileReferences.length} file(s) to Seal entity field "${fieldName}".`,
		);
	}
}

export async function archiveEntities(
	apiUrl: string,
	apiToken: string,
	fileRefs: SealFileReference[] | undefined,
): Promise<void> {
	const functionName = 'archiveEntities';
	if (!fileRefs || fileRefs.length === 0) {
		core.info(`[${functionName}] No existing file references provided. Skipping archival.`);
		return;
	}

	core.info(`[${functionName}] Attempting to archive ${fileRefs.length} existing entity/file reference(s)...`);

	const baseUrl = normalizeApiUrl(apiUrl);
	const archivePromises = fileRefs.map(async (ref) => {
		if (!ref?.id) {
			core.warning(`[${functionName}] Skipping invalid file reference: ${JSON.stringify(ref)}`);
			return { id: 'invalid', status: 'skipped' };
		}

		const entityId = ref.id;
		const url = `${baseUrl}entities/${entityId}/archive`;
		const config: AxiosRequestConfig = {
			...createApiConfig(apiToken),
			method: 'POST',
			url,
		};

		core.debug(`[${functionName}] Making POST request to ${url} for entity ID ${entityId}`);
		try {
			const response = await axios(config);
			if (response.status === 200) {
				core.info(`[${functionName}] Successfully archived entity ID: ${entityId}`);
				return { id: entityId, status: 'success' };
			} 
				core.warning(`[${functionName}] Received non-200 status (${response.status}) attempting to archive entity ID ${entityId}: ${JSON.stringify(response.data)}`);
				return { id: entityId, status: 'failed', error: `Status ${response.status}` };
			
		} catch (error: unknown) {
			let message = 'Unknown error';
			if (error instanceof Error) message = error.message;
			core.error(`[${functionName}] Failed to archive entity ID ${entityId}: ${message}`);
			if (axios.isAxiosError(error)) {
				core.error(`[${functionName}] Response Data: ${JSON.stringify(error.response?.data)}`);
			}
			return { id: entityId, status: 'failed', error: message };
		}
	});

	 await Promise.allSettled(archivePromises);

	 return 
} 