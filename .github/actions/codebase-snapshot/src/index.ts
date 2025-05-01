import * as core from '@actions/core';
import archiver from 'archiver'
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
	getCodebaseSnapshotInputs,
	getPullRequestContext,
	type PullRequestContext,
	type CodebaseSnapshotInputs,
} from '../../common/src/github-context.js'; // Adjust paths if structure differs
import {
	findSealEntity,
	getSealFileVersion,
	linkFilesToEntityField,
	uploadSealFile,
	getSealEntityChangeSetIndex,
	addEntityToChangeSet,
	type SealFileReference,
	archiveEntities,
} from '../../common/src/seal-api.js'; // Adjust paths

// Define types for archiver errors
interface ArchiverError extends Error {
	code?: string;
}

interface ArchiveFormatConfig {
	format: 'zip' | 'tar';
	extension: string;
	gzip: boolean;
}

/**
 * Gets the archive format configuration based on the specified type.
 * @param archiveType The type of archive to create
 * @returns Object containing format and extension information
 * @throws Error if the archive type is not supported
 */
function getArchiveFormat(archiveType: string): ArchiveFormatConfig {
	switch (archiveType) {
		case 'zip':
			return {
				format: 'zip',
				extension: 'zip',
				gzip: false
			};
		case 'tar':
			return {
				format: 'tar',
				extension: 'tar.gz',
				gzip: true
			};
		default:
			throw new Error(`Unsupported archive type: ${archiveType}. Supported types are 'zip' and 'tar'.`);
	}
}

/**
 * Creates the codebase archive.
 * @returns The absolute path to the created archive file.
 */
async function createArchive(
	inputs: CodebaseSnapshotInputs,
	prContext: PullRequestContext,
	snapshotDir: string, // Temporary directory path
): Promise<string> {
	core.startGroup('Creating Codebase Archive');
	const timestamp = new Date().valueOf();
	
	// Get archive format configuration
	const archiveConfig = getArchiveFormat(inputs.archiveType);
	
	const archiveName = `${prContext.repoName}-PR${prContext.prNumber}-${timestamp}.${archiveConfig.extension}`;
	const archivePath = path.join(snapshotDir, archiveName);

	core.info(`Archive type: ${archiveConfig.format} (${archiveConfig.extension})`);
	core.info(`Archive path: ${archivePath}`);

	const patterns = inputs.excludePatterns.split(/\s+/).filter(p => p.length > 0);
	core.info(`Exclude patterns: ${patterns.join(', ') || 'None'}`);

	return new Promise<string>((resolve, reject) => {
		const output = fsSync.createWriteStream(archivePath);
		const archive = archiver(archiveConfig.format, {
			gzip: archiveConfig.gzip,
			zlib: { level: 9 } // Maximum compression level
		});

		output.on('close', async () => {
			try {
				const stats = await fs.stat(archivePath);
				if (stats.size === 0) {
					reject(new Error(`Created archive file is empty: ${archivePath}`));
					return;
				}
				core.info(`✅ Successfully created ${archiveConfig.format} archive: ${archiveName} (${archive.pointer()} bytes)`);
				core.endGroup();
				resolve(archivePath);
			} catch (statError) {
				reject(new Error(`Failed to stat created archive file "${archivePath}": ${JSON.stringify(statError)}`));
			}
		});

		output.on('error', (err: Error) => {
			reject(new Error(`Output stream error: ${err.message}`));
		});

		archive.on('warning', (err: ArchiverError) => {
			if (err.code === 'ENOENT') {
				// File not found warning
				core.warning(`Warning during archiving: ${err.message}`);
			} else {
				reject(new Error(`Archiving error: ${err.message}`));
			}
		});

		archive.on('error', (err: ArchiverError) => {
			reject(new Error(`Archiving failed: ${err.message}`));
		});

		archive.pipe(output);

		// Add files from the workspace directory, excluding specified patterns
		archive.glob('**/*', {
			cwd: prContext.workspace,
			ignore: patterns,
			dot: true // Include dotfiles
		});

		archive.finalize();
	});
}

