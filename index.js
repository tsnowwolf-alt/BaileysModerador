import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, downloadMediaMessage, getAggregateVotesInPollMessage } from '@whiskeysockets/baileys';
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

// Extrai só o áudio de dentro do vídeo (a fala/som), pra IA "ouvir" o que os frames sozinhos não capturam
async function extrairAudioDoVideo(bufferOriginal) {
  const idTemp = Math.random().toString(36).slice(2);
  const entrada = path.join(tmpdir(), `video-audio-in-${idTemp}.mp4`);
  const saida = path.join(tmpdir(), `video-audio-out-${idTemp}.mp3`);
  try {
    await writeFile(entrada, bufferOriginal);
    await execAsync(`ffmpeg -y -i "${entrada}" -vn -ar 16000 -ac 1 "${saida}"`, { timeout: 15000 });
    return await readFile(saida);
  } finally {
    await unlink(entrada).catch(() => {});
    await unlink(saida).catch(() => {});
  }
} // fim de extrairAudioDoVideo

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL; // ex: https://SEU-N8N.up.railway.app/webhook/whatsapp-moderador
const API_SECRET = process.env.API_SECRET;           // mesmo valor configurado no header x-api-secret do n8n
const AUTH_FOLDER = process.env.AUTH_FOLDER || 'auth_info_baileys';
const PORT = process.env.PORT || 3000;
const REMOVE_THRESHOLD = parseInt(process.env.REMOVE_THRESHOLD || '2', 10);
const JANELA_FREQUENCIA_MS = 60000; // janela de 60s pra medir "excesso de mensagens"
const FUSO_HORARIO = 'America/Sao_Paulo'; // usado só pro agendamento do ciclo de enquete/debate

// Hora local (HH:mm) no fuso acima, sem depender de biblioteca externa de data/hora.
function horaLocalAgora(data = new Date()) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO_HORARIO,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(data);
  const mapa = Object.fromEntries(partes.map((p) => [p.type, p.value]));
  return `${mapa.hour}:${mapa.minute}`;
}

// Números banidos: removidos automaticamente assim que entram em qualquer grupo.
// Configurar via variável de ambiente NUMEROS_BANIDOS, separados por vírgula, com código do país.
// Ex: NUMEROS_BANIDOS=5521978812154,5511999998888
const NUMEROS_BANIDOS = (process.env.NUMEROS_BANIDOS || '')
  .split(',')
  .map((n) => n.trim())
  .filter(Boolean);

// Números liberados pra mandar link/divulgação sem cair na regra de spam.
// Mesma ideia dos banidos: variável de ambiente, separados por vírgula, com código do país.
// Ex: NUMEROS_LIBERADOS_DIVULGACAO=5521978812154
const NUMEROS_LIBERADOS_DIVULGACAO = (process.env.NUMEROS_LIBERADOS_DIVULGACAO || '')
  .split(',')
  .map((n) => n.trim())
  .filter(Boolean);

// Identificadores reais (JID tradicional e/ou @lid) resolvidos a partir de uma lista de números.
// Só normaliza o formato de cada entrada — a resolução de verdade acontece na hora de cada mensagem,
// via participantEstaNaLista(), porque o mapeamento @lid só fica disponível depois de alguma interação.
function montarListaDeIdentificadores(lista, rotulo) {
  const conjunto = new Set();
  for (const item of lista) {
    conjunto.add(item.includes('@') ? item : `${item}@s.whatsapp.net`);
  }
  if (lista.length > 0) {
    console.log(`${rotulo} configurados:`, [...conjunto]);
  }
  return conjunto;
}

// Remove sufixo de dispositivo do JID (ex: "5511999998888:12@s.whatsapp.net" -> "5511999998888")
function numeroBase(jid) {
  return jid.split('@')[0].split(':')[0];
}

// Confere se quem mandou a mensagem está numa lista — tenta o identificador direto,
// e se ele vier como @lid, também tenta resolver pro número de telefone correspondente
// (usando o mapeamento oficial do Baileys, populado depois que ele processa mensagens da pessoa).
async function participantEstaNaLista(participantJid, listaSet) {
  console.log(`[CHECK-LISTA] chamada: participant=${participantJid}, tamanho da lista=${listaSet.size}`);

  if (listaSet.size === 0) return false;
  if (listaSet.has(participantJid)) {
    console.log('[CHECK-LISTA] bateu direto, sem precisar resolver @lid');
    return true;
  }

  if (participantJid.endsWith('@lid')) {
    const temSignalRepo = !!sock?.signalRepository;
    const temLidMapping = !!sock?.signalRepository?.lidMapping;
    console.log(`[CHECK-LISTA] é @lid — sock existe: ${!!sock} | signalRepository existe: ${temSignalRepo} | lidMapping existe: ${temLidMapping}`);

    if (!temLidMapping) {
      console.log('[CHECK-LISTA] lidMapping não existe nessa versão do Baileys instalada — não dá pra resolver assim.');
      return false;
    }

    try {
      const pn = await sock.signalRepository.lidMapping.getPNForLID(participantJid);
      console.log(`[CHECK-LISTA] Resolução: ${participantJid} -> ${pn || '(sem mapeamento ainda)'}`);
      if (pn) {
        if (listaSet.has(pn)) return true;
        const alvo = numeroBase(pn);
        for (const item of listaSet) {
          if (numeroBase(item) === alvo) return true;
        }
      }
    } catch (err) {
      console.log('[CHECK-LISTA] Erro ao resolver @lid:', err.message, '| stack:', err.stack);
    }
  }
  return false;
}

