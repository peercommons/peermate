// Root container for screens that don't scroll as a whole (board screens).
//
// On iOS 26+ the native stack lays every screen out under the navigation bar,
// even an opaque one, so content must be pushed down by the header's height
// (status bar included). Scrolling screens get this from
// `contentInsetAdjustmentBehavior="automatic"`; these get it here. Elsewhere the
// screen already starts below the header.
import type { ReactNode } from 'react';
import { Platform, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { usePathname } from 'expo-router';
import { footerShown } from './Footer';

const UNDER_HEADER = Platform.OS === 'ios' && parseInt(String(Platform.Version), 10) >= 26;

export function ScreenView({ style, children }: { style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const headerHeight = useHeaderHeight();
  const flat = StyleSheet.flatten(style) ?? {};
  const ownTop = Number(flat.paddingTop ?? flat.paddingVertical ?? flat.padding ?? 0) || 0;
  // The footer already keeps clear of the home indicator / navigation bar.
  const bottom = !footerShown(usePathname());
  return (
    <SafeAreaView
      style={[style, UNDER_HEADER && { paddingTop: headerHeight + ownTop }]}
      edges={bottom ? ['bottom', 'left', 'right'] : ['left', 'right']}
    >
      {children}
    </SafeAreaView>
  );
}
