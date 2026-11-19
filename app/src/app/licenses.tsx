// Open-source licences (SPECS §14.3). The list comes from tools/gen-notices.mjs.
import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { ui } from '../theme';

type Notices = { packages: { n: string; v: string; l: string; t: number }[]; texts: string[] };

export default function LicensesScreen() {
  // Loaded when the screen opens, not at app start (it's ~400 KB).
  const notices = useMemo(() => require('../licenses.json') as Notices, []);
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const items = q ? notices.packages.filter((p) => p.n.toLowerCase().includes(q)) : notices.packages;

  return (
    <FlatList
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.root}
      data={items}
      keyExtractor={(p) => `${p.n}@${p.v}`}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <View style={styles.header}>
          <Text style={styles.subtle}>
            Peermate is built with {notices.packages.length} open-source components, including the Arasan chess engine.
            Tap one to read its licence.
          </Text>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search"
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
            accessibilityLabel="Search components"
          />
        </View>
      }
      renderItem={({ item: p }) => {
        const key = `${p.n}@${p.v}`;
        const expanded = open === key;
        return (
          <Pressable
            onPress={() => setOpen(expanded ? null : key)}
            style={styles.item}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel={`${p.n} ${p.v}, ${p.l} licence`}
          >
            <Text style={styles.name}>
              {p.n} <Text style={styles.subtle}>{p.v}</Text>
            </Text>
            <Text style={styles.subtle}>{p.l}</Text>
            {expanded && (
              <Text style={styles.text} selectable>
                {notices.texts[p.t]}
              </Text>
            )}
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  root: { padding: 16, gap: 8 },
  header: { gap: 10, marginBottom: 4 },
  subtle: { color: ui.subtle, fontWeight: '400' },
  input: {
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: ui.text,
    backgroundColor: ui.card,
  },
  item: {
    backgroundColor: ui.card,
    borderRadius: 10,
    padding: 12,
    gap: 2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ui.border,
  },
  name: { fontWeight: '700', color: ui.text },
  text: { marginTop: 8, fontSize: 11, color: ui.text, fontFamily: 'monospace' },
});
