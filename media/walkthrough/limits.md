# Keep working at the usage limit

Every account's 5-hour and weekly usage appears in the **Claude Accounts** view and the status bar as soon as Claude Code has checked it. Nothing to set up.

- When the current account hits its limit, or crosses `claudeAccounts.quotaThreshold`, the extension offers to **continue the conversation** in the account with the most quota left: the conversation is copied there and opens in a new tab as that account, without reloading the window. `claudeAccounts.onUsageLimit` can make this automatic.
- **Shared history** makes every account see the same conversations in the Claude Code history.
- **Live quota** (optional) updates usage more often while the `claude` CLI runs in a terminal.
