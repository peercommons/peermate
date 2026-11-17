import '../../polyfills'; // must run before anything that generates keys
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ui } from '../theme';

export default function RootLayout() {
  return (
    <>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerTintColor: ui.accent,
          contentStyle: { backgroundColor: ui.background },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Peermate' }} />
        <Stack.Screen name="game" options={{ title: 'Game' }} />
        <Stack.Screen name="dev" options={{ title: 'Dev tools' }} />
      </Stack>
    </>
  );
}
