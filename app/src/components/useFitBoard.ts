// Board size for a screen with the board above a moves panel (flex: 1).
//
// The board is as wide as the screen allows (up to 560), but on a short window
// (an iPhone app on a Mac, a small phone, split screen) that left the moves panel
// squeezed to nothing. The panel reports its height; while it is below minPanel
// the board gives up the difference. It only shrinks (a notice or judgment line
// coming and going doesn't make the board jump), and starts over when the
// window changes size.
import { useCallback, useEffect, useState } from 'react';
import { useWindowDimensions, type LayoutChangeEvent } from 'react-native';

const MIN_BOARD = 200;

export function useFitBoard(minPanel = 96) {
  const { width, height } = useWindowDimensions();
  const full = Math.min(width - 16, 560);
  const [shrink, setShrink] = useState(0);
  useEffect(() => setShrink(0), [width, height]);
  const onPanelLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const short = Math.round(minPanel - e.nativeEvent.layout.height);
      if (short < 2) return;
      setShrink((s) => Math.min(Math.max(0, full - MIN_BOARD), s + short));
    },
    [full, minPanel],
  );
  return { boardSize: Math.max(Math.min(full, MIN_BOARD), full - shrink), onPanelLayout };
}
