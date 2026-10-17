#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUPPET_FILES="/mnt/volume1/MyCode/workspace/puppet-server/code/environments/production/modules/profiles/files"
PUPPET_REPO="/mnt/volume1/MyCode/workspace/puppet-server"

export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER="aarch64-linux-gnu-gcc"

cd "$SCRIPT_DIR"

VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' "$SCRIPT_DIR/src-tauri/Cargo.toml" | head -1)

echo "=============================================="
echo " Starting ArtfulType Pro $VERSION Build Pipeline"
echo "=============================================="

echo "→ Step 1/6: Building Host GUI .deb and .rpm (x86-64)..."
cargo-tauri build --bundles deb,rpm

echo "→ Step 2/6: Building Host CLI (art) .deb (x86-64)..."
make deb-cli

echo "→ Step 3/6: Building ARM64 GUI .deb (aarch64)..."
make deb-arm64

echo "→ Step 4/6: Building ARM64 CLI (art) .deb (aarch64)..."
make deb-cli-arm64

echo "→ Step 5/6: Building CLI .rpm (x86-64)..."
if command -v alien >/dev/null 2>&1; then
  LATEST_CLI_DEB=$(ls -t releases/artfultype-cli_${VERSION}-*_amd64.deb | head -1)
  alien -r --scripts "$LATEST_CLI_DEB" || true
  mv -f artfultype-cli-*.rpm releases/ 2>/dev/null || true
fi

# Copy GUI rpm into releases/
mkdir -p releases
cp -f src-tauri/target/release/bundle/rpm/artfultype-rs-${VERSION}*.rpm releases/ 2>/dev/null || true

echo "→ Step 6/6: Building Windows binaries (x86-64)..."
cargo build --manifest-path src-tauri/Cargo.toml --release --target x86_64-pc-windows-gnu --no-default-features
cargo build --manifest-path src-tauri/Cargo.toml --release --target x86_64-pc-windows-gnu --bin art --features tui

cp -f src-tauri/target/x86_64-pc-windows-gnu/release/artfultype-rs.exe releases/artfultype-rs-windows-x64.exe
cp -f src-tauri/target/x86_64-pc-windows-gnu/release/artfultype-rs.exe releases/artfultype-rs_${VERSION}_x64-setup.exe
cp -f src-tauri/target/x86_64-pc-windows-gnu/release/art.exe releases/artfultype-cli-windows-x64.exe

echo "=============================================="
echo " Deploying packages to Puppet files..."
echo "=============================================="

mkdir -p "$PUPPET_FILES"

LATEST_GUI_AMD64=$(ls -t src-tauri/target/release/bundle/deb/artfultype-rs_${VERSION}*.deb | grep -v arm64 | head -1)
LATEST_GUI_ARM64=$(ls -t src-tauri/target/release/bundle/deb/artfultype-rs_${VERSION}*_arm64.deb | head -1)
LATEST_CLI_AMD64=$(ls -t releases/artfultype-cli_${VERSION}-*_amd64.deb | head -1)
LATEST_CLI_ARM64=$(ls -t releases/artfultype-cli_${VERSION}-*_arm64.deb | head -1)

echo "Copying $LATEST_GUI_AMD64 -> $PUPPET_FILES/artfultype-rs.deb"
cp -f "$LATEST_GUI_AMD64" "$PUPPET_FILES/artfultype-rs.deb"

echo "Copying $LATEST_GUI_ARM64 -> $PUPPET_FILES/artfultype-rs_arm64.deb"
cp -f "$LATEST_GUI_ARM64" "$PUPPET_FILES/artfultype-rs_arm64.deb"

echo "Copying $LATEST_CLI_AMD64 -> $PUPPET_FILES/artfultype-cli.deb"
cp -f "$LATEST_CLI_AMD64" "$PUPPET_FILES/artfultype-cli.deb"

echo "Copying $LATEST_CLI_ARM64 -> $PUPPET_FILES/artfultype-cli_arm64.deb"
cp -f "$LATEST_CLI_ARM64" "$PUPPET_FILES/artfultype-cli_arm64.deb"

if [ -f src-tauri/target/x86_64-pc-windows-gnu/release/artfultype-rs.exe ]; then
  echo "Copying Windows GUI -> $PUPPET_FILES/artfultype-rs.exe and artfultype-setup.exe"
  cp -f src-tauri/target/x86_64-pc-windows-gnu/release/artfultype-rs.exe "$PUPPET_FILES/artfultype-rs.exe"
  cp -f src-tauri/target/x86_64-pc-windows-gnu/release/artfultype-rs.exe "$PUPPET_FILES/artfultype-setup.exe"
fi

if [ -f src-tauri/target/x86_64-pc-windows-gnu/release/art.exe ]; then
  echo "Copying Windows CLI -> $PUPPET_FILES/artfultype-cli.exe"
  cp -f src-tauri/target/x86_64-pc-windows-gnu/release/art.exe "$PUPPET_FILES/artfultype-cli.exe"
fi

echo "=============================================="
echo " Publishing Release to GitHub..."
echo "=============================================="
cd "$SCRIPT_DIR"
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  echo "Uploading packages to GitHub release v${VERSION}..."
  if gh release view "v${VERSION}" >/dev/null 2>&1; then
    gh release upload "v${VERSION}" \
      "$LATEST_GUI_AMD64" \
      "$LATEST_GUI_ARM64" \
      "$LATEST_CLI_AMD64" \
      "$LATEST_CLI_ARM64" \
      releases/artfultype-rs-windows-x64.exe \
      releases/artfultype-rs_${VERSION}_x64-setup.exe \
      releases/artfultype-cli-windows-x64.exe \
      releases/artfultype-rs-${VERSION}*.rpm \
      --clobber || true
  else
    gh release create "v${VERSION}" \
      "$LATEST_GUI_AMD64" \
      "$LATEST_GUI_ARM64" \
      "$LATEST_CLI_AMD64" \
      "$LATEST_CLI_ARM64" \
      releases/artfultype-rs-windows-x64.exe \
      releases/artfultype-rs_${VERSION}_x64-setup.exe \
      releases/artfultype-cli-windows-x64.exe \
      releases/artfultype-rs-${VERSION}*.rpm \
      --title "ArtfulType Pro v${VERSION}" \
      --generate-notes || true
  fi
  echo "✓ GitHub Release v${VERSION} handled."
else
  echo "Notice: gh CLI not authenticated or not found, skipping GitHub Release."
fi

echo "=============================================="
echo " Committing and Deploying via Puppet..."
echo "=============================================="

cd "$PUPPET_REPO"
git add \
  code/environments/production/modules/profiles/files/artfultype-rs.deb \
  code/environments/production/modules/profiles/files/artfultype-rs_arm64.deb \
  code/environments/production/modules/profiles/files/artfultype-cli.deb \
  code/environments/production/modules/profiles/files/artfultype-cli_arm64.deb \
  code/environments/production/modules/profiles/files/artfultype-rs.exe \
  code/environments/production/modules/profiles/files/artfultype-setup.exe \
  code/environments/production/modules/profiles/files/artfultype-cli.exe \
  code/environments/production/modules/profiles/manifests/artfultype.pp \
  code/environments/production/modules/profiles/manifests/artfultype_cli.pp

git commit -m "feat: update artfultype-rs and artfultype-cli to v${VERSION}" || true
git push origin main || true

echo "✓ Deployment complete! Running local puppet agent test..."
if command -v puppet >/dev/null 2>&1; then
  sudo -n puppet agent -t || true
fi

echo "All steps finished successfully!"
