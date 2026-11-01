#!/bin/sh
# Builds dist/Plainnote.app (macOS). Needs Xcode command line tools; the app needs Node.js at run time.
set -e
cd "$(dirname "$0")/.."
APP=dist/Plainnote.app
TMP=$(mktemp -d)
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -swift-version 5 desktop/Plainnote.swift -o "$APP/Contents/MacOS/Plainnote"
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
  <key>CFBundleShortVersionString</key><string>0.5.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
P
# Ad-hoc signature by default. For distribution set SIGN_ID="Developer ID Application: …" (then notarize with notarytool).
codesign --force --sign "${SIGN_ID:--}" "$APP" >/dev/null 2>&1 || true
echo "Built $APP"
