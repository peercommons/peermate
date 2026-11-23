// Whether this build answers the peermate://demo links (sample content for the
// Android store screenshots, tools/screenshots-android.sh). Any web page or
// message can hold a link, so public builds must not: it is switched on only
// while `fastlane android sideload demo:true` builds, and never committed as true
// (store builds refuse uncommitted changes; CI checks this line).
export const DEMO_LINKS = false;
