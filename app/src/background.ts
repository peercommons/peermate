// Background check for friends' messages (SPECS §8.4): Android WorkManager
// (every ~15 min) / iOS BGTaskScheduler (when iOS chooses). Fetches new private
// messages (and challenges sent as messages) from the relays, stores them, and
// posts local notifications.
//
// Defined at module scope from the app entry (index.ts), so it exists when the
// OS starts the app in the background with no UI.
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { isBlocked } from './net/blocklist';
import { friendByNpub, friends } from './net/friends';
import { addMessage, isUnread, MESSAGE_MAX, syncedTo } from './net/messages';
import { addIncoming, parseChallenge } from './net/challenges';
import { notifyChallenge, notifyMessage } from './net/notify';
import { loadMe } from './net/profile';
import { fetchDMsOnce } from './net/relay';

export const MESSAGES_TASK = 'peermate-messages';

/** Fetches and stores new messages from friends; notifies unread ones. Returns how many were new. */
export async function checkMessages(maxWaitMs = 15_000): Promise<number> {
  if (friends().length === 0) return 0;
  const me = await loadMe();
  const since = syncedTo() || Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
  const dms = await fetchDMsOnce(me.identity.nostr.secretKey, since, maxWaitMs);
  let added = 0;
  for (const dm of dms) {
    const f = friendByNpub(dm.from);
    if (!f || isBlocked(f.key)) continue;
    const text = dm.text.slice(0, MESSAGE_MAX);
    if (!addMessage(f.key, { id: dm.id, from: 'them', text, at: dm.at })) continue;
    added++;
    const tc = parseChallenge(text);
    if (tc) {
      // Stored for the app to show when it opens; expired or older ones are skipped.
      if (addIncoming(f.key, tc, dm.at)) notifyChallenge(f.key, f.nick, tc);
    } else if (isUnread(f.key, dm.at)) {
      notifyMessage(f.key, f.nick, text);
    }
  }
  return added;
}

TaskManager.defineTask(MESSAGES_TASK, async () => {
  try {
    await checkMessages();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/** Schedules the background check (idempotent). 15 min is the shortest either OS allows. */
export async function registerBackgroundCheck(): Promise<void> {
  try {
    if ((await BackgroundTask.getStatusAsync()) !== BackgroundTask.BackgroundTaskStatus.Available) return;
    if (!(await TaskManager.isTaskRegisteredAsync(MESSAGES_TASK))) {
      await BackgroundTask.registerTaskAsync(MESSAGES_TASK, { minimumInterval: 15 });
    }
  } catch {
    // background work unavailable (e.g. disabled by the user): the app still fetches when opened
  }
}
