# Pick an account per repository

- **Repository default**: applies whenever you open this repository, including other clones of it (it is keyed by the git remote).
- **Rules**: for example every repository under `~/work/**`, or every repository of `github.com/my-company/*`.

```json
"claudeAccounts.rules": [
  { "pattern": "github.com/my-company/*", "account": "work" },
  { "pattern": "~/personal/**", "account": "me@example.com" }
]
```
