#!/bin/bash
# .github/actions/codebase-snapshot/entrypoint.sh

# Exit immediately if a command exits with a non-zero status.
set -e

log() {
    echo "[CodebaseSnapshotAction] $1"
}

log "Starting..."

# --- Debug: Dump all environment variables ---
log "--- Dumping Environment Variables (Sorted) ---"
env | sort
log "--- End Environment Dump ---"
# --- End Debug ---

if [ -z "$INPUT_SEAL_API_TOKEN" ]; then log "❌ Error: seal_api_token input is required."; exit 1; fi
if [ -z "$INPUT_SEAL_API_BASE_URL" ]; then log "❌ Error: seal_api_base_url input is required."; exit 1; fi
if [ -z "$INPUT_SEAL_TEMPLATE_ID" ]; then log "❌ Error: seal_template_id input is required."; exit 1; fi

SEAL_API_TOKEN="${INPUT_SEAL_API_TOKEN}"
SEAL_API_URL="${INPUT_SEAL_API_BASE_URL}"
SEAL_TEMPLATE_ID="${INPUT_SEAL_TEMPLATE_ID}"

SEAL_SNAPSHOT_FIELD_NAME="${INPUT_SEAL_SNAPSHOT_FIELD_NAME}"
SEAL_FILE_TYPE_TITLE="${INPUT_SEAL_FILE_TYPE_TITLE}"
EXCLUDE_PATTERNS="${INPUT_EXCLUDE_PATTERNS}"
ARCHIVE_TYPE="${INPUT_ARCHIVE_TYPE:-zip}"

cd "${GITHUB_WORKSPACE}" || exit 1

# Check if running in the context of a PR
if [ -z "${GITHUB_HEAD_REF}" ] || [ -z "${GITHUB_BASE_REF}" ]; then
    log "ℹ️ Not running in the context of a pull request (GITHUB_HEAD_REF or GITHUB_BASE_REF is empty). Skipping."
    exit 0
fi
SOURCE_BRANCH="${GITHUB_HEAD_REF}"
TARGET_BRANCH="${GITHUB_BASE_REF}"
REPO_FULL_NAME="${GITHUB_REPOSITORY}"
REPO_NAME=$(echo "${REPO_FULL_NAME}" | cut -d '/' -f 2)
COMMIT_SHA="${GITHUB_SHA}"

PR_NUMBER=$(jq -r .number "${GITHUB_EVENT_PATH}")
PR_TITLE=$(jq -r .pull_request.title "${GITHUB_EVENT_PATH}")

if [ "$PR_NUMBER" == "null" ] || [ -z "$PR_NUMBER" ]; then
    log "❌ Error: Could not extract PR number from event payload at ${GITHUB_EVENT_PATH}."
    exit 1
fi
log "PR Number: ${PR_NUMBER}"
log "PR Title: ${PR_TITLE}"
log "Source Branch: ${SOURCE_BRANCH}, Target Branch: ${TARGET_BRANCH}"
log "Commit SHA: ${COMMIT_SHA}"

[[ "$SEAL_API_URL" != */ ]] && SEAL_API_URL="${SEAL_API_URL}/"
log "Normalized Seal API URL: ${SEAL_API_URL}"

# --- 1. Create Codebase Archive ---
log "Creating codebase archive..."
SNAPSHOT_DIR="snapshot_temp" # Use a temporary name
mkdir -p "${SNAPSHOT_DIR}"
TIMESTAMP=$(date +%Y%m%d%H%M%S)

# Determine archive extension and command based on type
ARCHIVE_EXTENSION=""
ARCHIVE_CMD=""
case "${ARCHIVE_TYPE}" in
    zip)
        ARCHIVE_EXTENSION="zip"
        ARCHIVE_CMD="zip"
        ;;
    tar)
        ARCHIVE_EXTENSION="tar.gz" # Use tar.gz for compressed tarball
        ARCHIVE_CMD="tar"
        ;;
    *)
        log "❌ Error: Unsupported archive_type '${ARCHIVE_TYPE}'. Use 'zip' or 'tar'."
        exit 1
        ;;
esac

ARCHIVE_NAME="${REPO_NAME}-PR${PR_NUMBER}-${TIMESTAMP}.${ARCHIVE_EXTENSION}"
ARCHIVE_PATH="${SNAPSHOT_DIR}/${ARCHIVE_NAME}"

