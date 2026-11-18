// Extends app.json with values that change per build.
// PEERMATE_VERSION_CODE: the build number (Android versionCode, iOS
// CFBundleVersion). Must increase every build, or Android refuses to install the
// update over the previous one. Fastlane sets it.
const build = Number(process.env.PEERMATE_VERSION_CODE || 1);

module.exports = ({ config }) => ({
  ...config,
  android: {
    ...config.android,
    versionCode: build,
  },
  ios: {
    ...config.ios,
    buildNumber: String(build),
  },
});
