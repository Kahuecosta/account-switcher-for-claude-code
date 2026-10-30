# Add an account

Each account is a folder under `~/.claude-accounts/` that Claude Code uses as `CLAUDE_CONFIG_DIR`.

- **Shared profile**: reuses the settings, `CLAUDE.md`, agents, commands, skills, plugins and MCP servers of `~/.claude`, and keeps only its own login.
- **Isolated profile**: everything separate.

Accounts can sign in with a Claude subscription, a subscription token, an API key, Amazon Bedrock or Google Vertex AI.

Your original `~/.claude` is the **Default** account. It is never deleted or overwritten.
