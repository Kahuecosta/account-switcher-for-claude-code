# Multi-Account Switcher for Claude Code

[![VS Code Marketplace](https://vsmarketplacebadges.dev/version-short/kahuecosta.claude-code-multi-account.svg?label=marketplace)](https://marketplace.visualstudio.com/items?itemName=kahuecosta.claude-code-multi-account)
[![Instalações](https://vsmarketplacebadges.dev/installs-short/kahuecosta.claude-code-multi-account.svg)](https://marketplace.visualstudio.com/items?itemName=kahuecosta.claude-code-multi-account)
[![Open VSX](https://img.shields.io/open-vsx/v/kahuecosta/claude-code-multi-account?label=open%20vsx)](https://open-vsx.org/extension/kahuecosta/claude-code-multi-account)
[![CI](https://github.com/Kahuecosta/account-switcher-for-claude-code/actions/workflows/ci.yml/badge.svg)](https://github.com/Kahuecosta/account-switcher-for-claude-code/actions/workflows/ci.yml)
[![Licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-blue.svg)](LICENSE)

Use várias contas do Claude Code no VS Code ao mesmo tempo: uma conta diferente **por janela ou por repositório**, o **plano e os limites de uso** de cada conta à vista, e a **troca para outra conta com um clique** quando uma atinge o limite. A sua pasta `~/.claude` nunca é modificada.

![Troca pela barra de status: o seletor mostra e-mail, plano e cota de cada conta, e a janela recarrega para usar a nova conta](images/demo.gif)

> **Sem afiliação com a Anthropic.** Esta é uma extensão da comunidade. "Claude" e "Claude Code" são marcas registradas da Anthropic, PBC.

[English](README.md)

## Recursos

**Troca de conta**

- **Conta por janela**: cada janela do VS Code pode usar uma conta diferente ao mesmo tempo.
- **Padrão por repositório**: ao abrir um repositório, a conta dele é aplicada antes de o Claude Code iniciar. Clones do mesmo repositório compartilham o padrão, porque ele é identificado pelo remote do git.
- **Regras**: todos os repositórios em `~/trabalho/**`, ou todos de `github.com/minha-empresa/*`, usam uma conta.
- **Alternância rápida** entre as duas últimas contas com `Ctrl+Alt+Shift+A` (`Cmd+Alt+Shift+A` no macOS), pela barra de status ou pela view **Contas do Claude** no Explorer.
- **Terminais**: o `claude` da CLI nos terminais integrados usa a mesma conta do painel, e **Abrir terminal com a conta** roda a CLI com qualquer outra conta sem trocar a janela.

**Saber em qual conta você está**

- Cada conta mostra **e-mail, plano** (ex.: Pro, Max 20x) e **organização**, além de **cor e ícone ou emoji** próprios na barra de status e uma imagem opcional no seletor.
- A barra de status mostra quando o painel do Claude Code ainda usa a conta anterior até a janela ser recarregada.
- **Diagnosticar** gera um relatório de qual conta cada parte do VS Code usa e roda `claude auth status` em todas as contas.

**Limites de uso**

- Quando a conta atual atinge o limite de uso, a extensão oferece a conta com **mais cota sobrando**, ou troca sozinha (`claudeAccounts.onUsageLimit`), e avisa quando o limite reinicia.
- **Cota ao vivo** (opcional) mostra o **uso de 5 horas e semanal** de cada conta, lido dos dados da própria linha de status do Claude Code, e pode trocar **antes** de o limite ser atingido.
- Com o histórico compartilhado, **continue a mesma conversa** na outra conta (`claude --continue`).
- **Uso por conta**: tokens usados hoje e nos últimos 7 dias, a partir dos logs locais do Claude Code.

**Perfis e histórico**

- **Perfil compartilhado**: reaproveita settings, `CLAUDE.md`, agents, commands, skills, rules, plugins e servidores MCP de escopo de usuário do `~/.claude`, e mantém só o próprio login. **Perfil isolado**: tudo separado.
- **Histórico compartilhado opcional**: todas as contas veem as mesmas conversas. Ao ligar, o histórico que cada conta já tem é mesclado; toda alteração é registrada e desfeita se algo falhar.

**Tipos de conta**

- Assinatura do Claude (login no claude.ai), token de longa duração da assinatura (`claude setup-token`), chave de API da Anthropic, Amazon Bedrock e Google Vertex AI. Chaves e tokens ficam no armazenamento seguro do VS Code.

**Seguro por padrão**

- O seu `~/.claude` original é a conta **Padrão** e nunca é apagado nem sobrescrito. Dados de login nunca são ligados entre contas, independentemente das configurações.
- Sem telemetria. Sem acesso à rede, exceto o Gravatar, se você ligar.
- O Settings Sync leva nomes, cores, ícones e padrões por repositório para as suas outras máquinas; pastas, logins e variáveis de ambiente ficam locais.

## Capturas de tela

| Seletor de contas | View no Explorer e barra de status | Limite de uso atingido |
| --- | --- | --- |
| [![Seletor com e-mail, plano e cota de 5 horas e semanal de cada conta](images/screenshots/account-picker.png)](images/screenshots/account-picker.png) | [![View Contas do Claude no Explorer e a conta atual na barra de status](images/screenshots/accounts-view.png)](images/screenshots/accounts-view.png) | [![Notificação oferecendo a conta com mais cota sobrando quando a atual atinge o limite](images/screenshots/usage-limit.png)](images/screenshots/usage-limit.png) |

_Dados de demonstração. Gere de novo com `npm run screenshots`._

## Instalação

- **VS Code**: instale o [Multi-Account Switcher for Claude Code](https://marketplace.visualstudio.com/items?itemName=kahuecosta.claude-code-multi-account) pelo Marketplace.
- **Cursor, VSCodium, Windsurf** e outros editores que usam o Open VSX: instale pelo [Open VSX](https://open-vsx.org/extension/kahuecosta/claude-code-multi-account).
- **Manualmente**: baixe o `.vsix` em [GitHub Releases](https://github.com/Kahuecosta/account-switcher-for-claude-code/releases) e rode **Extensions: Install from VSIX…**. Cada release tem um `SHA256SUMS.txt` e um atestado de procedência do build, que você confere com `gh attestation verify <arquivo>.vsix --repo Kahuecosta/account-switcher-for-claude-code`.

Requer VS Code 1.85 ou posterior. Funciona com a [extensão oficial do Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) e também só com a CLI `claude`.

## Como usar

1. Clique em **Claude: padrão** na barra de status e escolha **Adicionar conta…** (ou siga o walkthrough **Comece a usar várias contas do Claude Code**).
2. Dê um nome, escolha como ela faz login e selecione **Perfil compartilhado** ou **Perfil isolado**.
3. Escolha **Fazer login**. Um terminal abre só com o ambiente daquela conta e roda `claude auth login`.
4. Troque de conta pela barra de status quando quiser. A janela é recarregada para o painel do Claude Code usar a nova conta.
5. Opcional: **Definir conta padrão deste repositório…** ou **Adicionar regra de conta padrão…**.

Rode `/status` no Claude Code, ou **Contas do Claude: Diagnosticar**, para confirmar qual conta está ativa.

## Como funciona

O Claude Code lê a pasta de configuração da variável de ambiente `CLAUDE_CONFIG_DIR`. Cada conta é uma pasta em `~/.claude-accounts/` por padrão. Quando uma janela inicia, a extensão define `CLAUDE_CONFIG_DIR` (e as variáveis próprias da conta) no extension host daquela janela, de forma síncrona, antes de a extensão do Claude Code iniciar a CLI. Os terminais integrados recebem as mesmas variáveis pela API de variáveis de ambiente do VS Code; terminais abertos para outra conta recebem um ambiente completo próprio.

A extensão do Claude Code lê a conta quando a janela carrega e não tem comando para reiniciar a sessão, então a troca exige recarregar a janela. Até lá, a barra de status mostra um ícone de sincronização.

Os itens compartilhados são links simbólicos. No Windows, pastas usam junções, que não exigem privilégio de administrador, e arquivos usam symlink ou, como alternativa, hard link. O repositório é identificado lendo a pasta `.git` diretamente; nenhum processo `git` é executado, o que é seguro em pastas não confiáveis.

## Limites de uso e cota ao vivo

A extensão acompanha os logs de sessão desta janela (na pasta `projects/` da conta). Quando o Claude Code informa um limite de uso, ela registra isso para todas as janelas, oferece a melhor outra conta (logada, sem limite, com menos uso) e avisa quando o limite reinicia.

A **cota ao vivo** é opcional (**Contas do Claude: Ligar ou desligar a cota ao vivo**). O Claude Code informa os `rate_limits` das assinaturas Pro e Max à sua [linha de status](https://code.claude.com/docs/en/statusline). A extensão envolve o comando `statusLine` do `settings.json` com um pequeno script (em `~/.claude-accounts/.bridge/`) que salva essa entrada na pasta da conta e depois roda a sua própria linha de status, sem mudanças. Desligar restaura a sua linha de status. A cota aparece depois que a CLI `claude` mostra a linha de status, por exemplo num terminal. Com `claudeAccounts.quotaThreshold` (95% por padrão), a extensão considera a conta no limite antes de o Claude Code começar a recusar pedidos.

## Regras

As regras são verificadas em ordem quando o repositório não tem um padrão próprio:

```json
"claudeAccounts.rules": [
  { "pattern": "github.com/minha-empresa/*", "account": "trabalho" },
  { "pattern": "~/pessoal/**", "account": "eu@exemplo.com" }
]
```

Um padrão que começa com `~`, `/` ou letra de unidade é comparado com o caminho da pasta. Qualquer outro é comparado com o remote do git. `*` vale para um nível e `**` para qualquer profundidade. Um padrão sem curingas também vale para tudo abaixo dele. `account` aceita o id da conta (nome da pasta), o nome ou o e-mail.

Numa janela com várias pastas, vence a primeira pasta que tiver padrão de repositório e, depois, a primeira que corresponder a uma regra; o tooltip lista as pastas que preferem outra conta.

## Automação

Associe um atalho a uma conta específica:

```json
{ "key": "ctrl+alt+1", "command": "claudeAccounts.switch", "args": "trabalho" }
```

Todo comando por conta (`switch`, `login`, `openTerminal`, `rename`, `remove`…) aceita como argumento o id, o nome ou o e-mail da conta. Links no formato `vscode://kahuecosta.claude-code-multi-account/switch?account=trabalho` (também `openTerminal`, `diagnose`, `add`) sempre pedem confirmação.

Outras extensões podem usar a API:

```js
const api = vscode.extensions.getExtension('kahuecosta.claude-code-multi-account')?.exports;
api?.getCurrentAccount(); // { id, name, email, plan, organization, configDir, mode, kind, isDefault }
api?.onDidChangeAccount((conta) => console.log(conta.name));
await api?.switchAccount('trabalho');
```

## Desenvolvimento remoto

A extensão roda onde o Claude Code roda: na máquina remota, no Remote-SSH, WSL, Dev Containers e Codespaces. Contas, logins e `~/.claude-accounts` ficam nessa máquina, então adicione as contas e faça login uma vez em cada máquina remota. O Settings Sync continua levando nomes, cores e padrões por repositório.

## Configurações

<!-- settings:start -->
| Configuração | Padrão | Descrição |
| --- | --- | --- |
| `claudeAccounts.scope` | `"workspace"` | Onde a conta selecionada fica guardada. `workspace`: Cada janela/repositório lembra a própria conta (armazenamento da extensão; nada é gravado no repositório). `user`: Uma única conta para todas as janelas (cada janela passa a usá-la ao recarregar). |
| `claudeAccounts.reloadBehavior` | `"ask"` | O que fazer depois de trocar de conta. A extensão do Claude Code só lê a conta quando a janela carrega. `ask`: Perguntar se deve recarregar a janela. `always`: Recarregar a janela na hora. `never`: Não recarregar; a barra de status mostra que há um recarregamento pendente. |
| `claudeAccounts.autoApplyRepoDefault` | `true` | Ao abrir um repositório, aplicar automaticamente a conta padrão definida para ele ou encontrada por uma regra. |
| `claudeAccounts.rules` | `[]` | Regras de conta padrão, verificadas em ordem quando o repositório não tem um padrão próprio. Um padrão que começa com `~`, `/` ou letra de unidade é comparado com o caminho da pasta (ex.: `~/trabalho/**`); qualquer outro é comparado com o remote do git (ex.: `github.com/minha-empresa/*`). Sem curingas, o padrão também vale para tudo abaixo dele. `account` é o id, o nome ou o e-mail da conta. Adicionar uma regra |
| `claudeAccounts.statusBarStyle` | `"name"` | Como a conta atual aparece na barra de status. `name`: Ícone e nome completo, ex.: Claude: Trabalho. `initials`: Ícone e iniciais, ex.: TR. `icon`: Só o ícone (mais compacto). |
| `claudeAccounts.showPlan` | `true` | Mostrar o plano da conta (ex.: Pro, Max 20x) na barra de status e no seletor de contas, quando o Claude Code informa. |
| `claudeAccounts.showQuota` | `true` | Mostrar na barra de status o uso da janela de limite atual, quando a cota ao vivo está ligada. |
| `claudeAccounts.onUsageLimit` | `"suggest"` | O que fazer quando a conta atual atinge o limite de uso nesta janela. `suggest`: Oferecer a troca para a conta com mais cota sobrando. `switch`: Trocar automaticamente para a conta com mais cota sobrando. `ignore`: Não fazer nada. |
| `claudeAccounts.liveQuota` | `false` | Ler o uso de 5 horas e semanal de cada conta a partir da entrada da linha de status do Claude Code. A extensão envolve o comando `statusLine` do `settings.json` com um script que salva essa entrada e depois roda a sua própria linha de status, sem mudanças; desligar restaura o original. Use Ligar ou desligar a cota ao vivo. |
| `claudeAccounts.quotaThreshold` | `95` | Com a cota ao vivo ligada, considerar que a conta chegou ao limite quando o uso de 5 horas ou semanal atingir esta porcentagem, para trocar antes de o Claude Code recusar pedidos. `0` desliga. |
| `claudeAccounts.shareHistory` | `false` | Todas as contas usam o mesmo histórico de conversas do `~/.claude`. Use Compartilhar histórico entre contas para ligar ou desligar: o histórico existente é mesclado, não descartado. |
| `claudeAccounts.historyItems` | `projects`, `history.jsonl`, `file-history`, `todos`, `plans` | Itens tratados como histórico: conversas por pasta (projects), histórico de prompts (history.jsonl), checkpoints (file-history), todos e planos. |
| `claudeAccounts.sharedItemsMode` | `"list"` | Quais itens do ~/.claude as contas de perfil compartilhado usam por meio de links. `list`: Só os itens de claudeAccounts.sharedItems. `allExcept`: Todos os itens do ~/.claude, exceto dados de login, histórico, estado de sessão e claudeAccounts.sharedItemsExclude. Pastas novas de configuração passam a ser compartilhadas sem mudar as configurações. |
| `claudeAccounts.sharedItems` | `settings.json`, `CLAUDE.md`, `agents`, `commands`, `skills`, `hooks`, `output-styles`, `plugins`, `rules`, `workflows`, `keybindings.json`, `themes` | Itens do `~/.claude` que as contas de perfil compartilhado usam por meio de links. Dados de login (`.credentials.json`, `.claude.json`) e estado de sessão nunca são compartilhados, independentemente desta lista. |
| `claudeAccounts.sharedItemsExclude` | `[]` | Itens que nunca são compartilhados no modo `allExcept` de `claudeAccounts.sharedItemsMode`. |
| `claudeAccounts.shareMcpServers` | `true` | Copiar os servidores MCP de escopo de usuário (do `.claude.json` da conta Padrão) para as contas de perfil compartilhado. Os servidores que a própria conta define são mantidos. Adicione servidores novos na conta Padrão. |
| `claudeAccounts.applyToTerminal` | `true` | Aplicar a conta também nos terminais integrados desta janela, para o CLI claude usar a mesma conta. |
| `claudeAccounts.loginCommand` | `"claude auth login"` | Comando executado no terminal para fazer login em uma conta. |
| `claudeAccounts.accountsRoot` | — | Pasta onde as contas são criadas. Vazio = ~/.claude-accounts. |
| `claudeAccounts.gravatar` | `false` | Mostrar o Gravatar do e-mail de cada conta no seletor de contas. Vem desligado: quando ligado, a extensão pede imagens ao gravatar.com, enviando um hash do e-mail. |
| `claudeAccounts.suggestSwitchOnLimit` | `true` | Obsoleta. Substituída por `claudeAccounts.onUsageLimit`. |
<!-- settings:end -->

## Onde cada coisa fica

| O quê | Onde | Sincronizado |
| --- | --- | --- |
| Pastas das contas (login, histórico, configuração) | `~/.claude-accounts/<id>/` (`claudeAccounts.accountsRoot`) | Não |
| Conta Padrão | `~/.claude` e `~/.claude.json`, ou o `CLAUDE_CONFIG_DIR` com que o VS Code foi aberto | Não |
| Nomes, cores, ícones, padrões por repositório | Armazenamento global do VS Code | Settings Sync |
| Variáveis de ambiente | Armazenamento global do VS Code; valores secretos no armazenamento seguro do VS Code | Não |
| Conta selecionada | Armazenamento do workspace (ou global, com `claudeAccounts.scope: user`) | Não |
| Backups de histórico mesclado e de arquivos substituídos | `~/.claude-accounts/.backups/` (últimas 10 operações) | Não |
| Ponte da cota ao vivo | `~/.claude-accounts/.bridge/` e `.multi-account-statusline.json` na pasta de cada conta | Não |
| Log | **Contas do Claude: Mostrar log** | Não |

## Privacidade e segurança

- **Sem telemetria.** A única requisição de rede que a extensão pode fazer é ao gravatar.com, e só se você ligar `claudeAccounts.gravatar` (ela envia um hash SHA-256 do e-mail).
- Do arquivo de credenciais, a extensão lê **apenas** `subscriptionType` e `rateLimitTier`. Os tokens nunca são guardados, exibidos nem enviados a lugar algum.
- Dados de login (`.credentials.json`, `.claude.json`) e estado de sessão nunca são compartilhados entre contas, mesmo que estejam em `claudeAccounts.sharedItems`.
- As configurações que mudam o que acontece com as suas pastas (`shareHistory`, `rules`, `scope`, `liveQuota`…) só podem ser definidas nas configurações de usuário, nunca pelo `.vscode/settings.json` de um repositório. No Modo Restrito, as configurações do workspace não podem mudar quando as contas são aplicadas.
- Relate vulnerabilidades de forma privada; veja o [SECURITY.md](SECURITY.md).

## Solução de problemas

- **O painel mostra a conta errada logo após abrir**: o painel do Claude Code foi restaurado antes de esta extensão ativar. Recarregue a janela uma vez; a barra de status mostra um ícone de sincronização quando isso é necessário.
- **Todas as janelas usam a mesma conta**: `CLAUDE_CONFIG_DIR` está em `claudeCode.environmentVariables`. Essa configuração vale para todas as janelas; a extensão detecta isso e oferece remover só essa entrada.
- **macOS**: as credenciais ficam no Keychain, uma entrada por pasta de conta. O **Diagnosticar** roda `claude auth status` em cada conta para confirmar que os logins estão separados.
- **Um item compartilhado parou de sincronizar**: alguma ferramenta substituiu o link por uma cópia. A extensão detecta isso e oferece **Religar**, guardando a versão local como `.bak-<data>`.
- Qualquer outra coisa: rode **Contas do Claude: Diagnosticar**, veja **Contas do Claude: Mostrar log** e [abra uma issue](https://github.com/Kahuecosta/account-switcher-for-claude-code/issues/new/choose) com o relatório (os e-mails são mascarados).

## Limitações conhecidas

- A troca exige recarregar a janela para o painel do Claude Code (os terminais trocam na hora).
- As variáveis de ambiente por conta valem para todas as extensões de uma janela que usa a conta.
- Seus hooks ou scripts que fixam `~/.claude` continuam apontando para a conta Padrão. Use `$CLAUDE_CONFIG_DIR` neles.
- Os números de uso vêm só dos logs desta máquina e não podem ser separados por conta com o histórico compartilhado.
- Os formatos de transcrição e de credenciais são internos do Claude Code e podem mudar; todos os campos são lidos de forma defensiva.

## Desinstalação

1. Desligue antes a cota ao vivo, se ligou, para a sua linha de status ser restaurada.
2. Opcional: desligue o histórico compartilhado para cada conta voltar a ter a própria cópia.
3. Desinstale a extensão. O `~/.claude` não é tocado; as pastas das contas ficam em `~/.claude-accounts/` até você apagá-las.

## Contribuindo

Contribuições são bem-vindas. Veja o [CONTRIBUTING.md](CONTRIBUTING.md) para o ambiente de desenvolvimento, testes e traduções, e o [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) para a organização do código.

## Licença

[MIT](LICENSE)