/**
 * Main function for the Codebase Snapshot action.
 */
async function run(): Promise<void> {
	core.startGroup('Initialization');
	const inputs: CodebaseSnapshotInputs = getCodebaseSnapshotInputs();
	const prContext: PullRequestContext | null = getPullRequestContext();

	if (!prContext) {
		core.info('Action is not running in the context of a Pull Request. Skipping.');
		core.endGroup();
		return;
	}
	core.info(`Running for PR #${prContext.prNumber} in workspace ${prContext.workspace}`);
	core.debug(`Inputs: ${JSON.stringify(inputs)}`);
	core.endGroup();

	let snapshotDir: string | null = null;
	let archivePath: string | null = null;

	try {
		// --- Step 1: Create Codebase Archive ---
		snapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codebase-snapshot-'));
		core.info(`Created temporary directory: ${snapshotDir}`);
		archivePath = await createArchive(inputs, prContext, snapshotDir);

		// --- Step 2: Find Target Seal Entity ---
		core.startGroup('Finding Seal Entity');
		const entity = await findSealEntity(
			inputs.sealApiBaseUrl,
			inputs.sealApiToken,
			prContext.prNumber,
			inputs.sealTemplateId,
		);
		const entityId = entity.id;
		core.endGroup();

		// --- Step 2b: Get Changeset Index ---
		core.startGroup('Getting Changeset Index');
		const changeSetIndex = await getSealEntityChangeSetIndex(
			inputs.sealApiBaseUrl,
			inputs.sealApiToken,
			entityId,
		);
		core.endGroup();

		// --- Step 3: Upload Codebase Archive ---
		core.startGroup('Uploading Codebase Snapshot');
		const sealFilename = path.basename(archivePath); // Use the generated archive name
		const fileId = await uploadSealFile(
			inputs.sealApiBaseUrl,
			inputs.sealApiToken,
			archivePath, // Pass absolute path to archive
			sealFilename,
			inputs.sealFileTypeTitle,
		);
		core.endGroup();

		// --- Step 3b: Add Snapshot to Changeset ---
		core.startGroup('Adding Snapshot to Changeset');
		await addEntityToChangeSet(
			inputs.sealApiBaseUrl,
			inputs.sealApiToken,
			fileId,
			changeSetIndex,
		);
		core.endGroup();

		// -- Step 4a: Archive previous seal snapshot file
		core.startGroup('Archiving Previous Seal Snapshot File');
		const existingFiledRefs = entity.fields?.[inputs.snapshotFieldName]?.value;
		await archiveEntities(
			inputs.sealApiBaseUrl,
			inputs.sealApiToken,
			existingFiledRefs,
		);
		core.endGroup();

		// --- Step 4b: Link File to Entity ---
		core.startGroup('Linking Snapshot to Seal Entity');
		const fileVersion = await getSealFileVersion(
			inputs.sealApiBaseUrl,
			inputs.sealApiToken,
			fileId,
		);

		const fileReferences: SealFileReference[] = [{ id: fileId, version: fileVersion }];

		// Use snapshotFieldName input here
		await linkFilesToEntityField(
			inputs.sealApiBaseUrl,
			inputs.sealApiToken,
			entityId,
			inputs.snapshotFieldName,
			fileReferences,
		);
		core.endGroup();

		core.info('✅ Codebase Snapshot Action Completed Successfully.');

	} catch (error: unknown) {
		core.endGroup(); // Ensure groups are ended on error
		core.setFailed(error instanceof Error ? error.message : String(error));
	} finally {
		// --- Step 5: Cleanup ---
		if (snapshotDir) {
			core.startGroup('Cleanup');
			try {
				core.info(`Removing temporary directory: ${snapshotDir}`);
				await fs.rm(snapshotDir, { recursive: true, force: true });
				core.info('Temporary directory removed.');
			} catch (cleanupError: unknown) {
				// Log cleanup error but don't fail the action because of it
				core.warning(`Failed to remove temporary directory "${snapshotDir}": ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
			}
			core.endGroup();
		}
	}
}

void run();