log "Creating ${ARCHIVE_TYPE} archive: ${ARCHIVE_PATH}"

# --- Construct Exclude Arguments ---
EXCLUDE_ARGS=()
if [ -n "${EXCLUDE_PATTERNS}" ]; then
    # Read space-separated patterns into an array
    read -ra PATTERNS <<< "${EXCLUDE_PATTERNS}"
    log "Parsing exclude patterns: ${PATTERNS[*]}"
    for pattern in "${PATTERNS[@]}"; do
        # Trim leading/trailing whitespace just in case
        pattern=$(echo "$pattern" | xargs)
        if [ -n "$pattern" ]; then # Ensure pattern is not empty after trimming
            case "${ARCHIVE_TYPE}" in
                zip)
                    EXCLUDE_ARGS+=("-x" "$pattern")
                    ;;
                tar)
                    EXCLUDE_ARGS+=("--exclude=$pattern") # Tar often uses --exclude=PATTERN
                    ;;
            esac
        fi
    done
    log "Constructed exclude arguments: ${EXCLUDE_ARGS[*]}"
else
    log "No exclude patterns specified."
fi

# --- Execute Archiving Command ---
case "${ARCHIVE_TYPE}" in
    zip)
        log "Running zip command: zip -r \"${ARCHIVE_PATH}\" . <exclude_args>"
        # The zip command takes arguments like: zip [options] archive.zip files... -x pattern1 -x pattern2
        zip -r "${ARCHIVE_PATH}" . "${EXCLUDE_ARGS[@]}"
        ;;
    tar)
        log "Running tar command: tar czf \"${ARCHIVE_PATH}\" <exclude_args> ."
        # The tar command often takes arguments like: tar [options] archive.tar.gz --exclude=pattern1 --exclude=pattern2 files...
        tar czf "${ARCHIVE_PATH}" "${EXCLUDE_ARGS[@]}" .
        ;;
esac

# Check if the archive was created successfully
if [ ! -s "${ARCHIVE_PATH}" ]; then 
    log "❌ Error: Archive file '${ARCHIVE_PATH}' was not created or is empty after running ${ARCHIVE_CMD}."
    log "Check archive command logs, exclude patterns, and runner resources."
    rm -rf "${SNAPSHOT_DIR}"
    exit 1
fi

log "✅ Created codebase snapshot: ${ARCHIVE_NAME}"

# --- 2. Find Seal Entity ---
log "Finding Seal entity..."
# Seal change control entities follow the format:
# <PR_TITLE> #<PR_NUMBER>
SEARCH_TERM="#${PR_NUMBER}"
log "Searching for Seal entity title containing: '${SEARCH_TERM}' with Template ID: '${SEAL_TEMPLATE_ID}'"
ENCODED_SEARCH_TERM=$(echo -n "${SEARCH_TERM}" | jq -sRr @uri)

SEARCH_URL="${SEAL_API_URL}entities/search?titleContains=${ENCODED_SEARCH_TERM}"
log "Search URL: ${SEARCH_URL}"

SEARCH_RESPONSE=$(curl -s -w "\nHTTP_STATUS_CODE:%{http_code}" \
    -H "Authorization: Bearer ${SEAL_API_TOKEN}" \
    -H "Accept: application/json" \
    "${SEARCH_URL}")

HTTP_STATUS=$(echo "$SEARCH_RESPONSE" | tail -n1 | sed 's/HTTP_STATUS_CODE://')
SEARCH_BODY=$(echo "$SEARCH_RESPONSE" | sed '$d') # Remove last line (status code)

if [ "$HTTP_STATUS" -ne 200 ]; then
    log "❌ Error searching for entity by title. Status: ${HTTP_STATUS}. Response: ${SEARCH_BODY}"
    rm -rf "${SNAPSHOT_DIR}" 
    exit 1
fi

log "Search Response Status: ${HTTP_STATUS}. Now filtering locally by Template ID: ${SEAL_TEMPLATE_ID}"

# Filter search results by template ID and extract the entity ID using jq
ENTITY_ID=$(echo "${SEARCH_BODY}" | jq -r --arg templateId "${SEAL_TEMPLATE_ID}" '.[] | select(.sourceInfo.template.id? == $templateId) | .id')
JQ_FILTER_EXIT_STATUS=$?