let jidsBanidosResolvidos = new Set();
let jidsLiberadosDivulgacao = new Set();

function montarListasDeIdentificadores() {
  jidsBanidosResolvidos = montarListaDeIdentificadores(NUMEROS_BANIDOS, 'Números banidos');
  jidsLiberadosDivulgacao = montarListaDeIdentificadores(NUMEROS_LIBERADOS_DIVULGACAO, 'Números liberados pra divulgação');
}


// IDs de mensagem já processadas, pra nunca reagir duas vezes à mesma mensagem.
// NÃO persiste: só protege contra reentrega quase-simultânea dentro da MESMA conexão ativa.
// Depois de um restart é uma sessão nova — o cache começar vazio de novo não é problema.
const processedMessageIds = new Set();

// Timestamps recentes por pessoa, pra IA saber se ela está mandando mensagem em rajada.
// NÃO persiste: a janela é de só 60s, então histórico de antes de um restart já não conta mais.
const recentMessageTimestamps = new Map();

function contarMensagensRecentes(chave) {
  const agora = Date.now();
  const lista = (recentMessageTimestamps.get(chave) || []).filter((t) => agora - t < JANELA_FREQUENCIA_MS);
  lista.push(agora);
  recentMessageTimestamps.set(chave, lista);
  return lista.length;
}

// Helper genérico pra persistir um Map em disco, dentro do AUTH_FOLDER (a mesma pasta que já
// sobrevive a redeploy por causa da sessão do Baileys — nenhum Volume novo precisa ser configurado).
// Carrega uma vez no boot, salva com debounce a cada atualização, e permite forçar um flush no shutdown.
function criarMapaPersistente(nomeArquivo, { debounceMs = 2000 } = {}) {
  const mapa = new Map();
  const arquivo = path.join(AUTH_FOLDER, nomeArquivo);
  let carregado = false;
  let timer = null;

  async function carregar() {
    if (carregado) return; // só carrega uma vez por execução (evita pisar em dado novo num reconnect)
    carregado = true;
    try {
      const bruto = await readFile(arquivo, 'utf-8');
      for (const [chave, valor] of Object.entries(JSON.parse(bruto))) {
        mapa.set(chave, valor);
      }
      console.log(`${nomeArquivo}: carregado do disco (${mapa.size} chaves).`);
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log(`${nomeArquivo}: nenhum arquivo salvo ainda (primeira execução ou pasta nova).`);
      } else {
        console.error(`${nomeArquivo}: erro ao carregar —`, err.message);
      }
    }
  }

  async function salvarAgora() {
    try {
      await writeFile(arquivo, JSON.stringify(Object.fromEntries(mapa)), 'utf-8');
    } catch (err) {
      console.error(`${nomeArquivo}: erro ao salvar —`, err.message);
    }
  }

  function agendarSalvar() {
    if (timer) return; // já tem um save agendado — as próximas chamadas pegam carona nele
    timer = setTimeout(() => {
      timer = null;
      salvarAgora();
    }, debounceMs); // agrupa rajadas de atualização num salvamento só, em vez de escrever a cada evento
  }

  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    return salvarAgora();
  }

  return { mapa, carregar, agendarSalvar, flush };
}

// Variante do helper acima pra um único objeto (não uma coleção por chave) — usado pra
// configuração ajustável e pro estado atual do ciclo de enquete/debate. Mesmo mecanismo:
// carrega uma vez, salva com debounce, dá pra forçar flush no shutdown.
function criarValorPersistente(nomeArquivo, valorPadrao, { debounceMs = 2000 } = {}) {
  let valor = { ...valorPadrao };
  const arquivo = path.join(AUTH_FOLDER, nomeArquivo);
  let carregado = false;
  let timer = null;

  async function carregar() {
    if (carregado) return;
    carregado = true;
    try {
      const bruto = await readFile(arquivo, 'utf-8');
      valor = { ...valorPadrao, ...JSON.parse(bruto) }; // o padrão preenche campos novos que um arquivo antigo ainda não tem
      console.log(`${nomeArquivo}: carregado do disco.`);
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log(`${nomeArquivo}: nenhum arquivo salvo ainda, usando padrão.`);
      } else {
        console.error(`${nomeArquivo}: erro ao carregar —`, err.message);
      }
    }
  }

  async function salvarAgora() {
    try {
      await writeFile(arquivo, JSON.stringify(valor), 'utf-8');
    } catch (err) {
      console.error(`${nomeArquivo}: erro ao salvar —`, err.message);
    }
  }

  function agendarSalvar() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      salvarAgora();
    }, debounceMs);
  }

  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    return salvarAgora();
  }

  function get() {
    return valor;
  }

  function set(atualizacoes) {
    valor = { ...valor, ...atualizacoes };
    agendarSalvar();
    return valor;
  }

  return { carregar, get, set, flush };
}

// Contagem de violações (chave: "grupo_id:participant" -> número de violações).
// Zera quando a pessoa é removida. Persistida em disco — não zera mais sozinha num restart.
const persistViolacoes = criarMapaPersistente('violations.json');
const violationCounts = persistViolacoes.mapa;

// Pessoas vistas mandando mensagem em algum grupo — alimenta a página /contatos,
// pra achar o identificador de alguém pelo nome sem precisar caçar no log. Também persistida.
const persistContatos = criarMapaPersistente('contatos.json');
const contatosVistos = persistContatos.mapa; // chave: participant (lid ou jid) -> { nome, grupoId, numero, ultimaVez }

function registrarContatoVisto(participant, nome, grupoId, numero) {
  contatosVistos.set(participant, { nome, grupoId, numero, ultimaVez: new Date().toISOString() });
  persistContatos.agendarSalvar();
}

