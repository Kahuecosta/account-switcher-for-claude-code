# Account Switcher for Claude Code

Alterne entre várias contas do Claude Code no VS Code **por janela ou por repositório**, sem modificar a sua pasta `~/.claude`.

> **Sem afiliação com a Anthropic.** Esta é uma extensão da comunidade. "Claude" e "Claude Code" são marcas registradas da Anthropic, PBC.

[English](README.md)

## Recursos

- **Conta por janela**: cada janela do VS Code pode usar uma conta diferente ao mesmo tempo.
- **Conta padrão por repositório**: ao abrir um repo, a conta dele é aplicada automaticamente. Clones do mesmo repo compartilham o padrão, porque ele é identificado pelo remote do git.
- **Perfil compartilhado ou isolado**: uma conta compartilhada reaproveita `settings.json`, `CLAUDE.md`, agents, commands, skills e plugins do `~/.claude` e mantém só o próprio login. Uma conta isolada mantém tudo separado.
- **Histórico compartilhado opcional**: todas as contas veem as mesmas conversas. Ao ativar, o histórico que cada conta já tem é mesclado, não descartado.
- **Integração com o terminal**: o `claude` da CLI nos terminais integrados usa a mesma conta do painel.
- **Saiba em qual conta você está**: cada conta mostra e-mail, plano (ex.: Pro, Max 20x) e organização, quando o Claude Code informa. Ela também tem cor e ícone ou emoji próprios na barra de status, e uma imagem opcional no seletor.
- **Regras**: faça todos os repos em `~/trabalho/**`, ou todos de `github.com/minha-empresa/*`, usarem uma conta automaticamente.
- **Assistente de limite**: quando a conta atual atinge o limite de uso, a extensão oferece trocar para outra com um clique.
- **Uso por conta**: tokens usados hoje e nos últimos 7 dias, lidos dos logs locais do Claude Code.
- **Variáveis de ambiente por conta**, como modelo padrão ou proxy, guardadas só na máquina local.
- **Alternância rápida** entre as duas últimas contas com `Ctrl+Alt+Shift+A` (`Cmd+Alt+Shift+A` no macOS).
- **Settings Sync**: nomes, cores, ícones e padrões por repositório acompanham você em outras máquinas. Pastas, logins e variáveis de ambiente ficam locais.
- **Seguro por padrão**: o seu `~/.claude` original é a conta "Padrão" e nunca é apagado nem sobrescrito. Nada é gravado no repositório nem nas configurações do VS Code.

## Como usar

1. Clique em **Claude: padrão** na barra de status e escolha **Adicionar conta…**.
2. Dê um nome e escolha **Perfil compartilhado** ou **Perfil isolado**.
3. Escolha **Fazer login**. Um terminal abre com o ambiente da conta e roda `claude auth login`.
4. Troque de conta pela barra de status quando quiser. A janela é recarregada para o Claude Code usar a nova conta.
5. Opcional: escolha **Definir conta padrão deste repositório…** ou **Adicionar regra de conta padrão…**.

Passe o mouse sobre uma conta no seletor para ver botões de renomear, mudar a aparência, fazer login ou remover.

Rode `/status` no painel do Claude Code para confirmar qual conta está ativa.

## Identidade e uso

E-mail, plano e organização vêm de arquivos que o Claude Code grava na pasta de cada conta. Do arquivo de credenciais, a extensão lê **apenas** `subscriptionType` e `rateLimitTier`. Os tokens nunca são guardados nem exibidos.

Esses formatos não são documentados pela Anthropic e podem mudar, por isso todos os campos são opcionais. No macOS o login fica no Keychain, então o plano pode não aparecer.

Os números de uso e a detecção de limite vêm dos logs de sessão em `projects/` e cobrem só esta máquina. Com o histórico compartilhado, não dá para separar o uso por conta.

O Gravatar é opcional e vem desligado. Se ligado, é a única requisição de rede da extensão, e envia apenas um hash SHA-256 do e-mail.

## Limitações conhecidas

- **Não coloque `CLAUDE_CONFIG_DIR` em `claudeCode.environmentVariables`.** Essa configuração só existe no nível de usuário e anula a troca em todas as janelas. A extensão detecta isso e oferece remover só essa entrada.
- **O painel do Claude Code pode ser restaurado antes da extensão ativar.** Se o `/status` mostrar a conta errada logo após abrir o VS Code, recarregue a janela uma vez.
- **Arquivos regravados quebram links.** Se uma ferramenta substituir um arquivo compartilhado em vez de editá-lo, aquela conta fica com uma cópia própria. A extensão detecta isso ao abrir e oferece **Religar**, guardando a versão local como `.bak-<data>`.
- **macOS**: as credenciais ficam no Keychain. Rode `claude auth status` em cada conta para confirmar que os logins estão separados.

Detalhes técnicos e a lista completa de configurações estão no [README em inglês](README.md).

## Licença

[MIT](LICENSE)
