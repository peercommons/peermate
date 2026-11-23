// Names other players send us (HELLO, seeks, friend links) are shown in lists,
// game screens and notifications. Keep only what a name may hold in the app
// itself (letters, digits, spaces, dots, dashes, underscores, as the
// Settings screen enforces): no line breaks, invisible or text-direction
// characters, emoji or symbols that could fake a notice.
export const NICK_MAX = 20;

export function displayNick(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const n = raw
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} ._-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NICK_MAX)
    .trim();
  return n.length >= 2 ? n : fallback;
}
