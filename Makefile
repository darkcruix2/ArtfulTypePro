# ─── ArtfulType-rs Makefile ───────────────────────────────────────────────────
#
# Targets:
#   make             – build release binary (same as 'make build')
#   make build       – compile release binary via cargo tauri build
#   make deb         – build .deb package for host arch (x86-64)
#   make deb-arm64   – cross-compile GUI .deb for aarch64 (CM4 / uConsole / RPi)
#   make deb-cli     – build CLI (art) .deb for host arch (x86-64)
#   make deb-cli-arm64 – cross-compile CLI (art) .deb for aarch64
#   make install     – install binary + assets to system paths (requires sudo)
#   make uninstall   – remove installed files (requires sudo)
#   make clean       – remove build artefacts
#   make deps        – install Debian build dependencies (host / x86-64)
#   make deps-arm64  – install ARM64 cross-compilation toolchain
#   make check       – run cargo check only (fast compile check, no bundle)

# ─── Metadata ────────────────────────────────────────────────────────────────
APP_NAME    := artfultype-rs
APP_VERSION := $(shell sed -n 's/^version = "\(.*\)"/\1/p' src-tauri/Cargo.toml | head -1)
APP_DESC    := "ArtfulType Pro — Dracula-themed Markdown / Writer editor"

# ─── Paths ───────────────────────────────────────────────────────────────────
# Where cargo tauri build puts things
TAURI_SRC   := src-tauri
RELEASE_DIR := $(TAURI_SRC)/target/release
BUNDLE_DIR  := $(RELEASE_DIR)/bundle

BINARY      := $(RELEASE_DIR)/$(APP_NAME)
DEB_DIR     := $(BUNDLE_DIR)/deb
DEB_GLOB    := $(DEB_DIR)/$(APP_NAME)_$(APP_VERSION)*.deb

# ─── Install destinations (FHS / Debian standard) ────────────────────────────
DESTDIR     ?=
PREFIX      ?= /usr/local
BINDIR      := $(DESTDIR)$(PREFIX)/bin
SHAREDIR    := $(DESTDIR)$(PREFIX)/share
APPDIR      := $(SHAREDIR)/$(APP_NAME)
ICONDIR     := $(SHAREDIR)/icons/hicolor
DESKTOPDIR  := $(SHAREDIR)/applications
MANDIR      := $(SHAREDIR)/man/man1

# ─── Tools ───────────────────────────────────────────────────────────────────
CARGO_TAURI := /home/roland/.cargo/bin/cargo-tauri
INSTALL     := install
CP          := cp -r

# ─────────────────────────────────────────────────────────────────────────────
.DEFAULT_GOAL := build
.PHONY: all build deb deb-arm64 deb-cli deb-cli-arm64 rpm windows install uninstall clean deps deps-arm64 check \
        android-setup android-dev android-build android-check

# ─── Build release binary ─────────────────────────────────────────────────────
all: build

build:
	@echo "→ Building $(APP_NAME) $(APP_VERSION) (release)…"
	$(CARGO_TAURI) build --no-bundle
	@echo "✓ Binary: $(BINARY)"

