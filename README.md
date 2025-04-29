# Seal GitHub Actions Repository

> **⚠️ Under active development:** These GitHub Actions are currently under active development. Functionality, inputs, and usage patterns may change. If you have any suggestions please raise an issue or notify the seal team at support@seal.run. It is recommended to pin to specific commit SHAs or version tags once available, rather than using `@main` or `:latest` in production workflows.

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

*   `seal_api_token` (required): Seal API Token. Use `${{ secrets.SEAL_API_TOKEN }}`.
*   `seal_api_base_url` (required): Seal API Base URL (e.g., `https://us.backend.seal.run/api/`).
*   `seal_template_id` (required): Seal Template ID for the target change control entity.
*   `seal_snapshot_field_name` (optional, default: `Code Snapshot`): Name of the reference field in the Seal entity to link the snapshot.
*   `seal_file_type_title` (optional, default: `GitHub Artifacts`): Title for the uploaded file type in Seal.
*   `exclude_patterns` (optional): Space-separated glob patterns to exclude from the archive (e.g., `.git/* node_modules/*`).
*   `archive_type` (optional, default: `zip`): The type of archive to create (supported: `zip`, `tar.gz`).

### 2. Upload Artifacts Action (`.github/actions/upload-artifacts`)

This action finds specific files (artifacts) within the repository based on patterns and links them to a corresponding entity in Seal.

**Functionality:**

1.  **Trigger:** Designed to run in the context of a pull request or other events (e.g., release).
2.  **Artifact Discovery:** Finds files within the workspace that match one or more space-separated glob patterns provided via the `artifact_patterns` input.
3.  **Seal Entity Lookup:** Searches for a specific Seal entity using the pull request number (`#<PR_NUMBER>`) and a provided `seal_template_id`. It requires a unique match. (Lookup method might be configurable in future versions).
4.  **Individual File Upload:** Uploads each found artifact file *individually* to Seal. Each uploaded file is given a unique name including the original filename, PR number (if applicable), and an index, along with a specified file type title (`seal_file_type_title`).
5.  **Linking:** Collects the ID and version of each successfully uploaded artifact file entity. It then links *all* these file references as a list to a specified field (`seal_field_name`) on the previously found Seal entity.

**Purpose:** To attach specific outputs, documentation, or evidence related to a change request (e.g., build outputs, test reports, updated READMEs) directly to the corresponding record in Seal.

**Inputs:**

*   `seal_api_token` (required): Seal API Token. Use `${{ secrets.SEAL_API_TOKEN }}`.
*   `seal_api_base_url` (required): Seal API Base URL (e.g., `https://us.backend.seal.run/api/`).
*   `seal_template_id` (required): Seal Template ID for the target change control entity.
*   `artifact_patterns` (required): Space-separated glob patterns matching the artifacts to upload (e.g., `"dist/**/*.js" "docs/*.pdf"`). Use quotes if patterns contain spaces or special characters.
*   `seal_field_name` (optional, default: `Release Artifact(s)`): Name of the reference field in the Seal entity to link the artifacts.
*   `seal_file_type_title` (optional, default: `GitHub-Artifacts`): Title for the uploaded file type in Seal.

## Usage

These actions are intended to be called from workflow files (`.github/workflows/`) in your repositories that need to integrate with Seal. You can use them either by referencing the published Docker image on GitHub Container Registry (GHCR) or by checking out this repository and referencing the action path directly.

**Note:** Replace placeholder values like `YOUR_SEAL_API_BASE_URL`, `YOUR_SEAL_CHANGE_CONTROL_TEMPLATE_ID`, etc., with your actual configuration. Pinning to a specific version tag (e.g., `:v1.0.0` for Docker, `@v1.0.0` for repo path) is recommended for stability once versions are released.

### Codebase Snapshot Examples

**1. Using Docker Image:**

