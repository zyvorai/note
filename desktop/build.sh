#!/bin/sh
# Builds dist/Plainnote.app (macOS). Needs Xcode command line tools; the app needs Node.js at run time.
set -e
cd "$(dirname "$0")/.."
APP=dist/Plainnote.app
TMP=$(mktemp -d)
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
SRC="desktop/main.swift desktop/App.swift desktop/Window.swift desktop/Menus.swift desktop/Integration.swift desktop/Capture.swift"
# Universal binary (Apple Silicon + Intel); falls back to the host architecture if the other slice can't be built.
if swiftc -O -swift-version 5 -target arm64-apple-macos12 $SRC -o "$TMP/p-arm64" 2>/dev/null && swiftc -O -swift-version 5 -target x86_64-apple-macos12 $SRC -o "$TMP/p-x86_64" 2>/dev/null; then
  lipo -create -output "$APP/Contents/MacOS/Plainnote" "$TMP/p-arm64" "$TMP/p-x86_64"
else
  echo "note: universal build unavailable, building for this Mac only" >&2
  swiftc -O -swift-version 5 $SRC -o "$APP/Contents/MacOS/Plainnote"
fi
swiftc -O -swift-version 5 desktop/icon.swift -o "$TMP/icon"
"$TMP/icon" "$TMP/Plainnote.iconset"
iconutil -c icns "$TMP/Plainnote.iconset" -o "$APP/Contents/Resources/Plainnote.icns"
rm -rf "$TMP"
cp server.js "$APP/Contents/Resources/"
cp -R public "$APP/Contents/Resources/public"
cat > "$APP/Contents/Info.plist" <<'P'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Plainnote</string>
  <key>CFBundleDisplayName</key><string>Plainnote</string>
  <key>CFBundleIdentifier</key><string>dev.plainnote.app</string>
  <key>CFBundleExecutable</key><string>Plainnote</string>
  <key>CFBundleIconFile</key><string>Plainnote</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.11.1</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>CFBundleURLTypes</key><array><dict><key>CFBundleURLName</key><string>Plainnote</string><key>CFBundleURLSchemes</key><array><string>plainnote</string></array></dict></array>
  <key>CFBundleDocumentTypes</key><array>
    <dict><key>CFBundleTypeName</key><string>Markdown</string><key>CFBundleTypeRole</key><string>Editor</string><key>LSHandlerRank</key><string>Alternate</string>
      <key>CFBundleTypeExtensions</key><array><string>md</string><string>markdown</string></array></dict>
    <dict><key>CFBundleTypeName</key><string>Folder</string><key>CFBundleTypeRole</key><string>Viewer</string><key>LSHandlerRank</key><string>None</string>
      <key>LSItemContentTypes</key><array><string>public.folder</string></array></dict>
  </array>
  <key>NSServices</key><array><dict>
    <key>NSMenuItem</key><dict><key>default</key><string>New Plainnote from Selection</string></dict>
    <key>NSMessage</key><string>newNoteFromSelection</string><key>NSPortName</key><string>Plainnote</string>
    <key>NSSendTypes</key><array><string>NSStringPboardType</string></array></dict></array>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
P
# Ad-hoc signature by default. For distribution set SIGN_ID="Developer ID Application: …"
# (hardened runtime + secure timestamp, required for notarization; failures are fatal).
if [ -n "${SIGN_ID:-}" ]; then
  codesign --force --timestamp --options runtime --sign "$SIGN_ID" "$APP"
  codesign --verify --deep --strict "$APP"
else
  codesign --force --sign - "$APP" >/dev/null 2>&1 || true
fi
echo "Built $APP"