// --- Enquete/debate: configuração, tópicos, estado do ciclo e mensagens enviadas (pra voto de enquete) ---

// Ajustável pelo /painel. minVotosDebate: 6 = "mais de 5 pessoas votaram" tem que ser >= 6.
// O ciclo (enquete + debate) roda TODO DIA no horário configurado — intervaloDiasMencao controla
// só a menção geral (@todos), que é mais espaçada pra não virar spam de notificação.
const configDebate = criarValorPersistente('config-debate.json', {
  grupoId: '',
  horario: '20:00', // HH:mm, fuso America/Sao_Paulo — todo dia, sem exceção
  intervaloDiasMencao: 7, // a cada quantos dias a menção geral entra no anúncio
  duracaoEnqueteHoras: 1,
  duracaoDebateHoras: 1,
  minVotosDebate: 6
});

// fase: 'normal' | 'enquete' | 'debate'. votosAcumulados guarda os pollUpdates brutos recebidos
// (não só a contagem) porque getAggregateVotesInPollMessage precisa do histórico completo pra
// recalcular corretamente — inclusive depois de um restart no meio da enquete.
// ultimoCicloIniciadoEm é só informativo (mostrado no /painel); ultimaMencaoEm é o que
// realmente controla o intervaloDiasMencao acima.
const estadoDebate = criarValorPersistente('estado-debate.json', {
  fase: 'normal',
  grupoId: null,
  tema: null,
  opcoes: [],
  terminaEm: null,
  pollMessageKey: null,
  votosAcumulados: [],
  ultimoCicloIniciadoEm: null,
  ultimaMencaoEm: null
});

// Lista de tópicos de enquete cadastrados (adicionados pelo /painel). Nunca gerados pela IA —
// só consultados dali. Guardado como Map (preserva ordem de inserção) mesmo sendo uma "lista".
const persistTopicos = criarMapaPersistente('topicos-enquete.json');
const topicosEnquete = persistTopicos.mapa; // chave: id -> { tema, opcoes: [...], usado, criadoEm }

// Pega o primeiro tópico ainda não usado (ordem de cadastro) e marca como usado.
function escolherProximoTopico() {
  for (const [id, topico] of topicosEnquete) {
    if (!topico.usado) {
      topicosEnquete.set(id, { ...topico, usado: true });
      persistTopicos.agendarSalvar();
      return topico;
    }
  }
  return null;
}

// Guarda só as mensagens que o próprio bot manda e que podem precisar ser reconsultadas depois —
// hoje, só a mensagem de criação de cada enquete (é o que getMessage/decriptação de voto exige).
const persistMensagensEnviadas = criarMapaPersistente('mensagens-enviadas.json');

async function getMessage(key) {
  const registro = persistMensagensEnviadas.mapa.get(`${key.remoteJid}:${key.id}`);
  return registro || undefined;
}

// Railway manda SIGTERM pra reiniciar/redeploy (o "Stopping Container" que vocês já veem nos logs) —
// aqui a gente garante que o último estado de cada Map/valor persistente é gravado antes do processo morrer.
for (const sinal of ['SIGTERM', 'SIGINT']) {
  process.on(sinal, async () => {
    console.log(`Sinal ${sinal} recebido — salvando dados antes de encerrar...`);
    await Promise.all([
      persistContatos.flush(),
      persistViolacoes.flush(),
      configDebate.flush(),
      estadoDebate.flush(),
      persistTopicos.flush(),
      persistMensagensEnviadas.flush()
    ]);
    process.exit(0);
  });
}

let sock;
let currentQR = null;   // string do QR pendente de leitura (null = não há QR ativo agora)
let isConnected = false;
let tickerDebateIniciado = false; // evita empilhar vários setInterval em reconexões

async function enviarComDigitando(jid, texto, mentions = []) {
  try {
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise((resolve) => setTimeout(resolve, 1200 + Math.random() * 1300)); // ~1.2-2.5s, rápido mas com efeito de digitação
    await sock.sendMessage(jid, mentions.length > 0 ? { text: texto, mentions } : { text: texto });
    await sock.sendPresenceUpdate('paused', jid);
  } catch (err) {
    console.error('Erro ao enviar mensagem com efeito de digitação:', err.message);
    throw err;
  }
}

// --- Ciclo de enquete/debate: tudo aqui é lógica determinística, nada passa pela IA ---

