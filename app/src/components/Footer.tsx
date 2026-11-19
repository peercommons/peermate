// The app's footer: main sections as icon + short label, on every screen except
// the ones that need the whole height (boards, the camera, a chat's keyboard).
// "More" opens a small menu with the rest.
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, usePathname, type Href } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnread } from '../net/messages';
import { ui } from '../theme';

type IconName = keyof typeof Ionicons.glyphMap;

const TABS: { key: string; label: string; icon: IconName; href: Href; match: (p: string) => boolean }[] = [
  { key: 'home', label: 'Home', icon: 'home-outline', href: '/', match: (p) => p === '/' },
  { key: 'online', label: 'Online', icon: 'globe-outline', href: '/online', match: (p) => p.startsWith('/online') },
  {
    key: 'friends',
    label: 'Friends',
    icon: 'people-outline',
    href: '/friends',
    match: (p) => p.startsWith('/friends') || p.startsWith('/chat') || p.startsWith('/p/') || p === '/scan',
  },
  {
    key: 'games',
    label: 'Games',
    icon: 'time-outline',
    href: '/history',
    match: (p) => p.startsWith('/history') || p.startsWith('/review'),
  },
];

const MORE: { label: string; icon: IconName; href: Href; match: (p: string) => boolean }[] = [
  { label: 'Settings', icon: 'settings-outline', href: '/settings', match: (p) => p === '/settings' },
  { label: 'Relay check', icon: 'pulse-outline', href: '/relays', match: (p) => p === '/relays' },
  { label: 'Dev tools', icon: 'construct-outline', href: '/dev', match: (p) => p === '/dev' },
];

/** Screens that need the full height: no footer. */
const HIDDEN = (p: string) =>
  p === '/game' || p === '/online-game' || p === '/review' || p === '/scan' || p.startsWith('/chat');

export function footerShown(path: string): boolean {
  return !HIDDEN(path);
}

export function Footer() {
  const path = usePathname();
  const insets = useSafeAreaInsets();
  const unread = Object.values(useUnread()).reduce((a, b) => a + b, 0);
  const [moreOpen, setMoreOpen] = useState(false);
  if (!footerShown(path)) return null;

  const go = (href: Href) => {
    setMoreOpen(false);
    router.navigate(href);
  };
  const moreActive = MORE.some((m) => m.match(path));

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 6) }]} accessibilityRole="tablist">
      {TABS.map((t) => {
        const active = t.match(path);
        return (
          <Tab
            key={t.key}
            label={t.label}
            icon={active ? (t.icon.replace('-outline', '') as IconName) : t.icon}
            active={active}
            badge={t.key === 'friends' && unread > 0 ? unread : 0}
            onPress={() => !active && go(t.href)}
          />
        );
      })}
      <Tab
        label="More"
        icon={moreActive ? 'ellipsis-horizontal-circle' : 'ellipsis-horizontal'}
        active={moreActive}
        onPress={() => setMoreOpen(true)}
      />

      <Modal visible={moreOpen} transparent animationType="fade" onRequestClose={() => setMoreOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setMoreOpen(false)} accessibilityLabel="Close menu">
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}>
            {MORE.map((m) => (
              <Pressable
                key={m.label}
                onPress={() => go(m.href)}
                style={({ pressed }) => [styles.item, pressed && { backgroundColor: ui.background }]}
                accessibilityRole="button"
              >
                <Ionicons name={m.icon} size={22} color={ui.accent} />
                <Text style={styles.itemText}>{m.label}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

function Tab({
  label,
  icon,
  active,
  badge = 0,
  onPress,
}: {
  label: string;
  icon: IconName;
  active: boolean;
  badge?: number;
  onPress: () => void;
}) {
  const color = active ? ui.accent : ui.subtle;
  return (
    <Pressable
      onPress={onPress}
      style={styles.tab}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={badge ? `${label}, ${badge} new` : label}
    >
      <View>
        <Ionicons name={icon} size={24} color={color} />
        {badge > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{badge > 9 ? '9+' : badge}</Text>
          </View>
        )}
      </View>
      <Text style={[styles.label, { color }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: ui.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ui.border,
    paddingTop: 6,
  },
  tab: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: 2 },
  label: { fontSize: 11, fontWeight: '600' },
  badge: {
    position: 'absolute',
    top: -4,
    right: -10,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#b3261e',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: ui.card,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 8,
  },
  item: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, paddingHorizontal: 20 },
  itemText: { fontSize: 16, color: ui.text },
});
