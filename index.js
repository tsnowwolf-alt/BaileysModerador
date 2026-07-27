import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import pino from 'pino';
import express from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

const execAsync = promisify(exec);

// Converte áudio (o WhatsApp manda em ogg/opus) pra mp3, formato que a API de IA aceita
async function converterAudioParaMp3(bufferOriginal) {
  const idTemp = Math.random().toString(36).slice(2);
  const entrada = path.join(tmpdir(), `audio-in-${idTemp}.ogg`);
  const saida = path.join(tmpdir(), `audio-out-${idTemp}.mp3`);
  try {
    await writeFile(entrada, bufferOriginal);
    await execAsync(`ffmpeg -y -i "${entrada}" -ar 16000 -ac 1 "${saida}"`, { timeout: 15000 });
    return await readFile(saida);
  } finally {
    await unlink(entrada).catch(() => {});
    await unlink(saida).catch(() => {});
  }
}

// Extrai alguns frames do vídeo como imagens — mais confiável hoje do que mandar o vídeo inteiro pra IA
async function extrairFramesDoVideo(bufferOriginal, duracaoSegundos) {
  const idTemp = Math.random().toString(36).slice(2);
  const entrada = path.join(tmpdir(), `video-in-${idTemp}.mp4`);
  const frames = [];
  try {
    await writeFile(entrada, bufferOriginal);
    const duracao = duracaoSegundos || 6;
    const momentos = [0.25, 0.5, 0.75].map((f) => Math.max(0.1, duracao * f));
    for (let i = 0; i < momentos.length; i++) {
      const saidaFrame = path.join(tmpdir(), `frame-${idTemp}-${i}.jpg`);
      try {
        await execAsync(`ffmpeg -y -ss ${momentos[i]} -i "${entrada}" -frames:v 1 -q:v 3 "${saidaFrame}"`, { timeout: 15000 });
        frames.push((await readFile(saidaFrame)).toString('base64'));
      } catch (err) {
        console.error(`Erro extraindo frame ${i} do vídeo:`, err.message);
      } finally {
        await unlink(saidaFrame).catch(() => {});
      }
    }
    return frames;
  } finally {
    await unlink(entrada).catch(() => {});
  }
}

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL; // ex: https://SEU-N8N.up.railway.app/webhook/whatsapp-moderador
const API_SECRET = process.env.API_SECRET;           // mesmo valor configurado no header x-api-secret do n8n
const AUTH_FOLDER = process.env.AUTH_FOLDER || 'auth_info_baileys';
const PORT = process.env.PORT || 3000;
const REMOVE_THRESHOLD = parseInt(process.env.REMOVE_THRESHOLD || '2', 10);
const JANELA_FREQUENCIA_MS = 60000; // janela de 60s pra medir "excesso de mensagens"

// Contagem de violações em memória (chave: "grupo_id:participant" -> número de violações)
// Zera quando a pessoa é removida, e também sempre que o serviço reinicia.
const violationCounts = new Map();

// IDs de mensagem já processadas, pra nunca reagir duas vezes à mesma mensagem
const processedMessageIds = new Set();

// Timestamps recentes por pessoa, pra IA saber se ela está mandando mensagem em rajada
const recentMessageTimestamps = new Map();

function contarMensagensRecentes(chave) {
  const agora = Date.now();
  const lista = (recentMessageTimestamps.get(chave) || []).filter((t) => agora - t < JANELA_FREQUENCIA_MS);
  lista.push(agora);
  recentMessageTimestamps.set(chave, lista);
  return lista.length;
}

let sock;
let currentQR = null;   // string do QR pendente de leitura (null = não há QR ativo agora)
let isConnected = false;

