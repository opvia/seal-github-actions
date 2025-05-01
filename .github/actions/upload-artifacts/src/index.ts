import * as core from '@actions/core';
import * as glob from '@actions/glob';
import path from 'node:path';
import {
	getUploadArtifactsInputs,
	getPullRequestContext,
	type PullRequestContext,
	type UploadArtifactsInputs,
} from '../../common/src/github-context.js'; // Adjust path as needed if compiled differently
import {
	getSealFileVersion,
	linkFilesToEntityField,
	uploadSealFile,
	getSealEntityChangeSetIndex,
	addEntityToChangeSet,
	type SealFileReference,
	findSealEntity, // Import the type if not already exported/imported
	archiveEntities, // Import the archiveEntities function
} from '../../common/src/seal-api.js'; // Adjust path

/**
 * Main function for the Upload Artifacts action.
 */
async function run(): Promise<void> {
	core.startGroup('Initialization');
	const inputs: UploadArtifactsInputs = getUploadArtifactsInputs();
	const prContext: PullRequestContext | null = getPullRequestContext();

	if (!prContext) {
		core.info('Action is not running in the context of a Pull Request. Skipping.');
		core.endGroup();
		return;
	}
	core.info(`Running for PR #${prContext.prNumber} in workspace ${prContext.workspace}`);
	core.debug(`Inputs: ${JSON.stringify(inputs)}`);
	core.endGroup();

	try {
		// --- Step 1: Find Artifact Files ---
		core.startGroup('Finding Artifact Files');
		const patterns = inputs.artifactPatterns.split(/\s+/).filter(p => p.length > 0); // Split by space and remove empty strings
        if (patterns.length === 0) {
            core.warning('No artifact patterns provided.');
            core.endGroup();
            return; // Exit gracefully if no patterns
        }
		core.info(`Searching for patterns: ${patterns.join(', ')} in ${prContext.workspace}`);

		const globOptions = {
			followSymbolicLinks: false, 
			implicitDescendants: true,
			matchDirectories: false, 
			cwd: prContext.workspace // <-- Explicitly set the CWD for glob
		};
		const globber = await glob.create(patterns.join('\n'), globOptions);
		const foundFiles: string[] = await globber.glob(); // Returns absolute paths

		if (foundFiles.length === 0) {
			core.info('No artifact files found matching the specified patterns. Nothing to upload.');
			core.endGroup();
			return; // Exit successfully
		}
		core.info(`Found ${foundFiles.length} artifact files:`);
        for (const file of foundFiles) {
            core.info(`  - ${path.relative(prContext.workspace, file)}`); // Log relative path
        }
		core.endGroup();

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

		// --- Step 2b: Get Changeset Index for the Target Entity ---
		core.startGroup('Getting Changeset Index');
		const changeSetIndex = await getSealEntityChangeSetIndex(
			inputs.sealApiBaseUrl,
			inputs.sealApiToken,
			entityId,
		);
		core.endGroup();

		// --- Step 3: Upload Artifacts, Add to Changeset & Collect Refs ---
		core.startGroup('Processing Artifacts (Upload & Add to Changeset)');
        const timestamp = new Date().valueOf();
		const uploadedFileRefs: SealFileReference[] = [];
		let processingFailedCount = 0;

		for (const filePath of foundFiles) {
			const originalFilename = path.basename(filePath);
			const relativePath = path.relative(prContext.workspace, filePath);
			// Construct unique filename for Seal using timestamp
			const sealFilename = `artifact-${originalFilename}-PR${prContext.prNumber}-${timestamp}`;
			core.info(`Processing artifact: ${relativePath} -> ${sealFilename}`);

			let fileId: string | null = null; // Keep track of fileId in case changeset add fails

			try {
				// 1. Upload the file
				core.debug(` -> Uploading...`);
				fileId = await uploadSealFile(
					inputs.sealApiBaseUrl,
					inputs.sealApiToken,
					filePath, // Pass absolute path
					sealFilename,
					inputs.sealFileTypeTitle,
				);
				core.debug(` -> Uploaded. File ID: ${fileId}`);

				// 2. Add the uploaded file entity to the changeset
				core.debug(` -> Adding File ID ${fileId} to Changeset Index ${changeSetIndex}...`);
				await addEntityToChangeSet(
					inputs.sealApiBaseUrl,
					inputs.sealApiToken,
					fileId,
					changeSetIndex,
				);
				core.debug(` -> Added to changeset.`);

				// 3. Get the file version (needed for linking)
				core.debug(` -> Getting file version...`);
				const fileVersion = await getSealFileVersion(
					inputs.sealApiBaseUrl,
					inputs.sealApiToken,
					fileId,
				);
				core.debug(` -> File version: ${fileVersion ?? 'null'}`);

				uploadedFileRefs.push({ id: fileId, version: fileVersion });
				core.info(` -> Successfully processed ${sealFilename}. File ID: ${fileId}, Version: ${fileVersion ?? 'null'}`);

			} catch (error: unknown) {
				processingFailedCount++;
				const action = fileId ? 'add to changeset or get version' : 'upload';
				// Log error but continue processing other files
				core.error(`Processing failed for "${relativePath}" during ${action}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
        core.info(`Finished processing. Succeeded: ${uploadedFileRefs.length}, Failed: ${processingFailedCount}.`);
		core.endGroup();


		// --- Step 4: Link Successfully Processed Files to Entity ---
        core.startGroup('Linking Files to Seal Entity');
		if (uploadedFileRefs.length === 0) {
			core.info('No files were successfully processed (uploaded and added to changeset). Skipping linking step.');
			if (processingFailedCount > 0) {
				// If any processing step failed, the overall action should fail
				throw new Error(`${processingFailedCount} artifact processing step(s) failed.`);
			}
            // If no files were uploaded but no errors occurred (e.g., no matching files found initially), exit gracefully.
            // This case is technically handled earlier, but included for robustness.
            core.endGroup();
			return;
		}

		// --- Step 4a: Archive Previous Artifacts ---
		core.startGroup('Archiving Previous Artifacts');
		const existingFileRefs = entity.fields?.[inputs.fieldName]?.value;
		await archiveEntities(
			inputs.sealApiBaseUrl,
			inputs.sealApiToken,
			existingFileRefs,
		);
		core.endGroup();

		// --- Step 4b: Link New Files to Entity ---
		await linkFilesToEntityField(
			inputs.sealApiBaseUrl,
			inputs.sealApiToken,
			entityId,
			inputs.fieldName, // Use the correct field name for artifacts
			uploadedFileRefs,
		);
		core.endGroup();

        core.info('✅ Upload Artifacts Action Completed Successfully.');


	} catch (error: unknown) {
		core.endGroup(); // Ensure groups are ended on error
		core.setFailed(error instanceof Error ? error.message : String(error));
	}
}

// Execute the run function
void run();
