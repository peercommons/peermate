// expo-notifications adds the remote-push entitlement (aps-environment) on iOS.
// Peermate only posts local notifications (no push server, SPECS §8.4), and a
// provisioning profile without the Push capability refuses to sign with it.
const { withEntitlementsPlist } = require('@expo/config-plugins');

module.exports = function withoutRemotePush(config) {
  return withEntitlementsPlist(config, (c) => {
    delete c.modResults['aps-environment'];
    return c;
  });
};