if [ $JQ_FILTER_EXIT_STATUS -ne 0 ]; then
    log "❌ Error filtering search results with jq (Exit code: $JQ_FILTER_EXIT_STATUS)."
    log "Raw Response Body: ${SEARCH_BODY}"
    rm -rf "${SNAPSHOT_DIR}"
    exit 1
fi

log "--- Debug: Extracted Entity ID(s) after filtering: ${ENTITY_ID}" # Log potential multiple IDs

# Check if a unique entity was found
if [ -z "${ENTITY_ID}" ]; then
  log "❌ Error: No Seal entity found containing title '${SEARCH_TERM}' and matching template ID '${SEAL_TEMPLATE_ID}' after local filtering."
  rm -rf "${SNAPSHOT_DIR}"
  exit 1
elif [ $(echo "${ENTITY_ID}" | wc -l) -ne 1 ]; then
  # Check if jq found more than one match (output would contain multiple lines)
  log "❌ Error: Found multiple entities containing title '${SEARCH_TERM}' and matching template ID '${SEAL_TEMPLATE_ID}' after local filtering. Cannot link snapshot."
  FOUND_IDS=$(echo "${ENTITY_ID}" | tr '\n' ' ')
  log "Found IDs: ${FOUND_IDS}" 
  rm -rf "${SNAPSHOT_DIR}"
  exit 1
fi

log "✅ Found unique Seal entity ID: ${ENTITY_ID}"

# --- 3. Upload Codebase Archive to Seal ---
log "Uploading codebase archive: ${ARCHIVE_NAME}"
ENCODED_FILENAME=$(echo -n "${ARCHIVE_NAME}" | jq -sRr @uri)
ENCODED_TYPE_TITLE=$(echo -n "${SEAL_FILE_TYPE_TITLE}" | jq -sRr @uri)

UPLOAD_URL="${SEAL_API_URL}files?filename=${ENCODED_FILENAME}&typeTitle=${ENCODED_TYPE_TITLE}"
log "Upload URL: ${UPLOAD_URL}"

