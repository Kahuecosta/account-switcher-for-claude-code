'use strict';
// Per-chat accounts (claudeAccounts.perChatAccounts): a launcher set as the Claude Code extension's
// claudeCode.claudeProcessWrapper. The extension starts every claude process as
// `<wrapper> <claude binary> [arguments]` with the window's environment; the launcher only chooses
// CLAUDE_CONFIG_DIR and then runs claude (or the user's own wrapper) with the same arguments.
// POSIX shells only (macOS, Linux, WSL, remote machines): on Windows the extension cannot start a script.
// The script is shared by every window of the machine, so whatever differs between windows comes from
// the window's environment (the variables below), never from the script itself.
const { shQuote } = require('./statusline');

const SCRIPT_NAME = 'claude-accounts-wrapper.sh';
const ACCOUNTS_LIST = 'accounts.list';
const ROUTE_DIR = 'route';
// A route written by "New chat as account..." is used by the next new chat started within this many
// seconds, and then removed.
const ROUTE_TTL_S = 30;
// In accounts.list and route files: the window's base profile (the Default account).
const BASE = '-';
// Set by the extension in each window. WINDOW_VAR: an id for the window's route file. VARS_VAR: the
// names (never the values) of the variables the window's account sets, so a chat routed to another
// account does not inherit them (an API key, for example). BASE_VAR: the window's base profile folder
// when VS Code was started with CLAUDE_CONFIG_DIR; empty means ~/.claude without the variable.
const WINDOW_VAR = 'CLAUDE_ACCOUNTS_WINDOW';
const VARS_VAR = 'CLAUDE_ACCOUNTS_VARS';
const BASE_VAR = 'CLAUDE_ACCOUNTS_BASE';

/** @param {{ bridgeDir: string, original?: string | null }} o */
function wrapperScript({ bridgeDir, original }) {
  return `#!/bin/sh
# Multi-Account Switcher for Claude Code: per-chat accounts (claudeAccounts.perChatAccounts).
# The Claude Code extension starts every claude process as: <this script> <claude binary> [arguments].
# 1. A resumed conversation uses the account whose copy of it was written last.
# 2. The first new chat after "New chat as account..." (a fresh route file of this window) uses that account.
# 3. Anything else keeps the window's account. Then claude (or your own wrapper) runs unchanged.
bridge=${shQuote(bridgeDir)}
orig=${shQuote(original || '')}

# The folder of an accounts.list entry; empty for the base profile used without CLAUDE_CONFIG_DIR.
dir_of() {
  if [ "$1" = "${BASE}" ]; then printf '%s' "\${${BASE_VAR}:-}"; else printf '%s' "$1"; fi
}

use_dir() {
  want=$(dir_of "$1")
  if [ "$want" != "\${CLAUDE_CONFIG_DIR:-}" ]; then
    # Another account than the window's: drop the variables the window's account sets.
    set -f
    old_ifs=$IFS
    IFS=,
    for v in \${${VARS_VAR}:-}; do
      case "$v" in '' | [0-9]* | *[!A-Za-z0-9_]*) ;; *) unset "$v" ;; esac
    done
    IFS=$old_ifs
    set +f
  fi
  if [ -n "$want" ]; then
    CLAUDE_CONFIG_DIR=$want
    export CLAUDE_CONFIG_DIR
  else
    unset CLAUDE_CONFIG_DIR
  fi
}

best=
bestline=
scan() {
  d=$(dir_of "$1")
  [ -n "$d" ] || d=$HOME/.claude
  for f in "$d"/projects/*/"$id".jsonl; do
    if [ -f "$f" ] && { [ -z "$best" ] || [ "$f" -nt "$best" ]; }; then
      best=$f
      bestline=$1
    fi
  done
}

id=
cont=
prev=
for a in "$@"; do
  case "$a" in
    --resume=*) id=\${a#--resume=} ;;
    --continue | -c) cont=1 ;;
  esac
  { [ "$prev" = "--resume" ] || [ "$prev" = "-r" ]; } && id=$a
  prev=$a
done
case "$id" in *[!0-9a-fA-F-]*) id= ;; esac

if [ -n "$id" ]; then
  scan "\${CLAUDE_CONFIG_DIR:-${BASE}}"
  if [ -f "$bridge/${ACCOUNTS_LIST}" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] && scan "$line"
    done < "$bridge/${ACCOUNTS_LIST}"
  fi
  [ -n "$bestline" ] && use_dir "$bestline"
elif [ -z "$cont" ] && [ -n "\${${WINDOW_VAR}:-}" ]; then
  # (A --continue picks up an earlier conversation: it is not the new chat the route is for.)
  # Taken by moving it: only one new chat uses a route, even when several start at once.
  route="$bridge/${ROUTE_DIR}/\${${WINDOW_VAR}}"
  taken="$route.$$"
  if mv "$route" "$taken" 2>/dev/null; then
    tab=$(printf '\\t')
    IFS=$tab read -r ts dir < "$taken"
    rm -f "$taken"
    case "$ts" in
      '' | *[!0-9]*) ;;
      *) if [ $(($(date +%s) - ts)) -le ${ROUTE_TTL_S} ] && [ -n "$dir" ]; then use_dir "$dir"; fi ;;
    esac
  fi
fi

if [ -n "$orig" ]; then exec "$orig" "$@"; fi
exec "$@"
`;
}

/** @param {string | null} dir account folder, or null for the window's base profile */
const routeLine = (dir, now = Date.now()) => `${Math.floor(now / 1000)}\t${dir || BASE}\n`;

module.exports = {
  SCRIPT_NAME,
  ACCOUNTS_LIST,
  ROUTE_DIR,
  ROUTE_TTL_S,
  BASE,
  WINDOW_VAR,
  VARS_VAR,
  BASE_VAR,
  wrapperScript,
  routeLine,
};
