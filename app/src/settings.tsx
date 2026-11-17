// User settings (SPECS §2.7), persisted on device with expo-sqlite's key-value store.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import Storage from 'expo-sqlite/kv-store';

export type BoardThemeName = 'wood' | 'green' | 'blue' | 'contrast';

export type Settings = {
  boardTheme: BoardThemeName;
  showLegalMoves: boolean;
  showCoordinates: boolean;
  /** Pass & play: turn the board to the side to move. */
  autoFlip: boolean;
  haptics: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  boardTheme: 'wood',
  showLegalMoves: true,
  showCoordinates: true,
  autoFlip: true,
  haptics: true,
};

const KEY = 'settings.v1';

function load(): Settings {
  try {
    const raw = Storage.getItemSync(KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

type Ctx = { settings: Settings; update: (patch: Partial<Settings>) => void };
const SettingsContext = createContext<Ctx | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(load);
  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      Storage.setItem(KEY, JSON.stringify(next)).catch(() => undefined);
      return next;
    });
  }, []);
  const value = useMemo(() => ({ settings, update }), [settings, update]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): Ctx {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used inside SettingsProvider');
  return ctx;
}
