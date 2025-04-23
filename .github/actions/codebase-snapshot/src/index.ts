import * as core from '@actions/core';
import * as exec from '@actions/exec';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
	getCodebaseSnapshotInputs,
	getPullRequestContext,
	type PullRequestContext,
	type CodebaseSnapshotInputs,
} from '../../common/src/github-context.js'; // Adjust paths if structure differs
import {
	findSealEntityId,
	getSealFileVersion,
	linkFilesToEntityField,
	uploadSealFile,
	type SealFileReference,
} from '../../common/src/seal-api.js'; // Adjust paths

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
	const timestamp = new Date().valueOf()
	const extension = inputs.archiveType === 'zip' ? 'zip' : 'tar.gz';
	const archiveName = `${prContext.repoName}-PR${prContext.prNumber}-${timestamp}.${extension}`;
	const archivePath = path.join(snapshotDir, archiveName);

	core.info(`Archive type: ${inputs.archiveType}`);
	core.info(`Archive path: ${archivePath}`);

	const command = inputs.archiveType; // 'zip' or 'tar'
	const args: string[] = [];
	const patterns = inputs.excludePatterns.split(/\s+/).filter(p => p.length > 0);
	core.info(`Exclude patterns: ${patterns.join(', ') || 'None'}`);

	// Construct command arguments
	if (command === 'zip') {
		args.push('-r', archivePath, '.'); // recursive, output file, source dir
		patterns.forEach(pattern => args.push('-x', pattern));
	} else { // tar
		args.push('czf', archivePath); // create, gzip, file
		patterns.forEach(pattern => args.push(`--exclude=${pattern}`));
		args.push('.'); // source dir MUST be last for tar --exclude
	}

	core.info(`Running command: ${command} ${args.join(' ')} in ${prContext.workspace}`);

	const execOptions: exec.ExecOptions = {
		cwd: prContext.workspace, // Run command in the checked-out code directory
	};

	const exitCode = await exec.exec(command, args, execOptions);
	if (exitCode !== 0) {
		throw new Error(`Archiving command '${command}' failed with exit code ${exitCode}`);
	}

	// Verify archive exists and is not empty
	try {
		const stats = await fs.stat(archivePath);
		if (stats.size === 0) {
			throw new Error(`Created archive file is empty: ${archivePath}`);
		}
		core.info(`✅ Successfully created ${inputs.archiveType} archive: ${archiveName} (${stats.size} bytes)`);
	} catch (statError) {
		throw new Error(`Failed to stat created archive file "${archivePath}": ${JSON.stringify(statError)}`);
	}

	core.endGroup();
	return archivePath; // Return the full path
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
		const entityId = await findSealEntityId(
			inputs.sealApiBaseUrl,
			inputs.sealApiToken,
			prContext.prNumber,
			inputs.sealTemplateId,
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

		// --- Step 4: Link File to Entity ---
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