async function enviarComDigitando(jid, texto) {
  try {
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise((resolve) => setTimeout(resolve, 1200 + Math.random() * 1300)); // ~1.2-2.5s, rápido mas com efeito de digitação
    await sock.sendMessage(jid, { text: texto });
    await sock.sendPresenceUpdate('paused', jid);
  } catch (err) {
    console.error('Erro ao enviar mensagem com efeito de digitação:', err.message);
    throw err;
  }
}

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

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return; // ignora replay de histórico sincronizado (comum após reconectar)

    for (const msg of messages) {
      await processarMensagem(msg).catch((err) => console.error('Erro processando uma mensagem do lote:', err.message));
    }
  });

  async function processarMensagem(msg) {
    if (!msg?.message) return;

    const msgId = msg.key.id;
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

    const tipoConteudo = Object.keys(msg.message)[0]; // ex: conversation, imageMessage, audioMessage...
    let tipo = null;
    let texto = '';
    let duracaoSegundos = null;

    if (tipoConteudo === 'conversation') {
      tipo = 'texto';
      texto = msg.message.conversation || '';
    } else if (tipoConteudo === 'extendedTextMessage') {
      tipo = 'texto';
      texto = msg.message.extendedTextMessage?.text || '';
    } else if (tipoConteudo === 'imageMessage') {
      tipo = 'imagem';
      texto = msg.message.imageMessage?.caption || '';
    } else if (tipoConteudo === 'videoMessage') {
      tipo = 'video';
      texto = msg.message.videoMessage?.caption || '';
      duracaoSegundos = msg.message.videoMessage?.seconds ?? null;
    } else if (tipoConteudo === 'audioMessage') {
      tipo = msg.message.audioMessage?.ptt ? 'audio_voz' : 'audio';
      duracaoSegundos = msg.message.audioMessage?.seconds ?? null;
    } else if (tipoConteudo === 'stickerMessage') {
      tipo = 'figurinha';
    } else if (tipoConteudo === 'documentMessage') {
      tipo = 'documento';
      texto = msg.message.documentMessage?.caption || '';
    } else {
      console.log('Ignorada: tipo não moderado —', tipoConteudo);
      return;
    }

    const participant = msg.key.participant || grupoId;
    const mensagensRecentes = contarMensagensRecentes(`${grupoId}:${participant}`);

    let midiaBase64 = null;
    let midiaMimeType = null;
    let audioBase64 = null;
    let framesBase64 = null;

    if (tipo === 'imagem') {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        midiaBase64 = buffer.toString('base64');
        midiaMimeType = msg.message.imageMessage?.mimetype || 'image/jpeg';
      } catch (err) {
        console.error('Erro ao baixar imagem (seguindo sem o conteúdo visual):', err.message);
      }
    } else if (tipo === 'audio' || tipo === 'audio_voz') {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        audioBase64 = (await converterAudioParaMp3(buffer)).toString('base64');
      } catch (err) {
        console.error('Erro ao baixar/converter áudio (seguindo só com duração/metadados):', err.message);
      }
    } else if (tipo === 'video') {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        framesBase64 = await extrairFramesDoVideo(buffer, duracaoSegundos);
      } catch (err) {
        console.error('Erro ao baixar/processar vídeo (seguindo só com duração/metadados):', err.message);
      }
    }

    const payload = {
      grupo_id: grupoId,
      message_id: msgId,
      participant,
      remetente: msg.pushName || participant,
      tipo,
      texto,
      duracao_segundos: duracaoSegundos,
      mensagens_recentes_60s: mensagensRecentes,
      midia_base64: midiaBase64,
      midia_mime_type: midiaMimeType,
      audio_base64: audioBase64,
      frames_base64: framesBase64
    };

    console.log('Encaminhando pro n8n:', JSON.stringify({
      ...payload,
      midia_base64: midiaBase64 ? `[${midiaBase64.length} chars]` : null,
      audio_base64: audioBase64 ? `[${audioBase64.length} chars]` : null,
      frames_base64: framesBase64 ? `[${framesBase64.length} frames]` : null
    }));

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
  }
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
    await enviarComDigitando(grupo_id, mensagem);
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
      await enviarComDigitando(grupo_id, `⚠️ ${remetente || participant} foi removido do grupo automaticamente após atingir ${REMOVE_THRESHOLD} violações.`);
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
