// Extends app.json with values that change per build.
// PEERMATE_VERSION_CODE: Android versionCode. Must increase every build, or Android
// refuses to install the update over the previous one. Fastlane sets it.
module.exports = ({ config }) => ({
  ...config,
  android: {
    ...config.android,
    versionCode: Number(process.env.PEERMATE_VERSION_CODE || 1),
  },
});
