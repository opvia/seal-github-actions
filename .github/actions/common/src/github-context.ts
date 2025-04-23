import * as core from '@actions/core';
import * as github from '@actions/github'; // Use the toolkit context

/** Defines the common inputs expected by both actions */
interface CommonInputs {
	sealApiToken: string;
	sealApiBaseUrl: string;
	sealTemplateId: string;
	sealFileTypeTitle: string; // Has different defaults but is common
}

/** Specific inputs for the Codebase Snapshot action */
export interface CodebaseSnapshotInputs extends CommonInputs {
	snapshotFieldName: string;
	excludePatterns: string; // Optional, space-separated
	archiveType: 'zip' | 'tar'; // With default
}

/** Specific inputs for the Upload Artifacts action */
export interface UploadArtifactsInputs extends CommonInputs {
	fieldName: string;
	artifactPatterns: string; // Required, space-separated
}

/** Structure for relevant Pull Request context */
export interface PullRequestContext {
	repoOwner: string;
	repoName: string;
	prNumber: number;
	prTitle: string;
	headRef: string;
	baseRef: string;
	commitSha: string;
	workspace: string;
}

// --- Functions ---

/**
 * Checks if the current workflow event is related to a pull request.
 */
export function isPullRequestEvent(): boolean {
	return (
		github.context.eventName === 'pull_request' ||
		github.context.eventName === 'pull_request_target'
	);
}

/**
 * Retrieves and validates inputs for the Codebase Snapshot action.
 */
export function getCodebaseSnapshotInputs(): CodebaseSnapshotInputs {
	const inputs = {
		sealApiToken: core.getInput('seal_api_token', { required: true }),
		sealApiBaseUrl: core.getInput('seal_api_base_url', { required: true }),
		sealTemplateId: core.getInput('seal_template_id', { required: true }),
		snapshotFieldName: core.getInput('seal_snapshot_field_name', { required: false }) || 'Code Snapshot', // Default from action.yml
		sealFileTypeTitle: core.getInput('seal_file_type_title', { required: false }) || 'GitHub Artifacts', // Default from action.yml
		excludePatterns: core.getInput('exclude_patterns', { required: false }),
		archiveType: core.getInput('archive_type', { required: false }) || 'zip', // Default from action.yml
	};

	if (inputs.archiveType !== 'zip' && inputs.archiveType !== 'tar') {
		throw new Error(`Unsupported archive_type: ${inputs.archiveType}. Must be 'zip' or 'tar'.`);
	}

	return inputs as CodebaseSnapshotInputs; // Cast after validation
}

/**
 * Retrieves and validates inputs for the Upload Artifacts action.
 */
export function getUploadArtifactsInputs(): UploadArtifactsInputs {
	return {
		sealApiToken: core.getInput('seal_api_token', { required: true }),
		sealApiBaseUrl: core.getInput('seal_api_base_url', { required: true }),
		sealTemplateId: core.getInput('seal_template_id', { required: true }),
		fieldName: core.getInput('seal_field_name', { required: false }) || 'Release Artifact(s)', // Default from action.yml
		sealFileTypeTitle: core.getInput('seal_file_type_title', { required: false }) || 'GitHub-Artifacts', // Default from action.yml
		artifactPatterns: core.getInput('artifact_patterns', { required: true }),
	};
}

/**
 * Gets relevant context if the event is a pull request.
 * Returns null otherwise or if essential PR data is missing.
 */
export function getPullRequestContext(): PullRequestContext | null {
	if (!isPullRequestEvent()) {
		core.info('Not running in the context of a pull request event. Skipping PR context retrieval.');
		return null;
	}

	const prPayload = github.context.payload.pull_request;

	if (!prPayload) {
		core.warning('Event is pull_request type, but payload.pull_request is missing.');
		return null;
	}

	const prNumber = prPayload.number;
	const prTitle = prPayload.title ?? ''; // Use empty string if title is null/undefined
	const headRef = prPayload.head?.ref;
	const baseRef = prPayload.base?.ref;
	const repoOwner = github.context.repo.owner;
	const repoName = github.context.repo.repo;
	const commitSha = github.context.sha; // SHA of the commit that triggered the workflow
    const workspace = process.env['GITHUB_WORKSPACE'];

	if (!prNumber || !headRef || !baseRef || !workspace) {
		core.warning(`Missing essential PR context data: prNumber=${prNumber}, headRef=${headRef}, baseRef=${baseRef}, workspace=${workspace}`);
		return null;
	}

    const context: PullRequestContext = {
        repoOwner,
        repoName,
        prNumber,
        prTitle,
        headRef,
        baseRef,
        commitSha,
        workspace,
    };

    core.info(`PR Context: PR #${context.prNumber} ('${context.prTitle}')`);
    core.debug(`Full PR Context: ${JSON.stringify(context)}`);
    return context;

} 