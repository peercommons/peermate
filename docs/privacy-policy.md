---
title: Peermate privacy policy
---

# Peermate privacy policy

_Last updated: {{LAST_UPDATED}}_

Peermate is a chess app. You can play the computer or a friend on the same phone, or play people online. Online games run directly between phones, with no Peermate server.

**The short version:** we (the developer, {{DEVELOPER_NAME}}) don't collect anything. Peermate has no accounts, analytics, ads or trackers, and no server of ours that your data passes through. Everything stays on your phone, except what has to travel to other players, described below.

## What stays on your phone

- Your games, game history and analysis
- Your settings
- Your online ID: a pair of cryptographic keys made on your phone the first time you play online. Your backup phrase can restore it.
- Your nickname, friends, block list, ratings and messages with friends

None of this is sent to us. Uninstalling Peermate deletes it, unless your phone's own backup keeps a copy.

## What other players and networks can see

To play online without a server, Peermate uses two public networks run by other people:

**1. Direct connections (Hyperswarm).** When possible, your phone connects straight to your opponent's phone. The opponent, and the computers that help phones find each other (the HyperDHT network), can see your **IP address**. An IP address can reveal your approximate location and your internet provider. Game messages on a direct connection are encrypted.

**2. Nostr relays.** When a direct connection isn't possible, and for messages and challenges to friends, Peermate passes messages through public Nostr relays. These are independent servers. Peermate uses a small list of them, which can change between app versions. Relays see your **IP address**, your Nostr public key (part of your online ID), and the following:

| What | Who can read it |
|---|---|
| Looking for a game (Quick Match): your nickname, online ID and time control | **Anyone**, for about a minute |
| Game moves, chat and online status (sent to friends only) | Only you and the other player. The content is encrypted; relays see only that you sent something, to whom, and when |
| Messages and challenges to friends | Only you and your friend. They're encrypted and hidden even from the relays (NIP-17); relays keep them for a while so your friend gets them later |
| Your block list | Only you. It's encrypted, stored on relays so it follows your ID to a new phone |
| Your games, **only if you turn on "Publish my rated games"** | **Anyone, permanently**: both players' online IDs and nicknames, the moves, the result and the date. This lets opponents check that your rating is real. It's off until you agree, and you can turn it off in Settings. Games already published can't be fully removed, because relays are run by others |

Relays are run by third parties with their own policies. We don't control them and can't delete data from them.

## Your nickname

Your nickname is shown to the players you meet. Don't use your real name if you'd rather stay anonymous.

## Reports

When you report a player, Peermate prepares a report (their nickname and ID, the moves and the chat) and opens your phone's share sheet. Nothing is sent unless you send it yourself, for example by email to us.

## Notifications

Notifications about friends' messages and challenges are created on your phone by Peermate itself, when it checks the relays in the background. No push-notification server is involved.

## Children

Peermate isn't directed at children under 13, and we don't knowingly collect information from anyone, including children.

## Changes

If this policy changes, the new version will be posted here with a new date.

## Contact

Questions: {{SUPPORT_EMAIL}}
