import '../../polyfills'; // must run before anything that generates keys
import { useEffect } from 'react';
import { Alert } from 'react-native';
import { Stack, router } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { registerBackgroundCheck } from '../background';
import { friendOf, isChallengeTap, setupNotifications } from '../net/notify';
import { online, useInvite } from '../net/online';
import { StatusBar } from 'expo-status-bar';
import { SettingsProvider } from '../settings';
import { ui } from '../theme';

export default function RootLayout() {
  // An online game that was running when the app closed carries on.
  useEffect(() => {
    if (online.savedOpponent()) online.resumeSaved();
    void online.listen(); // reachable for challenges while the app is open
    setupNotifications();
    void registerBackgroundCheck();
    // A tapped message notification opens that conversation (also from a cold start).
    const open = (r: Notifications.NotificationResponse | null) => {
      const key = friendOf(r);
      if (!key) return;
      // A challenge shows as a dialog wherever we are; open Friends behind it.
      if (isChallengeTap(r)) router.push('/friends');
      else router.push({ pathname: '/chat/[key]', params: { key } });
    };
    void Notifications.getLastNotificationResponseAsync().then(open);
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, []);

  // A friend's challenge, wherever the player is in the app.
  const invite = useInvite();
  useEffect(() => {
    if (!invite) return;
    if (invite.kind === 'offline') {
      const mins = Math.max(1, Math.round((Date.now() - invite.at) / 60_000));
      const ago = mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
      Alert.alert(
        `${invite.nick} challenged you`,
        `${invite.tc} (minutes + seconds per move), ${ago}.\n\n` +
          `They may not be in the app now. Challenge them back: if they're around, the game starts when they accept; if not, they'll get a notification.`,
        [
          { text: 'Not now', style: 'cancel', onPress: () => online.declineInvite() },
          {
            text: 'Challenge back',
            onPress: () => {
              void online.acceptInvite();
              router.push('/online');
            },
          },
        ],
        { cancelable: false },
      );
      return;
    }
    Alert.alert(
      invite.kind === 'answer' ? `${invite.nick} accepted your challenge` : `${invite.nick} challenges you`,
      `${invite.tc} (minutes + seconds per move)\nID ${invite.fingerprint}` +
        (invite.friend ? '' : `\n\n${invite.nick} isn't in your friends yet. Accepting adds them.`),
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
        <Stack.Screen name="scan" options={{ title: 'Scan QR code' }} />
        <Stack.Screen name="chat/[key]" options={{ title: 'Messages' }} />
      </Stack>
    </SettingsProvider>
  );
}
