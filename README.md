# Moderador WhatsApp — serviço Baileys

Conecta ao seu WhatsApp, encaminha cada mensagem de grupo pro webhook do n8n, e expõe os endpoints que o n8n chama de volta para executar apagar/avisar/remover — tudo automático, sem precisar de ninguém digitar um comando.

## Endpoints

- `POST /apagar` — body `{ grupo_id, message_id, participant }` → apaga a mensagem pra todo mundo
- `POST /avisar` — body `{ grupo_id, mensagem }` → envia o aviso no grupo
- `POST /registrar-violacao` — body `{ grupo_id, participant, remetente }` → conta uma violação para essa pessoa; ao atingir `REMOVE_THRESHOLD` violações, remove ela do grupo automaticamente e avisa no grupo — sem precisar de nenhum comando manual
- `GET /health` — status da conexão

Os três primeiros exigem o header `x-api-secret` com o mesmo valor da variável `API_SECRET`.

A contagem de violações fica em memória (reseta se o serviço reiniciar) e é por pessoa+grupo, não global.

## Deploy no Railway

1. Suba esta pasta num repositório Git e conecte ao Railway (New Project → Deploy from GitHub Repo). O Railway detecta o Node automaticamente.
2. Em **Variables**, configure:
   - `N8N_WEBHOOK_URL` — a URL do webhook do fluxo n8n
   - `API_SECRET` — uma string aleatória (use o mesmo valor no header do n8n)
   - `AUTH_FOLDER` — `/data/auth_info_baileys` (só depois do passo 3)
3. Em **Settings → Volumes**, adicione um volume e monte em `/data`. Sem isso, a sessão do WhatsApp se perde a cada redeploy e você precisa escanear o QR de novo toda vez.
4. Depois do deploy, abra a aba **Deploy Logs** — o QR code aparece ali em texto (ASCII). Escaneie com **WhatsApp → Aparelhos conectados → Conectar aparelho**.
5. Torne este número **administrador** de cada grupo que ele vai moderar. Sem isso, o WhatsApp recusa tanto apagar mensagem de terceiros quanto remover membros — avisos continuam funcionando, mas apagar e remover falham silenciosamente.

## Rodando localmente antes de subir

```bash
npm install
cp .env.example .env   # preencha as variáveis
npm start
```

O QR aparece no seu próprio terminal na primeira execução.

## Limitações da v1

- Só modera mensagens de texto (ou legendas de imagem/vídeo) — mídia sem legenda passa direto
- A contagem de violações (`REMOVE_THRESHOLD`, padrão 3) fica em memória — reinicia zerada se o serviço reiniciar/redeployar, e não diferencia o tipo de regra violada (toda violação conta igual pro limite de remoção)
- Uma instância = um número conectado. Múltiplos grupos são suportados, mas todos moderados pelas mesmas regras (a versão com regras por grupo, vindas da interface gráfica, ainda não foi construída)
