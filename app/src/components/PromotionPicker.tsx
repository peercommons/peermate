import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { PieceIcon } from './Board';
import type { Color, PieceSymbol } from '@peermate/core';
import { ui } from '../theme';

const CHOICES: { piece: PieceSymbol; name: string }[] = [
  { piece: 'q', name: 'Queen' },
  { piece: 'r', name: 'Rook' },
  { piece: 'b', name: 'Bishop' },
  { piece: 'n', name: 'Knight' },
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
                {color && <PieceIcon type={c.piece} color={color} size={56} />}
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
});
