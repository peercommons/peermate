import '../../polyfills'; // must run before anything that generates keys
import { useEffect } from 'react';
import { Alert } from 'react-native';
import { Stack, router } from 'expo-router';
import { online, useInvite } from '../net/online';
import { StatusBar } from 'expo-status-bar';
import { SettingsProvider } from '../settings';
import { ui } from '../theme';

export default function RootLayout() {
  // An online game that was running when the app closed carries on.
  useEffect(() => {
    if (online.savedOpponent()) online.resumeSaved();
    void online.listen(); // reachable for friends' challenges while the app is open
  }, []);

  // A friend's challenge, wherever the player is in the app.
  const invite = useInvite();
  useEffect(() => {
    if (!invite) return;
    Alert.alert(
      `${invite.nick} challenges you`,
      `${invite.tc} (minutes + seconds per move)`,
      [
        { text: 'Decline', style: 'cancel', onPress: () => online.declineInvite() },
        {
          text: 'Accept',
          onPress: () => {
            if (!online.invite) return Alert.alert('Challenge withdrawn', `${invite.nick} took the challenge back.`);
            void online.acceptInvite();
            router.push('/online');
          },
        },
      ],
      { cancelable: false },
    );
  }, [invite]);

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
        <Stack.Screen name="friends" options={{ title: 'Friends' }} />
        <Stack.Screen name="p/[key]" options={{ title: 'Friend link' }} />
      </Stack>
    </SettingsProvider>
  );
}