# ─── Build .deb package (host arch — x86-64) ─────────────────────────────────
deb:
	@echo "→ Building $(APP_NAME) .deb package ($(shell dpkg --print-architecture))…"
	$(CARGO_TAURI) build --bundles deb
	@echo "✓ Package(s):"
	@ls -1 $(DEB_DIR)/*.deb 2>/dev/null || echo "  (no .deb found — check build output above)"

# ─── Build .rpm package (host arch — x86-64) ─────────────────────────────────
rpm:
	@echo "→ Building $(APP_NAME) .rpm package…"
	$(CARGO_TAURI) build --bundles rpm
	@mkdir -p releases
	@cp -f $(RELEASE_DIR)/bundle/rpm/$(APP_NAME)-$(APP_VERSION)*.rpm releases/ 2>/dev/null || true
	@echo "✓ RPM Package(s):"
	@ls -1 releases/$(APP_NAME)-$(APP_VERSION)*.rpm 2>/dev/null || echo "  (no .rpm found)"

# ─── Build Windows binaries (cross-compiled via mingw) ────────────────────────
windows:
	@echo "→ Cross-compiling Windows x64 binaries…"
	cargo build --manifest-path $(TAURI_SRC)/Cargo.toml --release --target x86_64-pc-windows-gnu --no-default-features
	cargo build --manifest-path $(TAURI_SRC)/Cargo.toml --release --target x86_64-pc-windows-gnu --bin art --features tui
	@mkdir -p releases
	cp -f $(TAURI_SRC)/target/x86_64-pc-windows-gnu/release/$(APP_NAME).exe releases/$(APP_NAME)-windows-x64.exe
	cp -f $(TAURI_SRC)/target/x86_64-pc-windows-gnu/release/$(APP_NAME).exe releases/$(APP_NAME)_$(APP_VERSION)_x64-setup.exe
	cp -f $(TAURI_SRC)/target/x86_64-pc-windows-gnu/release/art.exe releases/artfultype-cli-windows-x64.exe
	@echo "✓ Windows binaries in releases/"

# ─── Build .deb package for ARM64 (aarch64 — CM4 / uConsole / RPi) ───────────
#
# Strategy:
#   1. Cross-compile the Rust binary for aarch64-unknown-linux-gnu using the
#      GCC cross-linker (no Docker required — uses system gcc-aarch64-linux-gnu).
#   2. Build the normal x86-64 Tauri bundle to let Tauri generate the .deb
#      directory scaffold with all metadata, desktop files and icons.
#   3. Repackage: swap the x86-64 binary for the aarch64 one, patch the
#      'Architecture' field in DEBIAN/control, and call dpkg-deb.
#
# The result lands in $(DEB_DIR)/ with an _arm64 suffix.
#
ARM64_TARGET    := aarch64-unknown-linux-gnu
ARM64_CROSS_CC  := aarch64-linux-gnu-gcc
ARM64_BINARY    := $(TAURI_SRC)/target/$(ARM64_TARGET)/release/$(APP_NAME)
ARM64_WORK_DIR  := /tmp/$(APP_NAME)-arm64-pkg
ARM64_DEB_STEM  := $(APP_NAME)_$(APP_VERSION)_arm64
ARM64_DEB_OUT   := $(DEB_DIR)/$(ARM64_DEB_STEM).deb

deb-arm64: _arm64-check-tools
	@echo "→ Cross-compiling $(APP_NAME) for $(ARM64_TARGET)…"
	# Ensure the Rust target is installed
	rustup target add $(ARM64_TARGET)
	# Cross-compile (linker is set via .cargo/config.toml or inline env)
	PKG_CONFIG_SYSROOT_DIR=/ \
	PKG_CONFIG_PATH=/usr/lib/aarch64-linux-gnu/pkgconfig:/usr/share/pkgconfig \
	PKG_CONFIG_ALLOW_CROSS=1 \
	CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=$(ARM64_CROSS_CC) \
	  cargo build \
	    --manifest-path $(TAURI_SRC)/Cargo.toml \
	    --release \
	    --target $(ARM64_TARGET) \
	    --no-default-features
	@echo "→ Building x86-64 Tauri .deb scaffold for metadata…"
	$(CARGO_TAURI) build --bundles deb 2>/dev/null || true
	@# Locate the freshest x86-64 .deb to use as the scaffold
	@X86_DEB=$$(ls -t $(DEB_DIR)/$(APP_NAME)_$(APP_VERSION)*.deb 2>/dev/null | grep -v arm64 | head -1); \
	test -n "$$X86_DEB" || (echo "ERROR: no x86-64 .deb scaffold found in $(DEB_DIR)/"; exit 1); \
	echo "→ Repackaging as arm64 .deb using scaffold: $$X86_DEB"; \
	rm -rf $(ARM64_WORK_DIR); \
	dpkg-deb -R "$$X86_DEB" $(ARM64_WORK_DIR)
	# Replace binary with ARM64 build
	cp -f $(ARM64_BINARY) $(ARM64_WORK_DIR)/usr/bin/$(APP_NAME)
	file $(ARM64_WORK_DIR)/usr/bin/$(APP_NAME)
	# Patch control metadata
	sed -i 's/^Architecture:.*/Architecture: arm64/' $(ARM64_WORK_DIR)/DEBIAN/control
	sed -i 's/^Installed-Size:.*//' $(ARM64_WORK_DIR)/DEBIAN/control
	# Recalculate installed size (kB) — evaluated at run time, after unpacking
	sed -i '/^$$/d' $(ARM64_WORK_DIR)/DEBIAN/control
	echo "Installed-Size: $$(du -sk $(ARM64_WORK_DIR) | cut -f1)" >> $(ARM64_WORK_DIR)/DEBIAN/control
	# Repack
	mkdir -p $(DEB_DIR)
	dpkg-deb --build --root-owner-group $(ARM64_WORK_DIR) $(ARM64_DEB_OUT)
	rm -rf $(ARM64_WORK_DIR)
	@echo "✓ ARM64 package: $(ARM64_DEB_OUT)"
	@ls -lh $(ARM64_DEB_OUT)