async function iniciarCicloDebate() {
  const cfg = configDebate.get();
  if (!cfg.grupoId) {
    console.log('Ciclo de debate: nenhum grupo configurado em /painel ainda — pulando.');
    return;
  }
  const topico = escolherProximoTopico();
  if (!topico) {
    console.log('Ciclo de debate: nenhum tópico disponível em /painel — pulando este horário.');
    return;
  }

  try {
    const estadoAtual = estadoDebate.get();
    const diasDesdeUltimaMencao = estadoAtual.ultimaMencaoEm
      ? (Date.now() - new Date(estadoAtual.ultimaMencaoEm).getTime()) / 86_400_000
      : Infinity;
    const deveMencionar = diasDesdeUltimaMencao >= cfg.intervaloDiasMencao;

    let jidsParaMencionar = [];
    if (deveMencionar) {
      const metadata = await sock.groupMetadata(cfg.grupoId);
      jidsParaMencionar = metadata.participants.map((p) => p.id);
    }

    await enviarComDigitando(
      cfg.grupoId,
      `📊 Hora da enquete de hoje!\n\n*${topico.tema}*\n\nFica aberta por ${cfg.duracaoEnqueteHoras}h. Se passar de ${cfg.minVotosDebate - 1} votos, o debate começa assim que ela fechar e dura mais ${cfg.duracaoDebateHoras}h. Vota aí 👇`,
      jidsParaMencionar
    );

    const pollMsg = await sock.sendMessage(cfg.grupoId, {
      poll: { name: topico.tema, values: topico.opcoes, selectableCount: 1 }
    });
    persistMensagensEnviadas.mapa.set(`${pollMsg.key.remoteJid}:${pollMsg.key.id}`, pollMsg.message);
    persistMensagensEnviadas.agendarSalvar();

    await sock.groupSettingUpdate(cfg.grupoId, 'announcement'); // só admin manda mensagem enquanto a enquete está aberta

    estadoDebate.set({
      fase: 'enquete',
      grupoId: cfg.grupoId,
      tema: topico.tema,
      opcoes: topico.opcoes,
      terminaEm: new Date(Date.now() + cfg.duracaoEnqueteHoras * 3600_000).toISOString(),
      pollMessageKey: { remoteJid: pollMsg.key.remoteJid, id: pollMsg.key.id },
      votosAcumulados: [],
      ultimoCicloIniciadoEm: new Date().toISOString(),
      ultimaMencaoEm: deveMencionar ? new Date().toISOString() : estadoAtual.ultimaMencaoEm
    });

    console.log(`Ciclo de debate iniciado: "${topico.tema}" em ${cfg.grupoId} (${deveMencionar ? 'com' : 'sem'} menção geral)`);
  } catch (err) {
    console.error('Erro ao iniciar ciclo de debate (o bot é admin do grupo configurado?):', err.message);
  }
}

async function resolverEnquete() {
  const estado = estadoDebate.get();
  const cfg = configDebate.get();

  try {
    const mensagemCriacao = await getMessage(estado.pollMessageKey);
    let totalVotantes = 0;
    let temaVencedor = estado.tema; // some default: se não der pra apurar, usa a pergunta original da enquete
    if (mensagemCriacao) {
      const resultados = getAggregateVotesInPollMessage({ message: mensagemCriacao, pollUpdates: estado.votosAcumulados });
      totalVotantes = new Set(resultados.flatMap((r) => r.voters)).size;
      const opcaoMaisVotada = resultados.reduce(
        (melhor, atual) => (atual.voters.length > (melhor?.voters.length || 0) ? atual : melhor),
        null
      );
      if (opcaoMaisVotada && opcaoMaisVotada.voters.length > 0) temaVencedor = opcaoMaisVotada.name;
    } else {
      console.error('resolverEnquete: não achei a mensagem original da enquete no getMessage — contando 0 votos.');
    }

    await sock.groupSettingUpdate(estado.grupoId, 'not_announcement'); // libera mensagem geral de novo, com ou sem debate

    if (totalVotantes >= cfg.minVotosDebate) {
      await enviarComDigitando(estado.grupoId, `✅ ${totalVotantes} pessoas votaram — o tema mais votado foi *${temaVencedor}*. O debate começa agora e vai durar ${cfg.duracaoDebateHoras}h!`);
      await sock.groupJoinApprovalMode(estado.grupoId, 'on'); // durante o debate, entrada de novos membros passa por aprovação
      estadoDebate.set({
        fase: 'debate',
        tema: temaVencedor,
        terminaEm: new Date(Date.now() + cfg.duracaoDebateHoras * 3600_000).toISOString(),
        pollMessageKey: null,
        votosAcumulados: []
      });
    } else {
      await enviarComDigitando(estado.grupoId, `📉 Só ${totalVotantes} voto(s) na enquete sobre *${estado.tema}* — não vai ter debate hoje.`);
      estadoDebate.set({ fase: 'normal', tema: null, opcoes: [], terminaEm: null, pollMessageKey: null, votosAcumulados: [] });
    }
  } catch (err) {
    console.error('Erro ao resolver enquete:', err.message);
  }
}

async function encerrarDebate() {
  const estado = estadoDebate.get();
  try {
    await sock.groupJoinApprovalMode(estado.grupoId, 'off');
    await enviarComDigitando(estado.grupoId, `🏁 O debate sobre *${estado.tema}* foi encerrado. Valeu a quem participou!`);
  } catch (err) {
    console.error('Erro ao encerrar debate:', err.message);
  } finally {
    estadoDebate.set({ fase: 'normal', tema: null, opcoes: [], terminaEm: null });
  }
}

