#!/bin/bash
# Build the DelegateAgent agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="delegate-agent"
LEGACY_IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

echo "Building DelegateAgent agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG} (legacy tag: ${LEGACY_IMAGE_NAME}:${TAG})"

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" -t "${LEGACY_IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo "Legacy tag (kept for one release): ${LEGACY_IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
