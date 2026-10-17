# Guia de publicação

## 1. Preencher os placeholders

| Placeholder | Onde | O que colocar |
| --- | --- | --- |
| `YOUR_PUBLISHER_ID` | `package.json` | Já preenchido: `kahuecosta` (precisa ser o mesmo ID do publisher criado no passo 3) |
| `YOUR NAME` | `package.json`, `LICENSE` | Já preenchido: `Kahuê Costa` |
| `YOUR_GITHUB_USER` | `package.json` | Já preenchido: `Kahuecosta` |

O ID final da extensão será `<publisher>.account-switcher-for-claude-code`.

## 2. Criar o repositório no GitHub

```bash
git init && git add . && git commit -m "Initial release"
git branch -M main
git remote add origin https://github.com/Kahuecosta/account-switcher-for-claude-code.git
git push -u origin main
```

O workflow **CI** roda checagens e testes em Linux, macOS e Windows, e gera um `.vsix` como artefato. Os testes em Windows e macOS validam os links reais (junções e symlinks), que eu não consegui testar aqui.

## 3. VS Code Marketplace

1. Entre em https://marketplace.visualstudio.com/manage com uma conta Microsoft e crie o publisher com o mesmo ID do `package.json`.
2. Gere um token de publicação (Personal Access Token do Azure DevOps com o escopo **Marketplace → Manage**).
3. O processo de token da Microsoft muda de tempos em tempos. Confira o passo a passo atual em https://code.visualstudio.com/api/working-with-extensions/publishing-extension

## 4. Open VSX (Cursor, VSCodium, Windsurf…)

1. Entre em https://open-vsx.org com o GitHub, aceite o Publisher Agreement da Eclipse Foundation e gere um Access Token no seu perfil.
2. Crie o namespace uma única vez: `npx ovsx create-namespace kahuecosta -p <token>`.

## 5. Segredos no GitHub

Em **Settings → Secrets and variables → Actions**, crie:

- `VSCE_PAT`: o token do Marketplace.
- `OVSX_PAT`: o token do Open VSX.

## 6. Testar antes de publicar

```bash
npm run check   # sintaxe + traduções
npm test        # testes
npm run package # gera o .vsix
```

Instale o `.vsix` com **Extensions: Install from VSIX…** e teste o fluxo completo: criar conta, login, trocar, `/status`, padrão por repositório e histórico. Teste também com o VS Code em português e em inglês (**Configure Display Language**).

## 7. Publicar

```bash
# atualize "version" no package.json e o CHANGELOG.md
git commit -am "Release 1.0.0"
git tag v1.0.0
git push && git push --tags
```

O workflow **Release** confere se a tag bate com a versão, roda os testes, publica nos dois marketplaces e cria uma release no GitHub com o `.vsix`.

## Migrar da versão que você usava localmente

A versão local tinha outro ID (`local.claude-accounts`), então as duas não compartilham dados internos. Desinstale a antiga. Na primeira execução, a nova encontra as pastas em `~/.claude-accounts` e oferece importá-las. Depois, renomeie as contas e redefina os padrões por repositório. As pastas e os logins continuam intactos.

## Sobre o nome

O nome descritivo "… for Claude Code" e o aviso de que a extensão não é afiliada à Anthropic reduzem o risco de confusão com um produto oficial. Antes de publicar, vale conferir as diretrizes de marca da Anthropic e a política de nomes do Marketplace.