# Internal target — verify required cross-build tools are present
_arm64-check-tools:
	@command -v $(ARM64_CROSS_CC) >/dev/null 2>&1 || \
	  (echo "ERROR: $(ARM64_CROSS_CC) not found. Run: make deps-arm64"; exit 1)
	@command -v dpkg-deb >/dev/null 2>&1 || \
	  (echo "ERROR: dpkg-deb not found. Install dpkg package."; exit 1)
	@rustup target list --installed | grep -q $(ARM64_TARGET) || rustup target add $(ARM64_TARGET)

# ─── Build CLI (art) .deb — host arch (x86-64) ───────────────────────────────
CLI_NAME        := artfultype-cli
CLI_BINARY_HOST := $(TAURI_SRC)/target/release/art
CLI_DEB_WORK    := /tmp/$(CLI_NAME)-pkg
CLI_DEB_HOST    := releases/$(CLI_NAME)_$(APP_VERSION)-1_$(shell dpkg --print-architecture).deb
CLI_AMD64_REF   := $(shell ls -t releases/$(CLI_NAME)_*_amd64.deb 2>/dev/null | head -1)

deb-cli:
	@echo "→ Building $(CLI_NAME) (host arch)…"
	CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=$(ARM64_CROSS_CC) \
	  cargo build \
	    --manifest-path $(TAURI_SRC)/Cargo.toml \
	    --release --bin art --features tui
	@test -f "$(CLI_BINARY_HOST)" || (echo "ERROR: art binary not found"; exit 1)
	rm -rf $(CLI_DEB_WORK)
	dpkg-deb -R "$(CLI_AMD64_REF)" $(CLI_DEB_WORK)
	cp -f $(CLI_BINARY_HOST) $(CLI_DEB_WORK)/usr/bin/art
	chmod 755 $(CLI_DEB_WORK)/usr/bin/art
	sed -i "s/^Architecture:.*/Architecture: $(shell dpkg --print-architecture)/" $(CLI_DEB_WORK)/DEBIAN/control
	sed -i "s/^Version:.*/Version: $(APP_VERSION)-1/" $(CLI_DEB_WORK)/DEBIAN/control
	sed -i 's/^Installed-Size:.*//' $(CLI_DEB_WORK)/DEBIAN/control
	sed -i '/^$$/d' $(CLI_DEB_WORK)/DEBIAN/control
	echo "Installed-Size: $$(du -sk $(CLI_DEB_WORK) | cut -f1)" >> $(CLI_DEB_WORK)/DEBIAN/control
	mkdir -p releases
	dpkg-deb --build --root-owner-group $(CLI_DEB_WORK) $(CLI_DEB_HOST)
	rm -rf $(CLI_DEB_WORK)
	@echo "✓ CLI package: $(CLI_DEB_HOST)"
	@ls -lh $(CLI_DEB_HOST)

# ─── Build CLI (art) .deb — ARM64 (aarch64 / CM4 / uConsole / RPi) ───────────
CLI_BINARY_ARM64 := $(TAURI_SRC)/target/$(ARM64_TARGET)/release/art
CLI_DEB_ARM64    := releases/$(CLI_NAME)_$(APP_VERSION)-1_arm64.deb

