#!/bin/bash
# .github/actions/upload-artifacts/entrypoint.sh

set -e

log() {
    echo "[UploadArtifactsAction] $1"
}

log "Starting..."

# --- Debug: Dump all environment variables ---
log "--- Dumping Environment Variables (Sorted) ---"
env | sort
log "--- End Environment Dump ---"
# --- End Debug ---

# --- Validate Inputs ---
if [ -z "$INPUT_SEAL_API_TOKEN" ]; then log "❌ Error: seal_api_token input is required."; exit 1; fi
if [ -z "$INPUT_SEAL_API_BASE_URL" ]; then log "❌ Error: seal_api_base_url input is required."; exit 1; fi
if [ -z "$INPUT_SEAL_TEMPLATE_ID" ]; then log "❌ Error: seal_template_id input is required."; exit 1; fi
if [ -z "$INPUT_ARTIFACT_PATTERNS" ]; then log "❌ Error: artifact_patterns input is required."; exit 1; fi

# --- Assign Inputs to Variables ---
SEAL_API_TOKEN="${INPUT_SEAL_API_TOKEN}"
SEAL_API_URL="${INPUT_SEAL_API_BASE_URL}"
SEAL_TEMPLATE_ID="${INPUT_SEAL_TEMPLATE_ID}"
SEAL_FIELD_NAME="${INPUT_SEAL_FIELD_NAME}"
SEAL_FILE_TYPE_TITLE="${INPUT_SEAL_FILE_TYPE_TITLE}"
ARTIFACT_PATTERNS="${INPUT_ARTIFACT_PATTERNS}"

log "Seal Field Name: ${SEAL_FIELD_NAME}"
log "Seal File Type Title: ${SEAL_FILE_TYPE_TITLE}"
log "Artifact Patterns: ${ARTIFACT_PATTERNS}"

cd "${GITHUB_WORKSPACE}" || exit 1

# --- Check PR Context --- 
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

TIMESTAMP=$(date +%Y%m%d%H%M%S)
log "Run Timestamp for Filenames: ${TIMESTAMP}"

# --- 1. Find Artifact Files --- 
log "Finding artifact files..."
FOUND_FILES=()
if [ -n "${ARTIFACT_PATTERNS}" ]; then
    # Read space-separated patterns into an array
    read -ra PATTERNS <<< "${ARTIFACT_PATTERNS}"
    log "Searching for patterns: ${PATTERNS[*]}"
    for pattern in "${PATTERNS[@]}"; do
        # Trim leading/trailing whitespace just in case
        current_pattern=$(echo "$pattern" | xargs)
        if [ -n "$current_pattern" ]; then
            log "Searching for files matching pattern: $current_pattern"
            # Use find within GITHUB_WORKSPACE. Use -print0 and read -d '' for safety.
            while IFS= read -r -d $'\0' file; do
                if [ -f "$file" ]; then # Ensure it's a file
                   log "Found artifact file: $file"
                   FOUND_FILES+=("$file")
                else
                   log "Skipping non-file match: $file"
                fi
            # Use find starting from CWD which is GITHUB_WORKSPACE.
            # Use -path for matching the whole path including directories.
            # Redirect stderr to /dev/null to suppress 'permission denied' errors but continue; use || true to prevent exit on find error
            done < <(find . -path "$current_pattern" -print0 2>/dev/null || true)
        fi
    done
else
    log "Warning: No artifact patterns provided."
fi

