import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import pino from 'pino';
import express from 'express';

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL; // ex: https://SEU-N8N.up.railway.app/webhook/whatsapp-moderador
const API_SECRET = process.env.API_SECRET;           // mesmo valor configurado no header x-api-secret do n8n
const AUTH_FOLDER = process.env.AUTH_FOLDER || 'auth_info_baileys';
const PORT = process.env.PORT || 3000;
const REMOVE_THRESHOLD = parseInt(process.env.REMOVE_THRESHOLD || '3', 10);

// Contagem de violações em memória (chave: "grupo_id:participant" -> número de violações)
// Zera quando a pessoa é removida, e também sempre que o serviço reinicia.
const violationCounts = new Map();

let sock;
let currentQR = null;   // string do QR pendente de leitura (null = não há QR ativo agora)
let isConnected = false;

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Usando WhatsApp Web v${version.join('.')} (mais recente conhecida: ${isLatest})`);

  sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      console.log('\n=== Escaneie este QR code no WhatsApp: Aparelhos conectados > Conectar aparelho ===\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      isConnected = false;
      const statusCode = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode
        : undefined;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Conexão fechada:', lastDisconnect?.error?.message, '| Reconectando:', shouldReconnect);
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 5000); // espera 5s antes de tentar de novo, evita martelar em loop
      } else {
        console.log(`Sessão desconectada (logout). Apague a pasta "${AUTH_FOLDER}" e escaneie o QR de novo.`);
      }
    } else if (connection === 'open') {
      currentQR = null;
      isConnected = true;
      console.log('Conectado ao WhatsApp com sucesso.');
    }
  });

  const processedMessageIds = new Set();

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return; // ignora replay de histórico sincronizado (comum após reconectar)

    const msg = messages[0];
    if (!msg?.message) return;

    const msgId = msg.key.id;
    console.log('Mensagem recebida | type:', type, '| id:', msgId, '| de', msg.key.remoteJid, '| fromMe:', msg.key.fromMe, '| pushName:', msg.pushName);

    if (processedMessageIds.has(msgId)) {
      console.log('Ignorada: id já processado (duplicata)', msgId);
      return;
    }
    processedMessageIds.add(msgId);
    if (processedMessageIds.size > 500) {
      processedMessageIds.delete(processedMessageIds.values().next().value);
    }

    if (msg.key.fromMe) return;

    const grupoId = msg.key.remoteJid;
    if (!grupoId || !grupoId.endsWith('@g.us')) {
      console.log('Ignorada: não é uma mensagem de grupo (@g.us)');
      return;
    }

    const texto =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      '';

    if (!texto) {
      console.log('Ignorada: sem texto reconhecido. Tipos na mensagem:', Object.keys(msg.message));
      return;
    }

    const payload = {
      grupo_id: grupoId,
      message_id: msg.key.id,
      participant: msg.key.participant || grupoId,
      remetente: msg.pushName || msg.key.participant || grupoId,
      texto
    };

    console.log('Encaminhando pro n8n:', JSON.stringify(payload));

    if (!N8N_WEBHOOK_URL) {
      console.warn('N8N_WEBHOOK_URL não configurada — mensagem recebida mas não encaminhada.');
      return;
    }

    try {
      const resp = await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!resp.ok) {
        console.error(`n8n respondeu ${resp.status} ao receber a mensagem — confira se o fluxo está Active e se N8N_WEBHOOK_URL é a Production URL.`);
      }
    } catch (err) {
      console.error('Erro ao encaminhar mensagem pro n8n:', err.message);
    }
  });
}

connectToWhatsApp();

// --- Servidor HTTP: os dois endpoints que o n8n chama de volta ---

const app = express();
app.use(express.json());

function checkAuth(req, res, next) {
  if (!API_SECRET) {
    console.warn('AVISO: API_SECRET não configurado — os endpoints /apagar e /avisar estão sem proteção.');
    return next();
  }
  if (req.headers['x-api-secret'] !== API_SECRET) {
    return res.status(401).json({ erro: 'não autorizado' });
  }
  next();
}

app.get('/health', (req, res) => {
  res.json({ ok: true, conectado: !!sock?.user });
});

app.get('/qr', async (req, res) => {
  const pagina = (miolo) => `
    <html>
      <head><meta http-equiv="refresh" content="15"></head>
      <body style="font-family: sans-serif; text-align: center; padding: 40px;">
        ${miolo}
      </body>
    </html>`;

  if (isConnected) {
    return res.send(pagina('<h2>✅ WhatsApp já conectado</h2>'));
  }

  if (!currentQR) {
    return res.send(pagina('<h2>Aguardando QR code...</h2><p>Atualiza sozinho a cada 15s</p>'));
  }

  try {
    const dataUrl = await QRCode.toDataURL(currentQR, { width: 320 });
    res.send(pagina(`
      <h2>Escaneie no WhatsApp</h2>
      <p>Aparelhos conectados → Conectar aparelho</p>
      <img src="${dataUrl}" width="320" height="320" alt="QR code" />
      <p style="color:#666">Expira rápido — se não escanear a tempo, a página atualiza sozinha com um novo</p>
    `));
  } catch (err) {
    res.status(500).send('Erro ao gerar QR: ' + err.message);
  }
});

app.post('/apagar', checkAuth, async (req, res) => {
  const { grupo_id, message_id, participant } = req.body;
  if (!sock) return res.status(503).json({ erro: 'WhatsApp ainda não conectado' });

  try {
    await sock.sendMessage(grupo_id, {
      delete: {
        remoteJid: grupo_id,
        id: message_id,
        participant,
        fromMe: false
      }
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao apagar mensagem:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.post('/avisar', checkAuth, async (req, res) => {
  const { grupo_id, mensagem } = req.body;
  if (!sock) return res.status(503).json({ erro: 'WhatsApp ainda não conectado' });
  if (!mensagem) return res.status(400).json({ erro: 'campo "mensagem" vazio' });

  try {
    await sock.sendMessage(grupo_id, { text: mensagem });
    res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao enviar aviso:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.post('/registrar-violacao', checkAuth, async (req, res) => {
  const { grupo_id, participant, remetente } = req.body;
  if (!sock) return res.status(503).json({ erro: 'WhatsApp ainda não conectado' });
  if (!grupo_id || !participant) {
    return res.status(400).json({ erro: 'grupo_id e participant são obrigatórios' });
  }

  const chave = `${grupo_id}:${participant}`;
  const contagem = (violationCounts.get(chave) || 0) + 1;
  violationCounts.set(chave, contagem);

  let removido = false;

  if (contagem >= REMOVE_THRESHOLD) {
    try {
      await sock.groupParticipantsUpdate(grupo_id, [participant], 'remove');
      violationCounts.set(chave, 0);
      removido = true;
      await sock.sendMessage(grupo_id, {
        text: `⚠️ ${remetente || participant} foi removido do grupo automaticamente após atingir ${REMOVE_THRESHOLD} violações.`
      });
    } catch (err) {
      // Causa mais comum: este número não é admin do grupo, então o WhatsApp recusa a remoção.
      console.error('Erro ao remover participante (o bot é admin do grupo?):', err.message);
      return res.status(500).json({ erro: err.message, contagem });
    }
  }

  res.json({ ok: true, contagem, removido });
});

app.listen(PORT, () => {
  console.log(`Servidor HTTP rodando na porta ${PORT}`);
});