deb-cli-arm64: _arm64-check-tools
	@echo "→ Cross-compiling $(CLI_NAME) for $(ARM64_TARGET)…"
	PKG_CONFIG_SYSROOT_DIR=/ \
	PKG_CONFIG_PATH=/usr/lib/aarch64-linux-gnu/pkgconfig:/usr/share/pkgconfig \
	PKG_CONFIG_ALLOW_CROSS=1 \
	CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=$(ARM64_CROSS_CC) \
	  cargo build \
	    --manifest-path $(TAURI_SRC)/Cargo.toml \
	    --release --target $(ARM64_TARGET) --bin art --features tui
	@test -f "$(CLI_BINARY_ARM64)" || (echo "ERROR: arm64 art binary not found"; exit 1)
	$(eval CLI_AMD64_REF := $(shell ls -t releases/$(CLI_NAME)_*_amd64.deb 2>/dev/null | head -1))
	@test -n "$(CLI_AMD64_REF)" || (echo "ERROR: no amd64 CLI .deb scaffold in releases/"; exit 1)
	rm -rf $(CLI_DEB_WORK)
	dpkg-deb -R "$(CLI_AMD64_REF)" $(CLI_DEB_WORK)
	cp -f $(CLI_BINARY_ARM64) $(CLI_DEB_WORK)/usr/bin/art
	chmod 755 $(CLI_DEB_WORK)/usr/bin/art
	file $(CLI_DEB_WORK)/usr/bin/art
	sed -i 's/^Architecture:.*/Architecture: arm64/' $(CLI_DEB_WORK)/DEBIAN/control
	sed -i "s/^Version:.*/Version: $(APP_VERSION)-1/" $(CLI_DEB_WORK)/DEBIAN/control
	sed -i 's/^Installed-Size:.*//' $(CLI_DEB_WORK)/DEBIAN/control
	sed -i '/^$$/d' $(CLI_DEB_WORK)/DEBIAN/control
	echo "Installed-Size: $$(du -sk $(CLI_DEB_WORK) | cut -f1)" >> $(CLI_DEB_WORK)/DEBIAN/control
	mkdir -p releases
	dpkg-deb --build --root-owner-group $(CLI_DEB_WORK) $(CLI_DEB_ARM64)
	rm -rf $(CLI_DEB_WORK)
	@echo "✓ CLI ARM64 package: $(CLI_DEB_ARM64)"
	@ls -lh $(CLI_DEB_ARM64)

# ─── Install (requires sudo / root) ──────────────────────────────────────────
install: build
	@echo "→ Installing $(APP_NAME) to $(PREFIX)…"

	# 1. Binary
	$(INSTALL) -d $(BINDIR)
	$(INSTALL) -m 755 $(BINARY) $(BINDIR)/$(APP_NAME)

	# 2. Frontend assets (HTML / JS / CSS / images)
	$(INSTALL) -d $(APPDIR)
	$(CP) src/. $(APPDIR)/

	# 3. Icons (hicolor theme — standard sizes)
	$(INSTALL) -d $(ICONDIR)/32x32/apps
	$(INSTALL) -d $(ICONDIR)/128x128/apps
	$(INSTALL) -d $(ICONDIR)/256x256/apps
	$(INSTALL) -d $(ICONDIR)/512x512/apps
	$(INSTALL) -m 644 $(TAURI_SRC)/icons/32x32.png       $(ICONDIR)/32x32/apps/$(APP_NAME).png
	$(INSTALL) -m 644 $(TAURI_SRC)/icons/128x128.png     $(ICONDIR)/128x128/apps/$(APP_NAME).png
	$(INSTALL) -m 644 $(TAURI_SRC)/icons/128x128@2x.png  $(ICONDIR)/256x256/apps/$(APP_NAME).png
	$(INSTALL) -m 644 $(TAURI_SRC)/icons/icon.png        $(ICONDIR)/512x512/apps/$(APP_NAME).png
	-gtk-update-icon-cache -f -t $(SHAREDIR)/icons/hicolor 2>/dev/null || true

	# 4. .desktop launcher
	$(INSTALL) -d $(DESKTOPDIR)
	$(INSTALL) -m 644 $(APP_NAME).desktop $(DESKTOPDIR)/$(APP_NAME).desktop
	-update-desktop-database $(DESKTOPDIR) 2>/dev/null || true

	@echo "✓ Installed to $(PREFIX)"
	@echo "  Run: $(APP_NAME)"