// Roda a cada minuto (ver setInterval mais abaixo). Decide se é hora de: iniciar um ciclo novo,
// fechar a enquete e decidir se vira debate, ou encerrar um debate em andamento. Nada disso
// chama a IA — é só relógio + Baileys.
let processandoCicloDebate = false;
async function verificarCicloDebate() {
  if (!sock || !isConnected || processandoCicloDebate) return;
  processandoCicloDebate = true;
  try {
    const cfg = configDebate.get();
    const estado = estadoDebate.get();
    const agora = new Date();

    if (estado.fase === 'normal') {
      if (!cfg.grupoId) return; // ninguém configurou um grupo no /painel ainda
      if (horaLocalAgora(agora) === cfg.horario) {
        await iniciarCicloDebate();
      }
      return;
    }

    if (estado.fase === 'enquete' && estado.terminaEm && agora >= new Date(estado.terminaEm)) {
      await resolverEnquete();
      return;
    }

    if (estado.fase === 'debate' && estado.terminaEm && agora >= new Date(estado.terminaEm)) {
      await encerrarDebate();
    }
  } finally {
    processandoCicloDebate = false;
  }
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  await Promise.all([
    persistContatos.carregar(),
    persistViolacoes.carregar(),
    configDebate.carregar(),
    estadoDebate.carregar(),
    persistTopicos.carregar(),
    persistMensagensEnviadas.carregar()
  ]);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Usando WhatsApp Web v${version.join('.')} (mais recente conhecida: ${isLatest})`);

  sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }),
    getMessage
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
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
      montarListasDeIdentificadores();
      if (!tickerDebateIniciado) {
        tickerDebateIniciado = true;
        setInterval(() => verificarCicloDebate().catch((err) => console.error('Erro no verificarCicloDebate:', err.message)), 60_000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return; // ignora replay de histórico sincronizado (comum após reconectar)

    for (const msg of messages) {
      await processarMensagem(msg).catch((err) => console.error('Erro processando uma mensagem do lote:', err.message));
    }
  });

  sock.ev.on('group-participants.update', async (evento) => {
    if (evento.action !== 'add' || jidsBanidosResolvidos.size === 0) return;

    for (const participantJid of evento.participants) {
      if (await participantEstaNaLista(participantJid, jidsBanidosResolvidos)) {
        console.log('Número banido entrou no grupo — removendo:', participantJid, 'do grupo', evento.id);
        try {
          await sock.groupParticipantsUpdate(evento.id, [participantJid], 'remove');
        } catch (err) {
          console.error('Erro ao remover número banido (o bot é admin desse grupo?):', err.message);
        }
      }
    }
  });

  // Voto de enquete chega criptografado e incremental — só acumula aqui; a contagem de verdade
  // roda em resolverEnquete() quando a fase de enquete termina, usando getAggregateVotesInPollMessage.
  sock.ev.on('messages.update', (updates) => {
    const estado = estadoDebate.get();
    if (estado.fase !== 'enquete' || !estado.pollMessageKey) return;

    for (const { key, update } of updates) {
      if (!update.pollUpdates) continue;
      if (key.id !== estado.pollMessageKey.id || key.remoteJid !== estado.pollMessageKey.remoteJid) continue;
      estadoDebate.set({ votosAcumulados: [...estadoDebate.get().votosAcumulados, ...update.pollUpdates] });
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
    const remetente = msg.pushName || participant;
    const mensagensRecentes = contarMensagensRecentes(`${grupoId}:${participant}`);
    const podeDivulgar = await participantEstaNaLista(participant, jidsLiberadosDivulgacao);

    // Tenta pegar um número de telefone de brinde, se o Baileys expuser em algum desses campos —
    // nem sempre disponível (é a mesma limitação do @lid), então fica "—" quando não tiver.
    const possivelNumero = msg.key.senderPn || msg.key.participantPn || null;
    registrarContatoVisto(participant, remetente, grupoId, possivelNumero);

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
        try {
          audioBase64 = (await extrairAudioDoVideo(buffer)).toString('base64');
        } catch (errAudio) {
          console.log('Vídeo sem trilha de áudio ou erro ao extrair (seguindo só com os frames):', errAudio.message);
        }
      } catch (err) {
        console.error('Erro ao baixar/processar vídeo (seguindo só com duração/metadados):', err.message);
      }
    }

    const estadoAtualDebate = estadoDebate.get();
    const debateAtivo = estadoAtualDebate.fase === 'debate' && estadoAtualDebate.grupoId === grupoId;

    const payload = {
      grupo_id: grupoId,
      message_id: msgId,
      participant,
      remetente,
      tipo,
      texto,
      duracao_segundos: duracaoSegundos,
      mensagens_recentes_60s: mensagensRecentes,
      pode_divulgar: podeDivulgar,
      debate_ativo: debateAtivo,
      tema_debate: debateAtivo ? estadoAtualDebate.tema : null,
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
app.use(express.urlencoded({ extended: true, limit: '5mb' })); // formulários HTML do /painel chegam nesse formato, não em JSON — limite maior por causa do import de tópicos em arquivo

function escapeHtml(valor) {
  return String(valor ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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

// /painel fica sem autenticação, igual /qr e /contatos — mesma decisão que já valia pros outros dois.

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

app.get('/contatos', (req, res) => {
  const linhas = [...contatosVistos.entries()]
    .sort((a, b) => new Date(b[1].ultimaVez) - new Date(a[1].ultimaVez))
    .map(([id, info]) => `
      <tr>
        <td>${info.nome}</td>
        <td><code onclick="navigator.clipboard.writeText('${id}')" style="cursor:pointer" title="Clique pra copiar">${id}</code></td>
        <td>${info.numero || '—'}</td>
        <td>${info.grupoId}</td>
        <td>${new Date(info.ultimaVez).toLocaleString('pt-BR')}</td>
      </tr>`)
    .join('');

  res.send(`
    <html>
      <head>
        <meta http-equiv="refresh" content="20">
        <style>
          body { font-family: sans-serif; padding: 20px; }
          table { border-collapse: collapse; width: 100%; }
          td, th { border: 1px solid #ccc; padding: 8px; text-align: left; font-size: 14px; }
          code { background: #eee; padding: 2px 5px; border-radius: 3px; }
        </style>
      </head>
      <body>
        <h2>Pessoas vistas nos grupos</h2>
        <p>Clique no identificador pra copiar. Use esse valor em <code>NUMEROS_BANIDOS</code> ou <code>NUMEROS_LIBERADOS_DIVULGACAO</code>. A coluna "Número" só aparece quando o WhatsApp expõe (nem sempre disponível).</p>
        <table>
          <tr><th>Nome</th><th>Identificador</th><th>Número</th><th>Grupo</th><th>Última mensagem</th></tr>
          ${linhas || '<tr><td colspan="5">Ainda ninguém visto — peça pra alguém mandar uma mensagem em algum grupo</td></tr>'}
        </table>
      </body>
    </html>
  `);
});

app.get('/painel', (req, res) => {
  const cfg = configDebate.get();
  const estado = estadoDebate.get();

  const linhasTopicos = [...topicosEnquete.entries()]
    .map(([, t]) => `
        <div class="topico-linha${t.usado ? ' topico-linha--usado' : ''}">
          <span class="topico-status" title="${t.usado ? 'já usado' : 'na fila'}">${t.usado ? '✅' : '⬜'}</span>
          <div class="topico-corpo">
            <p class="topico-tema">${escapeHtml(t.tema)}</p>
            <div class="topico-opcoes">${t.opcoes.map((o) => `<span class="chip">${escapeHtml(o)}</span>`).join('')}</div>
          </div>
        </div>`)
    .join('');

  const importados = req.query.importados;
  const ignorados = req.query.ignorados;
  const bannerImportacao = importados !== undefined
    ? `<div class="aviso-sucesso">✅ ${escapeHtml(importados)} tópico(s) importado(s) com sucesso${ignorados && ignorados !== '0' ? ` — ${escapeHtml(ignorados)} linha(s) ignorada(s) por formato inválido` : ''}</div>`
    : '';

  const FASES = {
    normal: { emoji: '🟢', rotulo: 'Sem enquete hoje', classe: 'ticket--normal' },
    enquete: { emoji: '🗳️', rotulo: 'Enquete aberta', classe: 'ticket--enquete' },
    debate: { emoji: '🔥', rotulo: 'Debate ao vivo', classe: 'ticket--debate' }
  };
  const infoFase = FASES[estado.fase] || FASES.normal;

  res.send(`
    <!doctype html>
    <html lang="pt-BR">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Mesa de Debate</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
        <style>
          :root {
            --tinta: #1B2340; --papel: #EEF0F4; --superficie: #FFFFFF;
            --dourado: #C99A2E; --dourado-suave: #F3E6C6;
            --vermelho: #B23A2E; --verde: #3F7859; --verde-suave: #DCEBE2;
            --linha: #DADCE3;
          }
          * { box-sizing: border-box; }
          body { margin: 0; background: var(--papel); color: var(--tinta); font-family: 'IBM Plex Sans', -apple-system, sans-serif; -webkit-font-smoothing: antialiased; line-height: 1.5; }
          .envelope { max-width: 720px; margin: 0 auto; padding: 32px 20px 64px; }
          .cabecalho h1 { font-family: 'Fraunces', Georgia, serif; font-size: 30px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 4px; }
          .cabecalho p { margin: 0; color: #5B6178; font-size: 14px; }
          .ticket { position: relative; margin-top: 20px; background: var(--superficie); border: 1px solid var(--linha); border-left: 5px solid var(--cor-fase, var(--verde)); border-radius: 10px; padding: 16px 18px; display: flex; flex-direction: column; gap: 4px; }
          .ticket--normal { --cor-fase: var(--verde); }
          .ticket--enquete { --cor-fase: var(--dourado); }
          .ticket--debate { --cor-fase: var(--vermelho); }
          .ticket__selo { position: absolute; top: -14px; right: 16px; width: 40px; height: 40px; border-radius: 50%; background: var(--superficie); border: 2px dashed var(--cor-fase, var(--verde)); display: flex; align-items: center; justify-content: center; font-size: 18px; transform: rotate(-8deg); }
          .ticket__rotulo { font-family: 'Fraunces', Georgia, serif; font-size: 19px; font-weight: 600; }
          .ticket__detalhe { font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; color: #5B6178; }
          .aviso-sucesso { background: var(--verde-suave); border: 1px solid var(--verde); color: #1F4A34; padding: 12px 16px; border-radius: 10px; margin-top: 16px; font-size: 14px; }
          .cartao { background: var(--superficie); border: 1px solid var(--linha); border-radius: 12px; padding: 22px; margin-top: 20px; }
          .cartao__olho { font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--dourado); font-weight: 500; margin: 0 0 4px; }
          .cartao h2 { font-family: 'Fraunces', Georgia, serif; font-size: 20px; font-weight: 600; margin: 0 0 4px; }
          .cartao__legenda { font-size: 13px; color: #5B6178; margin: 0 0 18px; }
          .grade-campos { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px 16px; }
          .campo { display: flex; flex-direction: column; gap: 6px; }
          .campo--largo { grid-column: 1 / -1; }
          .campo label { font-size: 13px; font-weight: 500; }
          .campo input { font: inherit; font-size: 15px; padding: 10px 12px; border: 1px solid var(--linha); border-radius: 8px; background: var(--papel); color: var(--tinta); width: 100%; }
          .campo input:focus-visible { outline: 2px solid var(--dourado); outline-offset: 1px; background: var(--superficie); }
          .botao { font: inherit; font-weight: 600; font-size: 14px; padding: 11px 20px; border-radius: 8px; border: none; background: var(--tinta); color: #fff; cursor: pointer; margin-top: 18px; }
          .botao:hover { background: #10182E; }
          .botao:focus-visible { outline: 2px solid var(--dourado); outline-offset: 2px; }
          .botao--dourado { background: var(--dourado); color: #2B2106; }
          .botao--dourado:hover { background: #B48A28; }
          .lista-topicos { display: flex; flex-direction: column; gap: 10px; margin-bottom: 4px; }
          .topico-linha { display: flex; align-items: flex-start; gap: 12px; padding: 12px 14px; border: 1px solid var(--linha); border-radius: 10px; background: var(--papel); }
          .topico-linha--usado { opacity: 0.55; }
          .topico-status { font-size: 18px; line-height: 1; margin-top: 2px; }
          .topico-corpo { flex: 1; min-width: 0; }
          .topico-tema { font-weight: 500; font-size: 14.5px; margin: 0 0 6px; }
          .topico-opcoes { display: flex; flex-wrap: wrap; gap: 6px; }
          .chip { font-family: 'IBM Plex Mono', monospace; font-size: 12px; background: var(--dourado-suave); color: #6B4E14; padding: 3px 9px; border-radius: 999px; }
          .vazio { font-size: 14px; color: #5B6178; padding: 20px; text-align: center; border: 1px dashed var(--linha); border-radius: 10px; }
          .dica { font-size: 12.5px; color: #5B6178; margin: 0 0 16px; line-height: 1.5; }
          .dica code { background: var(--papel); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
          input[type="file"] { font: inherit; font-size: 13.5px; }
        </style>
      </head>
      <body>
        <div class="envelope">
          <header class="cabecalho">
            <h1>Mesa de Debate</h1>
            <p>Enquete e debate diário do grupo</p>
          </header>

          <div class="ticket ${infoFase.classe}">
            <span class="ticket__selo">${infoFase.emoji}</span>
            <span class="ticket__rotulo">${infoFase.rotulo}</span>
            ${estado.tema ? `<span class="ticket__detalhe">Tema: ${escapeHtml(estado.tema)}</span>` : ''}
            ${estado.terminaEm ? `<span class="ticket__detalhe">Termina em ${new Date(estado.terminaEm).toLocaleString('pt-BR')}</span>` : ''}
            <span class="ticket__detalhe">Última menção geral: ${estado.ultimaMencaoEm ? new Date(estado.ultimaMencaoEm).toLocaleString('pt-BR') : 'nunca'}</span>
          </div>

          ${bannerImportacao}

          <section class="cartao">
            <p class="cartao__olho">Configuração</p>
            <h2>Quando e como o ciclo roda</h2>
            <p class="cartao__legenda">O ciclo roda todo dia — esses campos ajustam horário, duração e a cadência da menção geral.</p>
            <form method="POST" action="/painel">
              <div class="grade-campos">
                <div class="campo campo--largo">
                  <label for="grupoId">ID do grupo</label>
                  <input id="grupoId" name="grupoId" value="${escapeHtml(cfg.grupoId)}" placeholder="123...@g.us">
                </div>
                <div class="campo">
                  <label for="horario">Horário diário</label>
                  <input id="horario" name="horario" value="${escapeHtml(cfg.horario)}" placeholder="20:00">
                </div>
                <div class="campo">
                  <label for="intervaloDiasMencao">Menciona geral a cada (dias)</label>
                  <input id="intervaloDiasMencao" name="intervaloDiasMencao" type="number" min="1" value="${cfg.intervaloDiasMencao}">
                </div>
                <div class="campo">
                  <label for="duracaoEnqueteHoras">Duração da enquete (h)</label>
                  <input id="duracaoEnqueteHoras" name="duracaoEnqueteHoras" type="number" min="0.5" step="0.5" value="${cfg.duracaoEnqueteHoras}">
                </div>
                <div class="campo">
                  <label for="duracaoDebateHoras">Duração do debate (h)</label>
                  <input id="duracaoDebateHoras" name="duracaoDebateHoras" type="number" min="0.5" step="0.5" value="${cfg.duracaoDebateHoras}">
                </div>
                <div class="campo">
                  <label for="minVotosDebate">Mínimo de votos pro debate</label>
                  <input id="minVotosDebate" name="minVotosDebate" type="number" min="1" value="${cfg.minVotosDebate}">
                </div>
              </div>
              <button class="botao" type="submit">Salvar configuração</button>
            </form>
          </section>

          <section class="cartao">
            <p class="cartao__olho">Banco de tópicos</p>
            <h2>Fila de enquetes</h2>
            <p class="cartao__legenda">${topicosEnquete.size} cadastrado(s) no total.</p>
            <div class="lista-topicos">
              ${linhasTopicos || '<div class="vazio">Nenhum tópico ainda — adicione um abaixo ou importe uma lista completa.</div>'}
            </div>
          </section>

          <section class="cartao">
            <p class="cartao__olho">Novo tópico</p>
            <h2>Adicionar um item na fila</h2>
            <p class="cartao__legenda">Um tópico por vez.</p>
            <form method="POST" action="/painel/topico">
              <div class="grade-campos">
                <div class="campo campo--largo">
                  <label for="tema">Tema ou pergunta</label>
                  <input id="tema" name="tema" required placeholder="IA vai substituir programadores?">
                </div>
                <div class="campo campo--largo">
                  <label for="opcoes">Opções (separadas por vírgula, mínimo 2)</label>
                  <input id="opcoes" name="opcoes" required placeholder="Sim, Não, Depende">
                </div>
              </div>
              <button class="botao" type="submit">Adicionar tópico</button>
            </form>
          </section>

          <section class="cartao">
            <p class="cartao__olho">Importação em lote</p>
            <h2>Subir vários tópicos de uma vez</h2>
            <p class="dica">
              Aceita <code>.json</code> (array de <code>{"tema": "...", "opcoes": ["...", "..."]}</code>)
              ou <code>.txt</code>/<code>.csv</code> com uma linha por tópico: <code>tema | opção 1, opção 2, opção 3</code>.
            </p>
            <div class="campo">
              <label for="arquivoTopicos">Arquivo</label>
              <input type="file" id="arquivoTopicos" accept=".json,.txt,.csv">
            </div>
            <form id="formImportar" onsubmit="return prepararImportacao(event)">
              <input type="hidden" name="conteudo" id="conteudoOculto">
              <button class="botao botao--dourado" type="submit">Importar tópicos</button>
            </form>
          </section>
        </div>
        <script>
          function prepararImportacao(ev) {
            ev.preventDefault();
            const input = document.getElementById('arquivoTopicos');
            const arquivo = input.files[0];
            if (!arquivo) { alert('Escolhe um arquivo primeiro.'); return false; }
            const leitor = new FileReader();
            leitor.onload = function () {
              document.getElementById('conteudoOculto').value = leitor.result;
              const form = document.getElementById('formImportar');
              form.method = 'POST';
              form.action = '/painel/topicos-arquivo';
              form.submit();
            };
            leitor.onerror = function () { alert('Não consegui ler o arquivo.'); };
            leitor.readAsText(arquivo);
            return false;
          }
        </script>
      </body>
    </html>
  `);
});

app.post('/painel', (req, res) => {
  const { grupoId, intervaloDiasMencao, horario, duracaoEnqueteHoras, duracaoDebateHoras, minVotosDebate } = req.body;
  configDebate.set({
    grupoId: (grupoId || '').trim(),
    intervaloDiasMencao: parseInt(intervaloDiasMencao, 10) || 7,
    horario: (horario || '20:00').trim(),
    duracaoEnqueteHoras: parseFloat(duracaoEnqueteHoras) || 1,
    duracaoDebateHoras: parseFloat(duracaoDebateHoras) || 1,
    minVotosDebate: parseInt(minVotosDebate, 10) || 6
  });
  res.redirect('/painel');
});

// Aceita JSON (array de {tema, opcoes}) OU texto linha a linha ("tema | opção 1, opção 2").
// Tenta JSON primeiro; se não for JSON válido, cai pro formato de linha.
function parseTopicosDeArquivo(conteudo) {
  const topicos = [];
  let ignorados = 0;

  try {
    const json = JSON.parse(conteudo);
    if (Array.isArray(json)) {
      for (const item of json) {
        const tema = (item?.tema || item?.pergunta || item?.titulo || item?.title || item?.question || '').toString().trim();
        const opcoesRaw = item?.opcoes ?? item?.['opções'] ?? item?.options ?? item?.alternativas;
        const opcoes = Array.isArray(opcoesRaw)
          ? opcoesRaw.map(String).map((o) => o.trim()).filter(Boolean)
          : [];
        if (tema && opcoes.length >= 2) topicos.push({ tema, opcoes });
        else ignorados++;
      }
      return { topicos, ignorados };
    }
  } catch {
    // não é JSON — cai pro formato linha a linha abaixo
  }

  const linhas = conteudo.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const linha of linhas) {
    const idx = linha.indexOf('|');
    if (idx === -1) { ignorados++; continue; }
    const tema = linha.slice(0, idx).trim();
    const opcoes = linha.slice(idx + 1).split(',').map((o) => o.trim()).filter(Boolean);
    if (tema && opcoes.length >= 2) topicos.push({ tema, opcoes });
    else ignorados++;
  }
  return { topicos, ignorados };
}

app.post('/painel/topicos-arquivo', (req, res) => {
  const conteudo = req.body?.conteudo;
  if (!conteudo) return res.redirect('/painel?importados=0');

  const { topicos, ignorados } = parseTopicosDeArquivo(conteudo);
  topicos.forEach((t, i) => {
    const id = `t${Date.now()}_${i}`;
    topicosEnquete.set(id, { tema: t.tema, opcoes: t.opcoes, usado: false, criadoEm: new Date().toISOString() });
  });
  if (topicos.length > 0) persistTopicos.agendarSalvar();

  res.redirect(`/painel?importados=${topicos.length}&ignorados=${ignorados}`);
});

app.post('/painel/topico', (req, res) => {
  const { tema, opcoes } = req.body;
  const listaOpcoes = (opcoes || '').split(',').map((o) => o.trim()).filter(Boolean);
  if (!tema?.trim() || listaOpcoes.length < 2) {
    return res.status(400).send('Precisa de um tema e pelo menos 2 opções separadas por vírgula.');
  }
  const id = `t${Date.now()}`;
  topicosEnquete.set(id, { tema: tema.trim(), opcoes: listaOpcoes, usado: false, criadoEm: new Date().toISOString() });
  persistTopicos.agendarSalvar();
  res.redirect('/painel');
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
  const { grupo_id, participant, remetente, regra } = req.body;
  if (!sock) return res.status(503).json({ erro: 'WhatsApp ainda não conectado' });
  if (!grupo_id || !participant) {
    return res.status(400).json({ erro: 'grupo_id e participant são obrigatórios' });
  }

  const chave = `${grupo_id}:${participant}`;
  const contagem = (violationCounts.get(chave) || 0) + 1;
  violationCounts.set(chave, contagem);
  persistViolacoes.agendarSalvar();

  let removido = false;

  if (contagem >= REMOVE_THRESHOLD) {
    try {
      await sock.groupParticipantsUpdate(grupo_id, [participant], 'remove');
      violationCounts.set(chave, 0);
      persistViolacoes.agendarSalvar();
      removido = true;
      const motivo = regra ? ` Regra violada: ${regra}.` : '';
      await enviarComDigitando(grupo_id, `⚠️ ${remetente || participant} foi removido do grupo automaticamente após atingir ${REMOVE_THRESHOLD} violações.${motivo}`);
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
