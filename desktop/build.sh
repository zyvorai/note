#!/bin/sh
# Builds dist/Notes.app (macOS). Needs Xcode command line tools; the app needs Node.js at run time.
set -e
cd "$(dirname "$0")/.."
APP=dist/Notes.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -swift-version 5 desktop/Notes.swift -o "$APP/Contents/MacOS/Notes"
cp server.js "$APP/Contents/Resources/"
cp -R public "$APP/Contents/Resources/public"
cat > "$APP/Contents/Info.plist" <<'P'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Notes</string>
  <key>CFBundleDisplayName</key><string>Notes</string>
  <key>CFBundleIdentifier</key><string>dev.local.notes</string>
  <key>CFBundleExecutable</key><string>Notes</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
P
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
echo "Built $APP"
