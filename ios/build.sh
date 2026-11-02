#!/bin/sh
# iOS build helper.   ./ios/build.sh [icon|project|test|build|selftest|archive]
#   icon      render the app icon (full-bleed, no alpha) into the asset catalog
#   project   generate Plainnote.xcodeproj with xcodegen
#   test      run the XCTests (NotesStore / Router) on an iPhone simulator
#   build     build the app for the simulator
#   selftest  build, install and launch it twice in the simulator and verify the real web UI against the native bridge
#   archive   signed device archive (needs DEVELOPMENT_TEAM=<team id>)
set -e
cd "$(dirname "$0")/.."
SIM=${SIM_NAME:-iPhone 17}
DD=ios/build
run_icon() {
  T=$(mktemp -d); A=ios/Resources/Assets.xcassets/AppIcon.appiconset
  swiftc -O desktop/icon.swift -o "$T/icon"
  strip_alpha() { sips -s format jpeg "$1" --out "$T/x.jpg" >/dev/null; sips -s format png "$T/x.jpg" --out "$2" >/dev/null; }   # the App Store rejects an alpha channel
  ICON_IOS=light "$T/icon" "$T/set" "$T/light.png" >/dev/null; strip_alpha "$T/light.png" "$A/icon-1024.png"
  ICON_IOS=dark "$T/icon" "$T/set" "$T/dark.png" >/dev/null; strip_alpha "$T/dark.png" "$A/icon-1024-dark.png"
  sips -s format png "$T/dark.png" --matchTo "/System/Library/ColorSync/Profiles/Generic Gray Profile.icc" --out "$T/gray.png" >/dev/null   # tinted variant: iOS colours the luminance itself
  strip_alpha "$T/gray.png" "$A/icon-1024-tinted.png"
  for n in 192 512; do sips -Z $n "$A/icon-1024.png" --out public/icon-$n.png >/dev/null; done        # installable web app (PWA) icons, flat so the single-file build can embed them
  sips -Z 180 "$A/icon-1024.png" --out public/apple-touch-icon.png >/dev/null
  rm -rf "$T"; echo "icons written"
}
run_project() {
  V=$(node -p "require('./package.json').version")
  sed -i '' "s/MARKETING_VERSION: \".*\"/MARKETING_VERSION: \"$V\"/" ios/project.yml
  (cd ios && xcodegen generate --quiet)
}
case "${1:-build}" in
  icon) run_icon ;;
  project) run_project ;;
  test) run_project; xcodebuild test -project ios/Plainnote.xcodeproj -scheme Plainnote -destination "platform=iOS Simulator,name=$SIM" -derivedDataPath $DD CODE_SIGNING_ALLOWED=NO 2>&1 | grep -E "Test Case|Executed|error:|warning: unused|BUILD|TEST" ;;
  build) run_project; xcodebuild build -project ios/Plainnote.xcodeproj -scheme Plainnote -destination "platform=iOS Simulator,name=$SIM" -derivedDataPath $DD CODE_SIGNING_ALLOWED=NO 2>&1 | grep -E "error:|BUILD" ;;
  selftest)
    "$0" build
    APP=$(find $DD -name Plainnote.app -path "*iphonesimulator*" | head -1)
    xcrun simctl boot "$SIM" 2>/dev/null || true
    xcrun simctl bootstatus "$SIM" -b >/dev/null
    xcrun simctl uninstall booted dev.plainnote.ios 2>/dev/null || true
    xcrun simctl install booted "$APP"
    NOTES=$(mktemp -d)
    for n in 1 2; do
      SIMCTL_CHILD_PLAINNOTE_SELFTEST=$n SIMCTL_CHILD_PLAINNOTE_DIR=$NOTES xcrun simctl launch booted dev.plainnote.ios >/dev/null
      i=0; while [ ! -f "$NOTES/.selftest-$n.json" ] && [ $i -lt 40 ]; do sleep 0.5; i=$((i+1)); done
      cat "$NOTES/.selftest-$n.json" 2>/dev/null || { echo "selftest $n: no result"; exit 1; }; echo
      xcrun simctl terminate booted dev.plainnote.ios
      node -e "process.exit(JSON.parse(require('fs').readFileSync('$NOTES/.selftest-$n.json','utf8')).ok ? 0 : 1)" || { echo "selftest $n FAILED"; exit 1; }
    done
    xcrun simctl io booted screenshot ios/build/screenshot.png >/dev/null 2>&1 || true
    echo "selftest passed (notes in $NOTES)" ;;
  archive)
    [ -n "$DEVELOPMENT_TEAM" ] || { echo "set DEVELOPMENT_TEAM=<team id>"; exit 1; }
    run_project
    xcodebuild archive -project ios/Plainnote.xcodeproj -scheme Plainnote -destination "generic/platform=iOS" -archivePath $DD/Plainnote.xcarchive DEVELOPMENT_TEAM=$DEVELOPMENT_TEAM -allowProvisioningUpdates 2>&1 | grep -E "error:|ARCHIVE" ;;
  *) echo "unknown command"; exit 2 ;;
esac
