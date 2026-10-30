# Keep working at the usage limit

When the current account hits its usage limit, the extension offers the account with the most quota left, or switches on its own (`claudeAccounts.onUsageLimit`).

- **Live quota** shows the 5-hour and weekly usage of each account and can switch before the limit (`claudeAccounts.quotaThreshold`).
- **Shared history** lets the other account continue the same conversation (`claude --continue`).
