import '../../polyfills'; // must run before anything that generates keys
import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { online } from '../net/online';
import { StatusBar } from 'expo-status-bar';
import { SettingsProvider } from '../settings';
import { ui } from '../theme';

export default function RootLayout() {
  // An online game that was running when the app closed carries on.
  useEffect(() => {
    if (online.savedOpponent()) online.resumeSaved();
  }, []);

  return (
    <SettingsProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerTintColor: ui.accent,
          contentStyle: { backgroundColor: ui.background },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Peermate' }} />
        <Stack.Screen name="game" options={{ title: 'Game' }} />
        <Stack.Screen name="review" options={{ title: 'Review' }} />
        <Stack.Screen name="history" options={{ title: 'Your games' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        <Stack.Screen name="online" options={{ title: 'Play online' }} />
        <Stack.Screen name="online-game" options={{ title: 'Online game', gestureEnabled: false }} />
        <Stack.Screen name="dev" options={{ title: 'Dev tools' }} />
      </Stack>
    </SettingsProvider>
  );
}
