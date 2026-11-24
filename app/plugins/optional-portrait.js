// Locking the activity to portrait makes Android imply a required
// android.hardware.screen.portrait feature, so Play hides Peermate from devices
// without one (some tablets, Chromebooks, Android XR) and warns on every
// release. Keep the portrait layout, but declare the feature optional.
const { withAndroidManifest } = require('@expo/config-plugins');

const FEATURE = 'android.hardware.screen.portrait';

module.exports = function withOptionalPortrait(config) {
  return withAndroidManifest(config, (c) => {
    const manifest = c.modResults.manifest;
    const features = (manifest['uses-feature'] ??= []);
    const existing = features.find((f) => f.$['android:name'] === FEATURE);
    if (existing) existing.$['android:required'] = 'false';
    else features.push({ $: { 'android:name': FEATURE, 'android:required': 'false' } });
    return c;
  });
};
