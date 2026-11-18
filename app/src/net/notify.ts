// Local notifications for friends' messages (SPECS §8.4). No push server: they
// come from the app itself, while open or from the periodic background check.
import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

const CHANNEL = 'messages';
let openChat: string | null = null;
let ready = false;

export function setupNotifications(): void {
  if (ready) return;
  ready = true;
  // Shown even while the app is open (a message from someone whose chat isn't on screen).
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  if (Platform.OS === 'android') {
    void Notifications.setNotificationChannelAsync(CHANNEL, {
      name: 'Messages from friends',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
}

/** Asks once; later calls just report the answer. */
export async function ensureNotificationPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted || !current.canAskAgain) return current.granted;
  return (await Notifications.requestPermissionsAsync()).granted;
}

/** The conversation on screen, whose messages need no notification. */
export function setOpenChat(friendKey: string | null): void {
  openChat = friendKey;
}

export function notifyMessage(friendKey: string, nick: string, text: string): void {
  if (AppState.currentState === 'active' && openChat === friendKey) return;
  setupNotifications();
  void Notifications.scheduleNotificationAsync({
    content: {
      title: nick,
      body: text.length > 200 ? `${text.slice(0, 200)}…` : text,
      data: { friendKey },
      ...(Platform.OS === 'android' ? { channelId: CHANNEL } : {}),
    },
    trigger: null,
  }).catch(() => undefined);
}

/** The friend a tapped notification was about. */
export function friendOf(response: Notifications.NotificationResponse | null): string | null {
  const key = response?.notification.request.content.data?.friendKey;
  return typeof key === 'string' ? key : null;
}
