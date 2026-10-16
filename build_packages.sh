#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUPPET_FILES="/mnt/volume1/MyCode/workspace/puppet-server/code/environments/production/modules/profiles/files"
PUPPET_REPO="/mnt/volume1/MyCode/workspace/puppet-server"

export PATH="/home/roland/.cargo/bin:$PATH"
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER="aarch64-linux-gnu-gcc"

echo "=============================================="
echo " Starting ArtfulType Pro 0.30.12 Build Pipeline"
echo "=============================================="

cd "$SCRIPT_DIR"

echo "→ Step 1/4: Building Host GUI .deb (x86-64)..."
make deb

echo "→ Step 2/4: Building Host CLI (art) .deb (x86-64)..."
make deb-cli

echo "→ Step 3/4: Building ARM64 GUI .deb (aarch64)..."
make deb-arm64

echo "→ Step 4/4: Building ARM64 CLI (art) .deb (aarch64)..."
make deb-cli-arm64

echo "=============================================="
echo " Deploying .deb packages to Puppet files..."
echo "=============================================="

mkdir -p "$PUPPET_FILES"

# Copy freshest packages
LATEST_GUI_AMD64=$(ls -t src-tauri/target/release/bundle/deb/artfultype-rs_0.30.12*.deb | grep -v arm64 | head -1)
LATEST_GUI_ARM64=$(ls -t src-tauri/target/release/bundle/deb/artfultype-rs_0.30.12*_arm64.deb | head -1)
LATEST_CLI_AMD64=$(ls -t releases/artfultype-cli_0.30.12-*_amd64.deb | head -1)
LATEST_CLI_ARM64=$(ls -t releases/artfultype-cli_0.30.12-*_arm64.deb | head -1)

echo "Copying $LATEST_GUI_AMD64 -> $PUPPET_FILES/artfultype-rs.deb"
cp -f "$LATEST_GUI_AMD64" "$PUPPET_FILES/artfultype-rs.deb"

echo "Copying $LATEST_GUI_ARM64 -> $PUPPET_FILES/artfultype-rs_arm64.deb"
cp -f "$LATEST_GUI_ARM64" "$PUPPET_FILES/artfultype-rs_arm64.deb"

echo "Copying $LATEST_CLI_AMD64 -> $PUPPET_FILES/artfultype-cli.deb"
cp -f "$LATEST_CLI_AMD64" "$PUPPET_FILES/artfultype-cli.deb"

echo "Copying $LATEST_CLI_ARM64 -> $PUPPET_FILES/artfultype-cli_arm64.deb"
cp -f "$LATEST_CLI_ARM64" "$PUPPET_FILES/artfultype-cli_arm64.deb"

echo "=============================================="
echo " Committing and Deploying via Puppet..."
echo "=============================================="

cd "$PUPPET_REPO"
git add \
  code/environments/production/modules/profiles/files/artfultype-rs.deb \
  code/environments/production/modules/profiles/files/artfultype-rs_arm64.deb \
  code/environments/production/modules/profiles/files/artfultype-cli.deb \
  code/environments/production/modules/profiles/files/artfultype-cli_arm64.deb \
  code/environments/production/modules/profiles/manifests/artfultype.pp \
  code/environments/production/modules/profiles/manifests/artfultype_cli.pp

git commit -m "feat: update artfultype-rs and artfultype-cli to v0.30.12"
git push origin main

echo "✓ Deployment complete! Running local puppet agent test..."
if command -v puppet >/dev/null 2>&1; then
  sudo puppet agent -t || true
fi

echo "All steps finished successfully!"
