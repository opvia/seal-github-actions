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
	findSealEntityId,
	getSealFileVersion,
	linkFilesToEntityField,
	uploadSealFile,
	type SealFileReference, // Import the type if not already exported/imported
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

		const globber = await glob.create(patterns.join('\n'), {
            followSymbolicLinks: false, // Match behavior of default find
            implicitDescendants: true,
            matchDirectories: false, // We only want files
         });
		const foundFiles: string[] = await globber.glob(); // Returns absolute paths

		if (foundFiles.length === 0) {
			core.info('No artifact files found matching the specified patterns. Nothing to upload.');
			core.endGroup();
			return; // Exit successfully
		}
		core.info(`Found ${foundFiles.length} artifact files:`);
        foundFiles.forEach(file => core.info(`  - ${path.relative(prContext.workspace, file)}`)); // Log relative path
		core.endGroup();

		// --- Step 2: Find Target Seal Entity ---
		core.startGroup('Finding Seal Entity');
		const entityId = await findSealEntityId(
			inputs.sealApiBaseUrl,
			inputs.sealApiToken,
			prContext.prNumber,
			inputs.sealTemplateId,
		);
		core.endGroup();

		// --- Step 3: Upload Artifacts & Collect IDs/Versions ---
		core.startGroup('Uploading Artifacts');
		const uploadedFileRefs: SealFileReference[] = [];
		let uploadFailedCount = 0;
		let uploadCounter = 0;

		for (const filePath of foundFiles) {
            uploadCounter++;
			const originalFilename = path.basename(filePath);
			// Construct unique filename for Seal
			const sealFilename = `artifact-${originalFilename}-pr${prContext.prNumber}-index${uploadCounter}`;
			core.info(`Attempting upload for: ${path.relative(prContext.workspace, filePath)} as ${sealFilename}`);

			try {
				const fileId = await uploadSealFile(
					inputs.sealApiBaseUrl,
					inputs.sealApiToken,
					filePath, // Pass absolute path
					sealFilename,
					inputs.sealFileTypeTitle,
				);

				// Get version immediately after successful upload
				const fileVersion = await getSealFileVersion(
					inputs.sealApiBaseUrl,
					inputs.sealApiToken,
					fileId,
				);

				uploadedFileRefs.push({ id: fileId, version: fileVersion });
				core.info(` -> Successfully uploaded ${sealFilename}. File ID: ${fileId}, Version: ${fileVersion ?? 'null'}`);

			} catch (error: unknown) {
				uploadFailedCount++;
				// Log warning but continue processing other files
				core.warning(`Upload failed for "${filePath}": ${error instanceof Error ? error.message : String(error)}`);
			}
		}
        core.info(`Finished uploading. Successful: ${uploadedFileRefs.length}, Failed: ${uploadFailedCount}.`);
		core.endGroup();


		// --- Step 4: Link Uploaded Files to Entity ---
        core.startGroup('Linking Files to Seal Entity');
		if (uploadedFileRefs.length === 0) {
			core.info('No files were successfully uploaded. Skipping linking step.');
			if (uploadFailedCount > 0) {
				// If uploads failed, the overall action should fail
				throw new Error(`${uploadFailedCount} artifact upload(s) failed.`);
			}
            // If no files were uploaded but no errors occurred (e.g., no matching files found initially), exit gracefully.
            // This case is technically handled earlier, but included for robustness.
            core.endGroup();
			return;
		}

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
