import * as core from '@actions/core';
import axios, { AxiosError, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import fs from 'node:fs';
import path from 'node:path';

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
	// Add other potentially useful fields if needed
}

// Response structure for successful file upload
interface SealFileUploadResponse {
	id: string;
	// The response might be the full SealEntityLite, but only ID is strictly needed
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
		validateStatus: function (status: number) {
			// Don't throw for non-2xx status, handle it manually
			return status >= 200 && status < 500;
		},
	};
}

// --- API Functions ---

/**
 * Finds a unique Seal entity by PR number within its title and matching template ID.
 * @returns The ID of the found entity.
 * @throws If no unique entity is found or API error occurs.
 */
export async function findSealEntityId(
	apiUrl: string,
	apiToken: string,
	prNumber: number,
	templateId: string,
): Promise<string> {
	const functionName = 'findSealEntityId';
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

	const entityId = matchingEntities[0]?.id;
	if (!entityId) {
		core.error(`[${functionName}] Found unique Seal entity ID: ${entityId}`);
		throw new Error(`Found unique Seal entity ID: ${entityId}`);
	}
	core.info(`[${functionName}] Found unique Seal entity ID: ${entityId}`);
	return entityId;
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
		} else {
			throw error; // Re-throw other errors
		}
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
		} else {
			throw error; // Re-throw other errors
		}
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
	core.info(
		`[${functionName}] Uploading file "${path.basename(filePath)}" as "${sealFilename}" with type "${fileTypeTitle}"`,
	);

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
		},
		data: fileStream,
		maxContentLength: Infinity, // Needed for large file uploads
		maxBodyLength: Infinity,
	};

	core.debug(`[${functionName}] Making POST request to ${url}`);
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
			core.error(`[${functionName}] Response Data: ${JSON.stringify(error.response?.data)}`);
			message = `Axios error: ${message}`;
		} else {
			core.error(`[${functionName}] Non-axios error during request: ${error}`);
		}
		throw new Error(`Failed to upload file "${sealFilename}": ${message}`);
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