```yaml
# .github/workflows/codebase_snapshot_image.yml
name: Codebase Snapshot via Image

on:
  pull_request:
    branches: [ 'main', 'release/*' ] # Adjust trigger branches

permissions:
  contents: read
  pull-requests: read
  packages: read # Required to pull image from GHCR

jobs:
  codebase_snapshot_via_image:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Create and Upload Seal Snapshot
        uses: docker://ghcr.io/opvia/codebase-snapshot-action:latest # Pin to version recommended
        with:
          seal_api_token: ${{ secrets.SEAL_API_TOKEN }}
          seal_api_base_url: 'https://YOUR_SEAL_API_BASE_URL/'
          seal_template_id: 'YOUR_SEAL_CHANGE_CONTROL_TEMPLATE_ID'
          seal_snapshot_field_name: 'Code Snapshot' # Optional
          seal_file_type_title: 'GitHub-CodeSnapshot' # Optional
          exclude_patterns: '.git/* node_modules/* build/* dist/*' # Optional
          archive_type: 'zip' # Optional (zip or tar.gz)
```

**2. Using Repository Path:**

```yaml
# .github/workflows/codebase_snapshot_repo.yml
name: Codebase Snapshot via Repo

on:
  pull_request:
    branches: [ 'main', 'release/*' ] # Adjust trigger branches

permissions:
  contents: read
  pull-requests: read

jobs:
  codebase_snapshot_via_repo:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run Codebase Snapshot Action
        uses: opvia/seal-github-actions/.github/actions/codebase-snapshot@main # Pin to version recommended
        with:
          seal_api_token: ${{ secrets.SEAL_API_TOKEN }}
          seal_api_base_url: 'https://YOUR_SEAL_API_BASE_URL/'
          seal_template_id: 'YOUR_SEAL_CHANGE_CONTROL_TEMPLATE_ID'
          # Optional fields below
          # seal_snapshot_field_name: 'Code Snapshot'
          # seal_file_type_title: 'GitHub-CodeSnapshot'
          # exclude_patterns: '.git/* node_modules/*'
          # archive_type: 'zip'
```

### Upload Artifacts Examples

**1. Using Docker Image:**

```yaml
# .github/workflows/upload_artifacts_image.yml
name: Upload Artifacts via Image

on:
  pull_request: # Or release, workflow_dispatch, etc.
    branches: [ 'main', 'release/*' ]

permissions:
  contents: read
  pull-requests: read
  packages: read # Required to pull image from GHCR

jobs:
  upload_artifacts_via_image:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      # Add your build/artifact generation steps here
      # - name: Build Project
      #   run: npm run build

      - name: Upload Artifacts to Seal
        uses: docker://ghcr.io/opvia/upload-artifacts-action:latest # Pin to version recommended
        with:
          seal_api_token: ${{ secrets.SEAL_API_TOKEN }}
          seal_api_base_url: 'https://YOUR_SEAL_API_BASE_URL/'
          seal_template_id: 'YOUR_SEAL_CHANGE_CONTROL_TEMPLATE_ID'
          artifact_patterns: '"dist/**/*.js" "docs/*.pdf"' # Specify patterns
          # Optional fields below
          # seal_field_name: 'Release Artifacts'
          # seal_file_type_title: 'CI-Artifacts'
```

**2. Using Repository Path:**

```yaml
# .github/workflows/upload_artifacts_repo.yml
name: Upload Artifacts via Repo

on:
  pull_request: # Or release, workflow_dispatch, etc.
    branches: [ 'main', 'release/*' ]

permissions:
  contents: read
  pull-requests: read

jobs:
  upload_artifacts_via_repo:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      # Add your build/artifact generation steps here
      # - name: Build Project
      #   run: npm run build

      - name: Upload Artifacts to Seal
        uses: opvia/seal-github-actions/.github/actions/upload-artifacts@main # Pin to version recommended
        with:
          seal_api_token: ${{ secrets.SEAL_API_TOKEN }}
          seal_api_base_url: 'https://YOUR_SEAL_API_BASE_URL/'
          seal_template_id: 'YOUR_SEAL_CHANGE_CONTROL_TEMPLATE_ID'
          artifact_patterns: '"dist/**/*.js" "docs/*.pdf"' # Specify patterns
          # Optional fields below
          # seal_field_name: 'Release Artifacts'
          # seal_file_type_title: 'CI-Artifacts'
```
