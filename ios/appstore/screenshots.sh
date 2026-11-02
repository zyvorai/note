#!/bin/sh
# Captures the App Store screenshots from the iPhone 17 simulator (6.3-inch, 1206x2622: the size App Store Connect asks for first) into ios/appstore/screenshots/.
#   ./ios/appstore/screenshots.sh
set -e
cd "$(dirname "$0")/../.."
SIM="${SIM_NAME:-iPhone 17}"; OUT=ios/appstore/screenshots; mkdir -p $OUT
N=$(mktemp -d); mkdir -p "$N/Projects" "$N/daily"
cat > "$N/Weekend Trip.md" <<'MD'
---
tags: [travel, planning]
---
# Weekend Trip

A slow weekend by the lake. Packing list and plan, linked to [[Recipes]] and [[Reading List]].

## Packing
- [x] Passport and tickets
- [x] Camera and charger
- [ ] Hiking boots
- [ ] Warm jacket for the evening

## Plan
1. Saturday: train at 08:12, lunch by the water
2. Sunday: morning hike, back before dark

> The best trips leave room for nothing at all.

#travel #weekend
MD
cat > "$N/Recipes.md" <<'MD'
# Recipes

Slow-cooked tomato pasta, ready in 40 minutes. See [[Weekend Trip]] for the picnic basket.

- 400 g spaghetti
- **ripe tomatoes**, garlic, basil
- olive oil and a pinch of salt
MD
cat > "$N/Reading List.md" <<'MD'
# Reading List

- [x] The Pragmatic Programmer
- [ ] A Pattern Language
- [ ] Thinking in Systems
MD
cat > "$N/Projects/Roadmap.md" <<'MD'
# Roadmap

Q4 goals and milestones. Ship the phone app, polish the graph, write the docs.
MD
cat > "$N/daily/2026-11-02.md" <<'MD'
# Monday

Morning pages, then a long walk. Idea: link every book note to the people who recommended it.
MD
cat > "$N/Ideas.md" <<'MD'
Notes are better as files than as a database. Own your words, link your thoughts.
MD
touch -t 202611020800 "$N/Weekend Trip.md"; touch -t 202611011500 "$N/Recipes.md"; touch -t 202610301100 "$N/Reading List.md"
touch -t 202610281000 "$N/Projects/Roadmap.md"; touch -t 202611020900 "$N/daily/2026-11-02.md"; touch -t 202610201000 "$N/Ideas.md"

xcrun simctl shutdown all 2>/dev/null || true
UDID=$(xcrun simctl list devices available | grep "$SIM (" | head -1 | grep -oE "[0-9A-F]{8}-([0-9A-F]{4}-){3}[0-9A-F]{12}")
xcrun simctl boot "$UDID"; xcrun simctl bootstatus "$UDID" -b >/dev/null
xcrun simctl status_bar "$UDID" override --time 9:41 --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3 >/dev/null 2>&1 || true
APP=$(find ios/build -name Plainnote.app -path "*iphonesimulator*" | head -1)
xcrun simctl uninstall "$UDID" dev.plainnote.ios 2>/dev/null || true; xcrun simctl install "$UDID" "$APP"
shot() {   # name appearance url js
  xcrun simctl ui "$UDID" appearance "$2" >/dev/null 2>&1 || true
  xcrun simctl terminate "$UDID" dev.plainnote.ios 2>/dev/null || true
  env SIMCTL_CHILD_PLAINNOTE_DIR="$N" ${3:+SIMCTL_CHILD_PLAINNOTE_URL="$3"} ${4:+SIMCTL_CHILD_PLAINNOTE_EVAL="$4"} xcrun simctl launch "$UDID" dev.plainnote.ios >/dev/null
  sleep 7; xcrun simctl io "$UDID" screenshot "$OUT/$1.png" >/dev/null 2>&1; echo "$1"
}
shot 1-read light "plainnote://open/Weekend%20Trip" ""
shot 2-notes light "plainnote://open/Weekend%20Trip" "document.body.classList.add('side-open')"
shot 3-live-preview light "plainnote://open/Weekend%20Trip" "setLivePreview(true)"
shot 4-dark dark "plainnote://open/Weekend%20Trip" ""
shot 5-graph light "plainnote://open/Weekend%20Trip" "document.querySelector('#grm').click()"
xcrun simctl ui "$UDID" appearance light >/dev/null 2>&1; xcrun simctl status_bar "$UDID" clear >/dev/null 2>&1 || true
sips -g pixelWidth -g pixelHeight "$OUT"/*.png | grep -E "pixel|png" | paste - - -