UPLOAD_RESPONSE=$(curl -s -w "\nHTTP_STATUS_CODE:%{http_code}" --fail \
  -X POST \
  -H "Authorization: Bearer ${SEAL_API_TOKEN}" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@${ARCHIVE_PATH}" \
  "${UPLOAD_URL}")

CURL_EXIT_STATUS=$?
if [ $CURL_EXIT_STATUS -ne 0 ]; then
   log "❌ File upload failed (curl exit status: ${CURL_EXIT_STATUS}). Check network or Seal file type '${SEAL_FILE_TYPE_TITLE}' existence."
   HTTP_STATUS=$(echo "$UPLOAD_RESPONSE" | tail -n1 | sed 's/HTTP_STATUS_CODE://')
   UPLOAD_BODY=$(echo "$UPLOAD_RESPONSE" | sed '$d')
   log "Status: ${HTTP_STATUS:-N/A}, Response: ${UPLOAD_BODY:-N/A}"
   rm -rf "${SNAPSHOT_DIR}"
   exit 1
fi

HTTP_STATUS=$(echo "$UPLOAD_RESPONSE" | tail -n1 | sed 's/HTTP_STATUS_CODE://')
UPLOAD_BODY=$(echo "$UPLOAD_RESPONSE" | sed '$d')

# Check HTTP status explicitly (should be 201 Created or but api returns 200)
if [[ "$HTTP_STATUS" -ne 200 && "$HTTP_STATUS" -ne 201 ]]; then
    log "❌ File upload failed. Status: ${HTTP_STATUS}. Response: ${UPLOAD_BODY}"
    log "Ensure the file type '${SEAL_FILE_TYPE_TITLE}' exists in Seal."
    rm -rf "${SNAPSHOT_DIR}"
    exit 1
fi

FILE_ID=$(echo "$UPLOAD_BODY" | jq -er '.id')
JQ_EXIT_STATUS=$?
if [ $JQ_EXIT_STATUS -ne 0 ] || [ "$FILE_ID" == "null" ] || [ -z "$FILE_ID" ]; then
  log "❌ File upload succeeded (Status: ${HTTP_STATUS}), but failed to extract file ID from response."
  log "Response Body: $UPLOAD_BODY"
  rm -rf "${SNAPSHOT_DIR}"
  exit 1
fi

log "✅ Successfully uploaded codebase snapshot. File Entity ID: ${FILE_ID}"

# --- 4. Link File to Entity ---
log "Linking File ID ${FILE_ID} to Entity ID ${ENTITY_ID}..."

# Get file entity details to get the version 
GET_FILE_URL="${SEAL_API_URL}entities/${FILE_ID}"
log "Fetching file entity details: ${GET_FILE_URL}"
FILE_ENTITY_RESPONSE=$(curl -s -w "\nHTTP_STATUS_CODE:%{http_code}" --fail \
  -H "Authorization: Bearer ${SEAL_API_TOKEN}" \
  -H "Accept: application/json" \
  "${GET_FILE_URL}")

CURL_EXIT_STATUS=$?
HTTP_STATUS=$(echo "$FILE_ENTITY_RESPONSE" | tail -n1 | sed 's/HTTP_STATUS_CODE://')
FILE_ENTITY_BODY=$(echo "$FILE_ENTITY_RESPONSE" | sed '$d')

if [ $CURL_EXIT_STATUS -ne 0 ] || [[ "$HTTP_STATUS" -ne 200 ]]; then
   log "⚠️ Warning: Failed to fetch file entity details (ID: ${FILE_ID}). Status: ${HTTP_STATUS}. Linking with version=null."
   log "Response: ${FILE_ENTITY_BODY}"
   VERSION="null" # Fallback to latest version
else
    VERSION=$(echo "$FILE_ENTITY_BODY" | jq -r '.version // "null"') 
    log "Extracted File Version: ${VERSION}"
fi

# Ensure version is treated as a number or null, not a string "null"
if [ "$VERSION" == "null" ]; then
    REFERENCE_OBJECT="{\"id\":\"${FILE_ID}\",\"version\":null}"
else
    REFERENCE_OBJECT="{\"id\":\"${FILE_ID}\",\"version\":${VERSION}}"
fi
log "Constructed Reference Object: ${REFERENCE_OBJECT}"

ENCODED_FIELD_NAME=$(echo -n "${SEAL_SNAPSHOT_FIELD_NAME}" | jq -sRr @uri)
log "Field Name: '${SEAL_SNAPSHOT_FIELD_NAME}', Encoded: '${ENCODED_FIELD_NAME}'"

PATCH_URL="${SEAL_API_URL}entities/${ENTITY_ID}/fields/${ENCODED_FIELD_NAME}"
log "PATCH URL: ${PATCH_URL}"

PATCH_PAYLOAD="{\"value\": [${REFERENCE_OBJECT}]}"
log "PATCH Payload: ${PATCH_PAYLOAD}"

UPDATE_RESPONSE=$(curl -s -w "\nHTTP_STATUS_CODE:%{http_code}" --fail \
  -X PATCH \
  -H "Authorization: Bearer ${SEAL_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "${PATCH_PAYLOAD}" \
  "${PATCH_URL}")

CURL_EXIT_STATUS=$?
HTTP_STATUS=$(echo "$UPDATE_RESPONSE" | tail -n1 | sed 's/HTTP_STATUS_CODE://')
UPDATE_BODY=$(echo "$UPDATE_RESPONSE" | sed '$d')

if [ $CURL_EXIT_STATUS -ne 0 ] || [[ "$HTTP_STATUS" -ne 200 ]]; then
   log "❌ Linking attempt failed. Status: ${HTTP_STATUS}. Response: ${UPDATE_BODY}"
   log "File was uploaded (ID: ${FILE_ID}) but linking failed. Manual linking may be required in Seal."
   log "⚠️ Proceeding despite linking failure."
else
  if echo "${UPDATE_BODY}" | jq -e . >/dev/null 2>&1 && ! echo "${UPDATE_BODY}" | jq -e '.message' >/dev/null 2>&1; then
      log "✅ Successfully linked codebase snapshot to Seal change control document."
  else
      log "⚠️ Linking attempt seemed successful (Status ${HTTP_STATUS}) but response might indicate an issue."
      log "Update Response Body: ${UPDATE_BODY}"
      log "File ID for checking: ${FILE_ID}"
  fi
fi

# --- Cleanup ---
log "Cleaning up temporary files..."
rm -rf "${SNAPSHOT_DIR}"

log "✅ Codebase Snapshot Action Completed Successfully."
