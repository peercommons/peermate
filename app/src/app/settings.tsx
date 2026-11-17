// Settings screen (SPECS §2.7).
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSettings, type BoardThemeName, type Settings } from '../settings';
import { BOARD_THEMES, ui } from '../theme';

const TOGGLES: { key: keyof Settings; label: string; hint: string }[] = [
  { key: 'showLegalMoves', label: 'Show legal moves', hint: 'Dots on the squares the selected piece can move to' },
  { key: 'showCoordinates', label: 'Show coordinates', hint: 'Files and ranks along the board edge' },
  { key: 'autoFlip', label: 'Auto-flip in pass & play', hint: 'Turn the board to the player whose move it is' },
  { key: 'haptics', label: 'Vibrate on moves', hint: 'A light tap per move, a firmer one for captures and checks' },
];

export default function SettingsScreen() {
  const { settings, update } = useSettings();

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <Text style={styles.section}>Board theme</Text>
      <View style={styles.themes}>
        {(Object.keys(BOARD_THEMES) as BoardThemeName[]).map((name) => {
          const t = BOARD_THEMES[name];
          const selected = settings.boardTheme === name;
          return (
            <Pressable
              key={name}
              onPress={() => update({ boardTheme: name })}
              style={[styles.theme, selected && styles.themeSelected]}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={`${t.label} board`}
            >
              <View style={styles.swatch}>
                {[0, 1, 2, 3].map((i) => (
                  <View key={i} style={{ width: 22, height: 22, backgroundColor: i === 0 || i === 3 ? t.light : t.dark }} />
                ))}
              </View>
              <Text style={styles.themeLabel}>{t.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.section}>Play</Text>
      {TOGGLES.map((t) => (
        <View key={t.key} style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>{t.label}</Text>
            <Text style={styles.hint}>{t.hint}</Text>
          </View>
          <Switch
            value={settings[t.key] as boolean}
            onValueChange={(v) => update({ [t.key]: v } as Partial<Settings>)}
            trackColor={{ true: ui.accent }}
            accessibilityLabel={t.label}
          />
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { padding: 16, gap: 10 },
  section: { fontSize: 13, fontWeight: '700', color: ui.subtle, textTransform: 'uppercase', marginTop: 8 },
  themes: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  theme: { alignItems: 'center', padding: 8, borderRadius: 10, borderWidth: 2, borderColor: 'transparent', gap: 4 },
  themeSelected: { borderColor: ui.accent },
  swatch: { width: 44, height: 44, flexDirection: 'row', flexWrap: 'wrap', borderRadius: 4, overflow: 'hidden' },
  themeLabel: { fontSize: 12, color: ui.text },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: ui.card,
    borderRadius: 10,
    padding: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ui.border,
  },
  label: { fontSize: 15, fontWeight: '600', color: ui.text },
  hint: { fontSize: 12, color: ui.subtle },
});