# ─── Uninstall ────────────────────────────────────────────────────────────────
uninstall:
	@echo "→ Removing $(APP_NAME)…"
	rm -f  $(BINDIR)/$(APP_NAME)
	rm -rf $(APPDIR)
	rm -f  $(ICONDIR)/32x32/apps/$(APP_NAME).png
	rm -f  $(ICONDIR)/128x128/apps/$(APP_NAME).png
	rm -f  $(ICONDIR)/256x256/apps/$(APP_NAME).png
	rm -f  $(ICONDIR)/512x512/apps/$(APP_NAME).png
	rm -f  $(DESKTOPDIR)/$(APP_NAME).desktop
	-gtk-update-icon-cache -f -t $(SHAREDIR)/icons/hicolor 2>/dev/null || true
	-update-desktop-database $(DESKTOPDIR) 2>/dev/null || true
	@echo "✓ Uninstalled"

# ─── Clean build artefacts ────────────────────────────────────────────────────
clean:
	@echo "→ Cleaning build artefacts…"
	cargo clean --manifest-path $(TAURI_SRC)/Cargo.toml
	@echo "✓ Clean"

# ─── Install Debian build dependencies (host / x86-64) ───────────────────────
deps:
	@echo "→ Installing build dependencies…"
	sudo apt-get update
	sudo apt-get install -y \
		build-essential \
		curl \
		libwebkit2gtk-4.1-dev \
		libgtk-3-dev \
		libayatana-appindicator3-dev \
		librsvg2-dev \
		patchelf \
		lld
	@# Install Rust if not present
	@command -v rustc >/dev/null 2>&1 || \
		(curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && \
		 . "$$HOME/.cargo/env")
	@# Install tauri-cli if not present
	@command -v cargo-tauri >/dev/null 2>&1 || cargo install tauri-cli
	@echo "✓ Dependencies ready"

# ─── Install ARM64 cross-compilation toolchain ────────────────────────────────
deps-arm64:
	@echo "→ Installing ARM64 (aarch64) cross-compilation toolchain…"
	sudo apt-get update
	sudo apt-get install -y \
		gcc-aarch64-linux-gnu \
		binutils-aarch64-linux-gnu \
		dpkg-dev \
		file
	@# Add Rust aarch64 target
	rustup target add aarch64-unknown-linux-gnu
	@echo "✓ ARM64 cross-compilation toolchain ready"
	@echo "  Cross-compiler: $$(which aarch64-linux-gnu-gcc)"
	@echo "  Rust target:    aarch64-unknown-linux-gnu"
	@echo "  Now run: make deb-arm64"

# ─── Fast check (no link, no bundle) ──────────────────────────────────────────
check:
	cargo check --manifest-path $(TAURI_SRC)/Cargo.toml

# ─── Android targets ───────────────────────────────────────────────────────────
# Prerequisites: ANDROID_HOME, ANDROID_NDK_HOME must be set in environment.
# Run 'make android-setup' once to generate the Gradle project.

ANDROID_HOME ?= $(HOME)/android-sdk
ANDROID_NDK_HOME ?= $(ANDROID_HOME)/ndk/28.0.13004108
NDK_VERSION ?= 28.0.13004108

export ANDROID_HOME
export ANDROID_NDK_HOME
export NDK_VERSION

android-setup:
	@echo "→ Setting up Tauri Android project…"
	rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android
	cargo install cargo-ndk --locked 2>/dev/null || true
	$(CARGO_TAURI) android init
	@echo "✓ Android project generated in $(TAURI_SRC)/gen/android/"
	@echo "  Review AndroidManifest.xml and customize icons before building."

android-dev:
	@echo "→ Starting Android dev server (connect device or start emulator first)…"
	$(CARGO_TAURI) android dev

android-build:
	@echo "→ Building Android APK (release)…"
	$(CARGO_TAURI) android build --apk
	@echo "✓ APK output:"
	@find $(TAURI_SRC)/gen/android -name "*.apk" 2>/dev/null | head -5 || echo "  (check build output above)"

android-check:
	@echo "→ Fast compile check for Android (aarch64)…"
	cargo check \
	  --manifest-path $(TAURI_SRC)/Cargo.toml \
	  --no-default-features \
	  --target aarch64-linux-android 2>&1 | grep -E "^error|^warning.*unused" | head -20
	@echo "✓ Check complete"
