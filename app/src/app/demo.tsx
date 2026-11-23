// peermate://demo (store screenshots): fills a fresh install with sample content.
// peermate://demo?game=1 then starts the sample online game. Only in demo builds
// (src/demoBuild.ts); elsewhere the link just goes Home.
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { seedDemo, startDemoGame } from '../demo';
import { DEMO_LINKS } from '../demoBuild';
import { ui } from '../theme';

export default function DemoScreen() {
  const { game } = useLocalSearchParams<{ game?: string }>();
  const [message, setMessage] = useState('Setting up the demo…');

  useEffect(() => {
    if (!DEMO_LINKS) {
      router.replace('/');
      return;
    }
    if (game) {
      void startDemoGame().catch((err) => setMessage(String(err)));
      router.replace('/online-game');
      return;
    }
    seedDemo().then(
      () => router.dismissTo('/'), // back to the Home underneath, not a second one
      (err) => setMessage((err as Error).message),
    );
  }, [game]);

  return (
    <View style={styles.root}>
      <Text style={styles.text}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  text: { color: ui.text, fontSize: 16, textAlign: 'center' },
});
