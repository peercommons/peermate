// Settings screen (SPECS §2.7).
import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { cleanNick, getBackupPhrase, loadMe, NICK_MAX, setNick, type Me } from '../net/profile';
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
    <ScrollView contentContainerStyle={styles.root} keyboardShouldPersistTaps="handled">
      <ProfileSection />

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

function ProfileSection() {
  const [me, setMe] = useState<Me | null>(null);
  const [draft, setDraft] = useState('');
  const [phrase, setPhrase] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      loadMe()
        .then((m) => {
          setMe(m);
          setDraft(m.profile.nick);
        })
        .catch(() => undefined);
    }, []),
  );

  const valid = cleanNick(draft) !== null;
  const changed = me && cleanNick(draft) !== me.profile.nick;

  const save = () =>
    setNick(draft)
      .then((m) => {
        setMe({ ...m });
        setDraft(m.profile.nick);
      })
      .catch((err) => Alert.alert('Name not saved', (err as Error).message));

  const reveal = () =>
    Alert.alert(
      'Show backup phrase?',
      'These 24 words are your online identity. Anyone who sees them can play as you. Write them down and keep them private.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Show', onPress: () => getBackupPhrase().then(setPhrase).catch(() => undefined) },
      ],
    );

  return (
    <>
      <Text style={styles.section}>Profile</Text>
      <View style={styles.card}>
        <Text style={styles.label}>Name shown to opponents</Text>
        <View style={styles.nickRow}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            maxLength={NICK_MAX}
            style={[styles.input, !valid && styles.inputBad]}
            autoCorrect={false}
            accessibilityLabel="Name shown to opponents"
          />
          <Pressable
            onPress={save}
            disabled={!valid || !changed}
            style={[styles.saveBtn, (!valid || !changed) && { opacity: 0.4 }]}
          >
            <Text style={styles.saveText}>Save</Text>
          </Pressable>
        </View>
        <Text style={styles.hint}>
          Your ID: <Text style={styles.mono}>{me?.fingerprint ?? '…'}</Text>. Opponents see these four words, so
          nobody can pass as you just by copying your name.
        </Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.label}>Backup phrase</Text>
        {phrase ? (
          <>
            <Text style={styles.phrase} selectable={false}>
              {phrase
                .split(' ')
                .map((w, i) => `${i + 1}. ${w}`)
                .join('   ')}
            </Text>
            <Pressable onPress={() => setPhrase(null)}>
              <Text style={styles.linkText}>Hide</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.hint}>
              Restores your online identity on a new phone. Your games and settings stay on this device.
            </Text>
            <Pressable onPress={reveal}>
              <Text style={styles.linkText}>Show backup phrase</Text>
            </Pressable>
          </>
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: ui.card,
    borderRadius: 10,
    padding: 12,
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ui.border,
  },
  nickRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 16,
    color: ui.text,
  },
  inputBad: { borderColor: '#b3261e' },
  saveBtn: { backgroundColor: ui.accent, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16 },
  saveText: { color: ui.accentText, fontWeight: '700' },
  mono: { fontWeight: '700', color: ui.text },
  phrase: { fontSize: 15, lineHeight: 26, color: ui.text },
  linkText: { color: ui.accent, fontWeight: '700', paddingVertical: 4 },
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
