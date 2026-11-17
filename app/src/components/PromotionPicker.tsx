import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Color, PieceSymbol } from '@peermate/core';
import { ui } from '../theme';

const CHOICES: { piece: PieceSymbol; glyph: string; name: string }[] = [
  { piece: 'q', glyph: '♛︎', name: 'Queen' },
  { piece: 'r', glyph: '♜︎', name: 'Rook' },
  { piece: 'b', glyph: '♝︎', name: 'Bishop' },
  { piece: 'n', glyph: '♞︎', name: 'Knight' },
];

export function PromotionPicker({
  color,
  onChoose,
}: {
  color: Color | null;
  onChoose: (piece: PieceSymbol | null) => void;
}) {
  return (
    <Modal transparent visible={color !== null} animationType="fade" onRequestClose={() => onChoose(null)}>
      <Pressable style={styles.backdrop} onPress={() => onChoose(null)}>
        <View style={styles.card}>
          <Text style={styles.title}>Promote to</Text>
          <View style={styles.row}>
            {CHOICES.map((c) => (
              <Pressable
                key={c.piece}
                onPress={() => onChoose(c.piece)}
                style={({ pressed }) => [styles.choice, pressed && { opacity: 0.6 }]}
                accessibilityLabel={c.name}
              >
                <Text style={[styles.glyph, color === 'w' ? styles.white : styles.black]}>{c.glyph}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' },
  card: { backgroundColor: ui.card, borderRadius: 12, padding: 16, gap: 12 },
  title: { fontSize: 16, fontWeight: '600', textAlign: 'center', color: ui.text },
  row: { flexDirection: 'row', gap: 8 },
  choice: { width: 64, height: 64, borderRadius: 8, backgroundColor: '#EBD9B4', alignItems: 'center', justifyContent: 'center' },
  glyph: { fontSize: 48, lineHeight: 60 },
  white: { color: '#fbfbf8', textShadowColor: '#222', textShadowRadius: 2 },
  black: { color: '#1b1b1b' },
});
