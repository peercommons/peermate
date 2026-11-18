// Scan a friend's QR code (SPECS §2.4). The code holds their friend link;
// a valid one opens the same confirmation as tapping the link.
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import { parseFriendLink } from '../net/friends';
import { ui } from '../theme';

export default function ScanScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [bad, setBad] = useState(false);
  const handled = useRef(false);

  if (!permission) return <View style={styles.root} />;
  if (!permission.granted) {
    return (
      <View style={[styles.root, styles.center]}>
        <Text style={styles.text}>
          Peermate needs the camera to scan a friend's QR code. Nothing is recorded or sent anywhere.
        </Text>
        {permission.canAskAgain ? (
          <Button label="Allow camera" onPress={requestPermission} />
        ) : (
          <Text style={styles.text}>Camera access is off. Turn it on for Peermate in your phone's Settings.</Text>
        )}
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          if (handled.current) return;
          const f = parseFriendLink(data);
          if (!f) {
            setBad(true);
            return;
          }
          handled.current = true;
          router.replace({ pathname: '/p/[key]', params: { key: f.key, n: f.npub, nick: f.nick } });
        }}
      />
      <View style={styles.overlay} pointerEvents="none">
        <View style={styles.frame} />
        <Text style={styles.hint}>
          {bad ? "That QR code isn't a Peermate friend code." : "Point at your friend's Peermate QR code"}
        </Text>
      </View>
    </View>
  );
}

function Button({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.button, pressed && { opacity: 0.7 }]} accessibilityRole="button">
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16, backgroundColor: ui.background },
  text: { fontSize: 16, color: ui.text, textAlign: 'center' },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 24 },
  frame: { width: 240, height: 240, borderWidth: 3, borderColor: '#fff', borderRadius: 16 },
  hint: {
    color: '#fff',
    fontSize: 16,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    overflow: 'hidden',
  },
  button: { backgroundColor: ui.accent, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
