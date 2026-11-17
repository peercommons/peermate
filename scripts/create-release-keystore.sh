#!/usr/bin/env bash
# Creates Peermate's Android release signing key. Run ONCE, then back it up.
#
# Every build you ever ship must be signed with this same key: Android refuses
# to install an update signed with a different one, and losing it means testers
# must uninstall (losing their local data). Keep the file and passwords in a
# password manager. Never commit it.
set -euo pipefail

DIR="${PEERMATE_KEYSTORE_DIR:-$HOME/.peermate}"
FILE="$DIR/peermate-release.jks"
ALIAS="peermate"

if [[ -e "$FILE" ]]; then
  echo "Refusing to overwrite existing keystore: $FILE" >&2
  exit 1
fi

if [[ ! -t 0 ]]; then
  echo "This script asks for passwords, so run it in a normal terminal window (not via a non-interactive shell)." >&2
  exit 1
fi

mkdir -p "$DIR"
chmod 700 "$DIR"

echo "keytool will ask for a keystore password (6+ characters) and your name/organisation."
keytool -genkeypair -v \
  -keystore "$FILE" \
  -alias "$ALIAS" \
  -keyalg RSA -keysize 4096 \
  -validity 10000 || true

# keytool can exit 0 even after giving up on bad input, so check the result.
if [[ ! -s "$FILE" ]]; then
  echo "No keystore was created. Run the script again." >&2
  exit 1
fi

chmod 600 "$FILE"

cat <<MSG

Created $FILE (alias: $ALIAS)

Next:
  1. Back up $FILE and its password now (password manager or offline copy).
  2. cp fastlane/.env.example fastlane/.env and fill in the passwords.
MSG
