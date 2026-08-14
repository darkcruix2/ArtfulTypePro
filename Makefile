# ─── ArtfulType-rs Makefile ───────────────────────────────────────────────────
#
# Targets:
#   make             – build release binary (same as 'make build')
#   make build       – compile release binary via cargo tauri build
#   make deb         – build .deb package (requires tauri-cli)
#   make install     – install binary + assets to system paths (requires sudo)
#   make uninstall   – remove installed files (requires sudo)
#   make clean       – remove build artefacts
#   make deps        – install Debian build dependencies
#   make check       – run cargo check only (fast compile check, no bundle)

# ─── Metadata ────────────────────────────────────────────────────────────────
APP_NAME    := artfultype-rs
APP_VERSION := 0.30.3
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
CARGO_TAURI := cargo tauri
INSTALL     := install
CP          := cp -r

# ─────────────────────────────────────────────────────────────────────────────
.DEFAULT_GOAL := build
.PHONY: all build deb install uninstall clean deps check \
        android-setup android-dev android-build android-check

# ─── Build release binary ─────────────────────────────────────────────────────
all: build

build:
	@echo "→ Building $(APP_NAME) $(APP_VERSION) (release)…"
	$(CARGO_TAURI) build --no-bundle
	@echo "✓ Binary: $(BINARY)"

# ─── Build .deb package ───────────────────────────────────────────────────────
deb:
	@echo "→ Building $(APP_NAME) .deb package…"
	$(CARGO_TAURI) build --bundles deb
	@echo "✓ Package(s):"
	@ls -1 $(DEB_DIR)/*.deb 2>/dev/null || echo "  (no .deb found — check build output above)"

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

# ─── Install Debian build dependencies ────────────────────────────────────────
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
