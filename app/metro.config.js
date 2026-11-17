// Metro packs the Bare workers (see "workers" in app.json) and resolves
// `expo-bare-kit/workers/<name>` imports to them. It also watches ../core, the
// shared pure-TypeScript package (linked as @peermate/core).
const path = require('path')
const { getDefaultConfig } = require('expo/metro-config')
const withBareKit = require('expo-bare-kit/metro')

const config = getDefaultConfig(__dirname)
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, '../core')]

module.exports = withBareKit(config)