# Check if any files were found
if [ ${#FOUND_FILES[@]} -eq 0 ]; then
    log "ℹ️ No artifact files found matching the specified patterns. Nothing to upload."
    exit 0 # Successful exit as there's nothing to do
fi

log "Found ${#FOUND_FILES[@]} artifact files to upload."

# --- 2. Find Seal Entity --- 
log "Finding Seal entity..."
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
SEARCH_BODY=$(echo "$SEARCH_RESPONSE" | sed '$d')

if [ "$HTTP_STATUS" -ne 200 ]; then
    log "❌ Error searching for entity by title. Status: ${HTTP_STATUS}. Response: ${SEARCH_BODY}"
    exit 1
fi

log "Search Response Status: ${HTTP_STATUS}. Now filtering locally by Template ID: ${SEAL_TEMPLATE_ID}"
ENTITY_ID=$(echo "${SEARCH_BODY}" | jq -r --arg templateId "${SEAL_TEMPLATE_ID}" '.[] | select(.sourceInfo.template.id? == $templateId) | .id')
JQ_FILTER_EXIT_STATUS=$?

if [ $JQ_FILTER_EXIT_STATUS -ne 0 ]; then
    log "❌ Error filtering search results with jq (Exit code: $JQ_FILTER_EXIT_STATUS)."
    log "Raw Response Body: ${SEARCH_BODY}"
    exit 1
fi

log "--- Debug: Extracted Entity ID(s) after filtering: ${ENTITY_ID}"

if [ -z "${ENTITY_ID}" ]; then
  log "❌ Error: No Seal entity found containing title '${SEARCH_TERM}' and matching template ID '${SEAL_TEMPLATE_ID}' after local filtering."
  exit 1
elif [ $(echo "${ENTITY_ID}" | wc -l) -ne 1 ]; then
  log "❌ Error: Found multiple entities containing title '${SEARCH_TERM}' and matching template ID '${SEAL_TEMPLATE_ID}' after local filtering. Cannot link artifacts."
  FOUND_IDS=$(echo "${ENTITY_ID}" | tr '\n' ' ')
  log "Found IDs: ${FOUND_IDS}" 
  exit 1
fi

log "✅ Found unique Seal entity ID: ${ENTITY_ID}"

# --- 3. Upload Artifacts and Collect IDs/Versions --- 
log "Uploading artifacts to Seal..."
UPLOADED_FILE_IDS=()
UPLOADED_FILE_VERSIONS=()
UPLOAD_FAILED_COUNT=0
UPLOAD_COUNTER=0 # Initialize counter

ENCODED_TYPE_TITLE=$(echo -n "${SEAL_FILE_TYPE_TITLE}" | jq -sRr @uri)

for file_path in "${FOUND_FILES[@]}"; do
    log "Attempting to upload: ${file_path}"
    UPLOAD_COUNTER=$((UPLOAD_COUNTER + 1)) # Increment counter for each file
    
    # Extract original filename for constructing the new unique name
    original_filename=$(basename "${file_path}")
    
    # Construct the unique filename for Seal using PR number and index
    seal_filename="artifact-${original_filename}-pr${PR_NUMBER}-index${UPLOAD_COUNTER}" 
    log "Uploading as Seal filename: ${seal_filename}"
    
    ENCODED_FILENAME=$(echo -n "${seal_filename}" | jq -sRr @uri)
    
    UPLOAD_URL="${SEAL_API_URL}files?filename=${ENCODED_FILENAME}&typeTitle=${ENCODED_TYPE_TITLE}"
    log "Upload URL: ${UPLOAD_URL}"

    UPLOAD_RESPONSE=$(curl -s -w "\nHTTP_STATUS_CODE:%{http_code}" --fail \
      -X POST \
      -H "Authorization: Bearer ${SEAL_API_TOKEN}" \
      -H "Content-Type: application/octet-stream" \
      --data-binary "@${file_path}" \
      "${UPLOAD_URL}")
    
    CURL_EXIT_STATUS=$?
    HTTP_STATUS=$(echo "$UPLOAD_RESPONSE" | tail -n1 | sed 's/HTTP_STATUS_CODE://')
    UPLOAD_BODY=$(echo "$UPLOAD_RESPONSE" | sed '$d')

    if [ $CURL_EXIT_STATUS -ne 0 ] || [[ "$HTTP_STATUS" -ne 200 && "$HTTP_STATUS" -ne 201 ]]; then
       log "⚠️ Upload failed for '${file_path}' (curl status: ${CURL_EXIT_STATUS}, HTTP status: ${HTTP_STATUS:-N/A}). Skipping this file."
       log "Response: ${UPLOAD_BODY:-N/A}"
       UPLOAD_FAILED_COUNT=$((UPLOAD_FAILED_COUNT + 1))
       continue # Skip to the next file
    fi

    # --- Extract File ID --- 
    FILE_ID=$(echo "$UPLOAD_BODY" | jq -er '.id')
    JQ_EXIT_STATUS=$?
    if [ $JQ_EXIT_STATUS -ne 0 ] || [ "$FILE_ID" == "null" ] || [ -z "$FILE_ID" ]; then
      log "⚠️ Upload succeeded for '${file_path}' (HTTP Status: ${HTTP_STATUS}), but failed to extract file ID. Skipping linking for this file."
      log "Response Body: $UPLOAD_BODY"
      UPLOAD_FAILED_COUNT=$((UPLOAD_FAILED_COUNT + 1))
      continue # Skip to the next file
    fi
    log "✅ Successfully uploaded '${file_path}'. File Entity ID: ${FILE_ID}"
    UPLOADED_FILE_IDS+=("${FILE_ID}")

    # --- Get File Version --- 
    GET_FILE_URL="${SEAL_API_URL}entities/${FILE_ID}"
    FILE_ENTITY_RESPONSE=$(curl -s -w "\nHTTP_STATUS_CODE:%{http_code}" --fail \
      -H "Authorization: Bearer ${SEAL_API_TOKEN}" \
      -H "Accept: application/json" \
      "${GET_FILE_URL}")
    
    CURL_GET_EXIT_STATUS=$?
    HTTP_GET_STATUS=$(echo "$FILE_ENTITY_RESPONSE" | tail -n1 | sed 's/HTTP_STATUS_CODE://')
    FILE_ENTITY_BODY=$(echo "$FILE_ENTITY_RESPONSE" | sed '$d')

    VERSION="null" # Default version
    if [ $CURL_GET_EXIT_STATUS -eq 0 ] && [[ "$HTTP_GET_STATUS" -eq 200 ]]; then
        VERSION_EXTRACTED=$(echo "$FILE_ENTITY_BODY" | jq -r '.version // "null"') 
        if [[ -n "$VERSION_EXTRACTED" && "$VERSION_EXTRACTED" != "null" ]]; then
            VERSION=$VERSION_EXTRACTED
        fi
    else
       log "⚠️ Warning: Failed to fetch file entity details for ID ${FILE_ID}. Using version=null for linking."
    fi
    log "Using Version: ${VERSION} for File ID: ${FILE_ID}"
    UPLOADED_FILE_VERSIONS+=("${VERSION}")

done

log "Finished uploading. Successful: ${#UPLOADED_FILE_IDS[@]}, Failed: ${UPLOAD_FAILED_COUNT}."

# --- 4. Link Uploaded Files to Entity --- 
if [ ${#UPLOADED_FILE_IDS[@]} -eq 0 ]; then
    log "No files were successfully uploaded. Skipping linking step."
    # Decide if this should be an error or success based on failed count?
    if [ $UPLOAD_FAILED_COUNT -gt 0 ]; then
        log "❌ Errors occurred during upload."
        exit 1 # Exit with error if uploads failed
    else
        log "✅ No errors, but no files uploaded (perhaps none found)."
        exit 0 # Exit successfully
    fi
fi

log "Linking ${#UPLOADED_FILE_IDS[@]} uploaded files to Entity ID ${ENTITY_ID} in field '${SEAL_FIELD_NAME}'..."

# --- Construct PATCH Payload --- 
PATCH_OBJECTS_STR=""
for i in "${!UPLOADED_FILE_IDS[@]}"; do
    current_id="${UPLOADED_FILE_IDS[i]}"
    current_version="${UPLOADED_FILE_VERSIONS[i]}"
    
    # Construct the individual {"id": "...", "version": ...} object string
    if [ "$current_version" == "null" ] || [ -z "$current_version" ]; then
        obj="{\"id\":\"${current_id}\",\"version\":null}"
    else
        obj="{\"id\":\"${current_id}\",\"version\":${current_version}}" # Version as number
    fi
    
    # Append to list, adding comma if not the first item
    if [ -z "$PATCH_OBJECTS_STR" ]; then
        PATCH_OBJECTS_STR="$obj"
    else
        PATCH_OBJECTS_STR="$PATCH_OBJECTS_STR,$obj"
    fi
done

PATCH_PAYLOAD="{\"value\": [${PATCH_OBJECTS_STR}]}"
log "Constructed PATCH Payload: ${PATCH_PAYLOAD}"

# --- Execute PATCH Request --- 
ENCODED_FIELD_NAME=$(echo -n "${SEAL_FIELD_NAME}" | jq -sRr @uri)
log "Field Name: '${SEAL_FIELD_NAME}', Encoded: '${ENCODED_FIELD_NAME}'"

PATCH_URL="${SEAL_API_URL}entities/${ENTITY_ID}/fields/${ENCODED_FIELD_NAME}"
log "PATCH URL: ${PATCH_URL}"

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
   log "Files were uploaded but linking failed. Manual linking may be required in Seal."
   exit 1 # Fail the action if linking fails
else
  # Basic check for JSON success response without an error message
  if echo "${UPDATE_BODY}" | jq -e . >/dev/null 2>&1 && ! echo "${UPDATE_BODY}" | jq -e '.message' >/dev/null 2>&1; then
      log "✅ Successfully linked uploaded artifacts to Seal entity field '${SEAL_FIELD_NAME}'."
  else
      log "⚠️ Linking attempt seemed successful (Status ${HTTP_STATUS}) but response might indicate an issue."
      log "Update Response Body: ${UPDATE_BODY}"
  fi
fi

log "✅ Upload Artifacts Action Completed Successfully."
