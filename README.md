# Seal GitHub Actions Repository

This repository contains reusable GitHub Actions designed to integrate GitHub workflows with the Seal platform. These actions automate common tasks related to change control and artifact management within Seal.

## Actions

### 1. Codebase Snapshot Action (`.github/actions/codebase-snapshot`)

This action captures a snapshot of the repository's codebase at the time a pull request is active and links it to a corresponding entity in Seal.

**Functionality:**

1.  **Trigger:** Designed to run in the context of a pull request.
2.  **Archive Creation:** Creates an archive (either `.zip` or `.tar.gz`) of the entire checked-out codebase. It allows specifying file patterns (`exclude_patterns`) to exclude certain files or directories (like `.git` or `node_modules`) from the archive.
3.  **Seal Entity Lookup:** Searches for a specific Seal entity (typically representing a change request) using the pull request number (`#<PR_NUMBER>`) and a provided `seal_template_id` to ensure the correct type of entity is found. It requires a unique match.
4.  **Archive Upload:** Uploads the generated archive file to Seal, assigning it a filename based on the repository, PR number, and timestamp, along with a specified file type title (`seal_file_type_title`).
5.  **Linking:** Fetches the ID and version of the uploaded archive file entity in Seal and then links this file reference to a specified field (`seal_snapshot_field_name`, defaulting to 'Code Snapshot') on the previously found Seal entity.

**Purpose:** To provide a verifiable record of the exact codebase state associated with a specific change request tracked in Seal.

**Inputs:**

*   `seal_api_token` (required): Seal API Token.
*   `seal_api_base_url` (required): Seal API Base URL (e.g., `https://us.backend.seal.run/api/`).
*   `seal_template_id` (required): Seal Template ID for the target change control entity.
*   `seal_snapshot_field_name` (optional, default: `Code Snapshot`): Name of the reference field in the Seal entity to link the snapshot.
*   `seal_file_type_title` (optional, default: `GitHub Artifacts`): Title for the uploaded file type in Seal.
*   `exclude_patterns` (optional): Space-separated glob patterns to exclude from the archive (e.g., `.git/* node_modules/*`).
*   `archive_type` (optional, default: `zip`): The type of archive to create (supported: `zip`, `tar`).

### 2. Upload Artifacts Action (`.github/actions/upload-artifacts`)

This action finds specific files (artifacts) within the repository based on patterns and links them to a corresponding entity in Seal.

**Functionality:**

1.  **Trigger:** Designed to run in the context of a pull request.
2.  **Artifact Discovery:** Finds files within the workspace that match one or more space-separated glob patterns provided via the `artifact_patterns` input.
3.  **Seal Entity Lookup:** Searches for a specific Seal entity using the pull request number (`#<PR_NUMBER>`) and a provided `seal_template_id`. It requires a unique match.
4.  **Individual File Upload:** Uploads each found artifact file *individually* to Seal. Each uploaded file is given a unique name including the original filename, PR number, and an index, along with a specified file type title (`seal_file_type_title`).
5.  **Linking:** Collects the ID and version of each successfully uploaded artifact file entity. It then links *all* these file references as a list to a specified field (`seal_field_name`) on the previously found Seal entity.

**Purpose:** To attach specific outputs, documentation, or evidence related to a change request (e.g., build outputs, test reports, updated READMEs) directly to the corresponding record in Seal.

**Inputs:**

*   `seal_api_token` (required): Seal API Token.
*   `seal_api_base_url` (required): Seal API Base URL (e.g., `https://us.backend.seal.run/api/`).
*   `seal_template_id` (required): Seal Template ID for the target change control entity.
*   `artifact_patterns` (required): Space-separated glob patterns matching the artifacts to upload (e.g., `"test-results/*.xml" "build/*.log"`).
*   `seal_field_name` (optional, default: `Release Artifact(s)`): Name of the reference field in the Seal entity to link the artifacts.
*   `seal_file_type_title` (optional, default: `GitHub-Artifacts`): Title for the uploaded file type in Seal.

## Usage

These actions run as self-contained Docker containers executing Node.js and are intended to be called from workflow files (`.github/workflows/`) in other repositories that need to integrate with Seal.

To use an action, reference its published Docker image on GitHub Container Registry (GHCR). Refer to the respective `action.yml` files within each action's directory for detailed input parameters and defaults.

**Example (`upload-artifacts`):**

```yaml
jobs:
  upload_files:
    runs-on: ubuntu-latest
    permissions:
      contents: read        # To checkout code
      pull-requests: read # To read PR context
      packages: read      # To pull image from GHCR
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      # Add steps here to generate artifacts if needed

      - name: Upload Artifacts to Seal
        # Replace 'main' with a specific version tag (e.g., v2.0.0) once released
        uses: docker://ghcr.io/opvia/upload-artifacts-action:main
        with:
          seal_api_token: ${{ secrets.SEAL_API_TOKEN }}
          seal_api_base_url: 'https://your-seal-instance.com/api/' # Your Seal API URL
          seal_template_id: 'your-template-uuid' # Template ID for the entity to link to
          artifact_patterns: '"./path/to/artifacts/*.xml" "./another/path/*.log"'
          # Optional inputs:
          # seal_field_name: 'Linked Artifacts'
          # seal_file_type_title: 'CI Artifacts'
```
