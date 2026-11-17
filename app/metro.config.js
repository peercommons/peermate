// Metro packs the Bare workers (see "workers" in app.json) and resolves
// `expo-bare-kit/workers/<name>` imports to them.
const { getDefaultConfig } = require('expo/metro-config')
const withBareKit = require('expo-bare-kit/metro')

module.exports = withBareKit(getDefaultConfig(__dirname))
