import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, downloadMediaMessage, decryptPollVote, jidNormalizedUser } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import pino from 'pino';
import express from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, unlink, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import crypto from 'crypto';

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

// true de segunda a sexta, false em sábado/domingo — sempre no fuso de São Paulo, não no do
// servidor (senão vira meia-noite virada perto da troca de dia e detecta o dia errado).
function éDiaDeSemana(data = new Date()) {
  const diaSemana = new Intl.DateTimeFormat('en-US', { timeZone: FUSO_HORARIO, weekday: 'short' }).format(data);
  return diaSemana !== 'Sat' && diaSemana !== 'Sun';
}

// Data local (YYYY-MM-DD) no mesmo fuso, pra comparar "quantos dias se passaram" por
// CALENDÁRIO, não por duração exata em horas. Duração exata (Date.now() - x) sofre de
// jitter: o ciclo roda a cada minuto, então dois disparos "diários" às vezes ficam a
// 23h59 uma da outra em vez de 24h certas, e "a cada 1 dia" falhava de vez em quando.
function dataLocalISO(data = new Date()) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO_HORARIO,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(data);
  const mapa = Object.fromEntries(partes.map((p) => [p.type, p.value]));
  return `${mapa.year}-${mapa.month}-${mapa.day}`;
}

// Calcula o PRÓXIMO horário de disparo uma vez só (olhando até 7 dias à frente), em vez de
// redescobrir "que dia é hoje" a cada minuto pra sempre. São Paulo não observa horário de verão
// desde 2019, então o offset -03:00 é fixo e seguro de usar direto na string ISO.
function calcularProximoDisparo(cfg, apartirDe = new Date()) {
  for (let diasAFrente = 0; diasAFrente <= 7; diasAFrente++) {
    const candidatoBase = new Date(apartirDe.getTime() + diasAFrente * 86_400_000);
    const dataISO = dataLocalISO(candidatoBase);
    const horarioAlvo = éDiaDeSemana(candidatoBase) ? cfg.horarioSemana : cfg.horario;
    const alvo = new Date(`${dataISO}T${horarioAlvo}:00-03:00`);
    if (alvo.getTime() > apartirDe.getTime()) return alvo;
  }
  return null; // não deveria acontecer (7 dias cobre qualquer configuração válida), só por segurança
}

function diasCalendarioEntre(dataMaisRecente, dataMaisAntiga) {
  const maisRecente = Date.parse(`${dataLocalISO(dataMaisRecente)}T00:00:00Z`);
  const maisAntiga = Date.parse(`${dataLocalISO(dataMaisAntiga)}T00:00:00Z`);
  return Math.round((maisRecente - maisAntiga) / 86_400_000);
}

// Números banidos e liberados pra divulgação agora moram em disco (editável pelo /contatos),
// não só na variável de ambiente. A variável de ambiente ainda é lida, mas só como semente na
// primeira execução — se o arquivo persistido já tem algo, ela é ignorada dali em diante.
function normalizarIdentificador(item) {
  const limpo = item.trim();
  if (limpo.includes('@')) return limpo; // já é um identificador completo (jid ou @lid), não mexe
  const somenteDigitos = limpo.replace(/\D/g, ''); // tira espaço, +, (), - etc — sobra só o número
  return `${somenteDigitos}@s.whatsapp.net`;
}

async function semearListaDoEnvSeVazia(persistStore, envVarNome, rotulo) {
  await persistStore.carregar();
  if (persistStore.mapa.size > 0) return; // já tem dado persistido — não sobrescreve com a env var
  const bruto = (process.env[envVarNome] || '').split(',').map((n) => n.trim()).filter(Boolean);
  if (bruto.length === 0) return;
  for (const item of bruto) {
    persistStore.mapa.set(normalizarIdentificador(item), { adicionadoEm: new Date().toISOString(), origem: 'env' });
  }
  persistStore.agendarSalvar();
  console.log(`${rotulo}: ${bruto.length} número(s) migrado(s) da variável de ambiente ${envVarNome} (só acontece uma vez, próxima execução já lê do arquivo).`);
}

// Remove sufixo de dispositivo do JID (ex: "5511999998888:12@s.whatsapp.net" -> "5511999998888")
function numeroBase(jid) {
  return jid.split('@')[0].split(':')[0];
}

// Confere se quem mandou a mensagem está numa lista — tenta o identificador direto,
// e se ele vier como @lid, também tenta resolver pro número de telefone correspondente
// (usando o mapeamento oficial do Baileys, populado depois que ele processa mensagens da pessoa).
// Aceita tanto Map quanto Set — .keys() devolve a mesma coisa (os identificadores) nos dois.
async function participantEstaNaLista(participantJid, listaMapaOuSet) {
  if (listaMapaOuSet.size === 0) return false;
  if (listaMapaOuSet.has(participantJid)) return true;

  if (participantJid.endsWith('@lid')) {
    if (!sock?.signalRepository?.lidMapping) return false;
    try {
      const pn = await sock.signalRepository.lidMapping.getPNForLID(participantJid);
      if (pn) {
        if (listaMapaOuSet.has(pn)) return true;
        const alvo = numeroBase(pn);
        for (const item of listaMapaOuSet.keys()) {
          if (numeroBase(item) === alvo) return true;
        }
      }
    } catch (err) {
      console.log('[CHECK-LISTA] Erro ao resolver @lid:', err.message);
    }
  }
  return false;
}

const persistBanidos = criarMapaPersistente('numeros-banidos.json'); // chave: identificador -> { adicionadoEm, origem }
const persistLiberados = criarMapaPersistente('numeros-liberados.json'); // mesma forma, pra divulgação
const persistProtegidos = criarMapaPersistente('numeros-protegidos.json'); // nunca sofrem ação do bot (apagar/violação/banimento)

// Semente única: número do dono do grupo, passado direto no chat em 31/07/2026. Só roda se a
// lista ainda estiver vazia — depois disso é 100% editável pelo /contatos, essa linha não repete.
async function garantirProtegidosDoDono() {
  await persistProtegidos.carregar();
  const identificadoresDono = ['5511986694787@s.whatsapp.net', '157728429347047@lid'];
  let mudou = false;
  for (const id of identificadoresDono) {
    if (!persistProtegidos.mapa.has(id)) {
      persistProtegidos.mapa.set(id, { adicionadoEm: new Date().toISOString(), origem: 'painel' });
      mudou = true;
    }
  }
  if (mudou) {
    persistProtegidos.agendarSalvar();
    console.log('Números protegidos: garantido que o dono está protegido nos dois formatos (número e @lid).');
  }
}

// IDs de mensagem já processadas, pra nunca reagir duas vezes à mesma mensagem.
const processedMessageIds = new Set();

// Timestamps recentes por pessoa, pra IA saber se ela está mandando mensagem em rajada.
const recentMessageTimestamps = new Map();

function contarMensagensRecentes(chave) {
  const agora = Date.now();
  const lista = (recentMessageTimestamps.get(chave) || []).filter((t) => agora - t < JANELA_FREQUENCIA_MS);
  lista.push(agora);
  recentMessageTimestamps.set(chave, lista);
  return lista.length;
}

// Helper genérico pra persistir um Map em disco, dentro do AUTH_FOLDER.
function criarMapaPersistente(nomeArquivo, { debounceMs = 2000 } = {}) {
  const mapa = new Map();
  const arquivo = path.join(AUTH_FOLDER, nomeArquivo);
  let carregado = false;
  let timer = null;

  async function carregar() {
    if (carregado) return;
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

  return { mapa, carregar, agendarSalvar, flush };
}

// Variante do helper acima pra um único objeto (não uma coleção por chave).
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
      valor = { ...valorPadrao, ...JSON.parse(bruto) };
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
const persistViolacoes = criarMapaPersistente('violations.json');
const violationCounts = persistViolacoes.mapa;

// Pessoas vistas mandando mensagem em algum grupo — alimenta a página /contatos.
const persistContatos = criarMapaPersistente('contatos.json');
const contatosVistos = persistContatos.mapa;

function registrarContatoVisto(participant, nome, grupoId, numero) {
  contatosVistos.set(participant, { nome, grupoId, numero, ultimaVez: new Date().toISOString() });
  persistContatos.agendarSalvar();
}

// --- Enquete/debate: configuração, tópicos, estado do ciclo e mensagens enviadas ---
const configDebate = criarValorPersistente('config-debate.json', {
  grupoId: '',
  horario: '20:00',
  horarioSemana: '20:00',
  intervaloDiasMencao: 7,
  duracaoEnqueteHoras: 1,
  duracaoDebateHoras: 1,
  minVotosDebate: 6
});

const estadoDebate = criarValorPersistente('estado-debate.json', {
  fase: 'normal',
  grupoId: null,
  tema: null,
  opcoes: [],
  terminaEm: null,
  pollMessageKey: null,
  votosAcumulados: [],
  votantesConhecidos: [],
  // --- contexto de decriptação, capturado na CRIAÇÃO da enquete (não uma hora depois) ---
  pollEncKeyB64: null,          // messageSecret em base64: atravessa JSON sem virar outra coisa
  pollOpcoesEnviadas: [],       // optionName exatos que saíram na mensagem (fonte da verdade do hash)
  pollCreatorCandidatos: [],    // formas possíveis do JID do bot NAQUELE grupo, em ordem de aposta
  pollCreatorConfirmado: null,  // preenchido no 1º voto que decriptar; usado primeiro nos demais
  ultimoCicloIniciadoEm: null,
  ultimaMencaoEm: null,
  topicoId: null,
  proximoDisparoEm: null
});

function atualizarProximoDisparo() {
  const cfg = configDebate.get();
  if (!cfg.grupoId) {
    estadoDebate.set({ proximoDisparoEm: null });
    return;
  }
  const proximo = calcularProximoDisparo(cfg, new Date());
  estadoDebate.set({ proximoDisparoEm: proximo ? proximo.toISOString() : null });
}

const persistTopicos = criarMapaPersistente('topicos-enquete.json');
const topicosEnquete = persistTopicos.mapa;

function escolherProximoTopico() {
  for (const [id, topico] of topicosEnquete) {
    if (!topico.usado) {
      topicosEnquete.set(id, { ...topico, usado: true });
      persistTopicos.agendarSalvar();
      return { id, ...topico, usado: true };
    }
  }
  return null;
}

const persistMensagensEnviadas = criarMapaPersistente('mensagens-enviadas.json');

// Garante que chaves e payloads lidos do arquivo JSON voltem a ser Buffer de verdade.
// Cobre TODAS as formas que bytes assumem depois de um JSON.stringify/parse:
//   Buffer            -> {"type":"Buffer","data":[...]}
//   Uint8Array        -> {"0":12,"1":255,...}   <- essa faltava e é silenciosa: garantirBuffer
//                        devolvia o objeto intacto, decryptPollVote recebia lixo e lançava.
//   base64 (string)   -> "AbC123..."
function garantirBuffer(val) {
  if (val === null || val === undefined) return val;
  if (Buffer.isBuffer(val)) return val;
  if (val instanceof Uint8Array) return Buffer.from(val);
  if (typeof val === 'string') return Buffer.from(val, 'base64');
  if (Array.isArray(val)) return Buffer.from(val);
  if (val.type === 'Buffer' && Array.isArray(val.data)) return Buffer.from(val.data);
  if (Array.isArray(val.data)) return Buffer.from(val.data);

  if (typeof val === 'object') {
    const chaves = Object.keys(val);
    if (chaves.length > 0 && chaves.every((k) => /^\d+$/.test(k))) {
      const bytes = new Array(chaves.length);
      let valido = true;
      for (const k of chaves) {
        const b = val[k];
        if (!Number.isInteger(b) || b < 0 || b > 255) { valido = false; break; }
        bytes[Number(k)] = b;
      }
      if (valido) return Buffer.from(bytes);
    }
  }
  return val;
}

// Bytes -> base64. Guardar chave/payload como string base64 no JSON elimina de vez o problema
// acima: string atravessa JSON.stringify sem se transformar em outra coisa.
function bytesParaBase64(val) {
  const buf = garantirBuffer(val);
  return Buffer.isBuffer(buf) ? buf.toString('base64') : null;
}

async function getMessage(key) {
  const registro = persistMensagensEnviadas.mapa.get(`${key.remoteJid}:${key.id}`);
  if (!registro) return undefined;
  // Garante que o messageSecret volte como Buffer real para o Baileys não descartar atualizações de enquete após restart
  if (registro.messageContextInfo?.messageSecret) {
    registro.messageContextInfo.messageSecret = garantirBuffer(registro.messageContextInfo.messageSecret);
  }
  return registro;
}

// Colapsa @lid e número numa chave só, usando a ponte que /contatos já mantém. Sem isso, a
// mesma pessoa aparecendo nas duas formas contaria como dois votantes e poderia disparar o
// debate sem gente suficiente de verdade.
function chaveDoVotante(jid) {
  if (!jid) return null;
  const info = contatosVistos.get(jid);
  if (info?.numero) return info.numero;
  return jid;
}

// Um mesmo voto chega por DOIS caminhos diferentes do Baileys:
//   messages.upsert -> pollUpdateMessage.vote = { encPayload, encIv }        (cifrado)
//   messages.update -> pollUpdates[].vote     = { selectedOptions: [...] }   (JÁ DECRIPTADO
//                                               pelo próprio Baileys)
// Os dois carregam o MESMO pollUpdateMessageKey.id. Antes, o último a chegar sobrescrevia o
// outro — quando o cifrado chegava por último, a decriptação pronta do Baileys era perdida.
// Agora os dois são mesclados pelo id da mensagem e nenhum campo preenchido é sobrescrito por vazio.
function acumularVotoSeguro(votoEntry, votanteJid) {
  if (!votanteJid) return;

  const idVoto = votoEntry.pollUpdateMessageKey?.id || votoEntry.key?.id;
  if (!idVoto) return;

  const estadoAgora = estadoDebate.get();
  const votos = [...(estadoAgora.votosAcumulados || [])];
  const anterior = votos.find((v) => v.id === idVoto) || null;

  const hashesNovos = Array.isArray(votoEntry.vote?.selectedOptions) && votoEntry.vote.selectedOptions.length > 0
    ? votoEntry.vote.selectedOptions.map((b) => garantirBuffer(b)?.toString('hex')).filter(Boolean)
    : null;

  const registro = {
    id: idVoto,
    votante: votanteJid,
    votanteChave: chaveDoVotante(votanteJid),
    ts: Number(votoEntry.senderTimestampMs || votoEntry.messageTimestamp || Date.now()),
    // bytes viram base64 na hora de guardar: string atravessa JSON.stringify intacta
    encPayloadB64: bytesParaBase64(votoEntry.vote?.encPayload) || anterior?.encPayloadB64 || null,
    encIvB64: bytesParaBase64(votoEntry.vote?.encIv) || anterior?.encIvB64 || null,
    hashesSelecionados: hashesNovos || anterior?.hashesSelecionados || null,
    opcaoResolvida: anterior?.opcaoResolvida || null
  };

  const indice = votos.findIndex((v) => v.id === idVoto);
  if (indice >= 0) votos[indice] = registro; else votos.push(registro);

  const conjuntoVotantes = new Set(votos.map((v) => v.votanteChave).filter(Boolean));

  estadoDebate.set({
    votosAcumulados: votos,
    votantesConhecidos: [...conjuntoVotantes]
  });

  // Decripta AGORA, não daqui a uma hora. Todo o material está fresco na memória (chave, socket
  // conectado, metadata do grupo) e o resultado fica gravado como texto puro no estado — a partir
  // daí, restart, remontagem de Buffer e estado interno do Baileys deixam de importar.
  resolverVotoAgora(idVoto);
}

for (const sinal of ['SIGTERM', 'SIGINT']) {
  process.on(sinal, async () => {
    console.log(`Sinal ${sinal} recebido — salvando dados antes de encerrar...`);
    await Promise.all([
      persistContatos.flush(),
      persistViolacoes.flush(),
      configDebate.flush(),
      estadoDebate.flush(),
      persistTopicos.flush(),
      persistMensagensEnviadas.flush(),
      persistBanidos.flush(),
      persistLiberados.flush(),
      persistProtegidos.flush()
    ]);
    process.exit(0);
  });
}

let sock;
let currentQR = null;
let isConnected = false;
let tickerDebateIniciado = false;

async function enviarComDigitando(jid, texto, mentions = []) {
  try {
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise((resolve) => setTimeout(resolve, 1200 + Math.random() * 1300));
    const mensagemEnviada = await sock.sendMessage(jid, mentions.length > 0 ? { text: texto, mentions } : { text: texto });
    await sock.sendPresenceUpdate('paused', jid);
    return mensagemEnviada;
  } catch (err) {
    console.error('Erro ao enviar mensagem com efeito de digitação:', err.message);
    throw err;
  }
}

// Descobre em quais formas o próprio bot aparece DENTRO daquele grupo. Em grupo @lid, o JID que
// a decriptação exige não é o número de telefone — e sock.user.id devolve o número. A groupMetadata
// é a verdade sobre aquele grupo, então ela vem primeiro na ordem de tentativa.
async function descobrirCandidatosCriadorNoGrupo(grupoId) {
  const candidatos = [];
  const add = (j) => { if (j && typeof j === 'string' && !candidatos.includes(j)) candidatos.push(j); };

  const basesDoBot = new Set();
  if (sock?.user?.id) basesDoBot.add(numeroBase(sock.user.id));
  if (sock?.user?.lid) basesDoBot.add(numeroBase(sock.user.lid));

  try {
    const metadata = await sock.groupMetadata(grupoId);
    for (const p of metadata?.participants || []) {
      const formas = [p.id, p.jid, p.lid, p.phoneNumber].filter((f) => typeof f === 'string');
      if (formas.some((f) => basesDoBot.has(numeroBase(f)))) {
        for (const f of formas) { add(seguroNormalizar(f)); add(f); }
      }
    }
  } catch (err) {
    console.error('Erro ao ler groupMetadata pra descobrir JID do bot no grupo:', err.message);
  }

  // Se este build do Baileys expuser o lidMapping, aproveita (o resto do projeto já checa assim).
  try {
    if (sock?.signalRepository?.lidMapping && sock?.user?.id) {
      const lid = await sock.signalRepository.lidMapping.getLIDForPN(seguroNormalizar(sock.user.id));
      if (lid) { add(seguroNormalizar(lid)); add(lid); }
    }
  } catch { /* build sem lidMapping: segue com o resto */ }

  if (sock?.user?.lid) { add(seguroNormalizar(sock.user.lid)); add(sock.user.lid); }
  if (sock?.user?.id) { add(seguroNormalizar(sock.user.id)); add(sock.user.id); }

  return candidatos;
}

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
      ? diasCalendarioEntre(new Date(), new Date(estadoAtual.ultimaMencaoEm))
      : Infinity;
    const deveMencionar = diasDesdeUltimaMencao >= cfg.intervaloDiasMencao;

    let jidsParaMencionar = [];
    if (deveMencionar) {
      const metadata = await sock.groupMetadata(cfg.grupoId);
      jidsParaMencionar = metadata.participants.map((p) => p.id);
    }

    const blocoMencoes = jidsParaMencionar.length > 0
      ? `\n\n${jidsParaMencionar.map((jid) => `@${jid.split('@')[0]}`).join(' ')}`
      : '';

    await enviarComDigitando(
      cfg.grupoId,
      `📊 Hora da enquete de hoje!\n\nFica aberta por ${cfg.duracaoEnqueteHoras}h. Se passar de ${cfg.minVotosDebate - 1} votos, o debate começa assim que ela fechar e dura mais ${cfg.duracaoDebateHoras}h. Vota aí 👇${blocoMencoes}`,
      jidsParaMencionar
    );

    const pollMsg = await sock.sendMessage(cfg.grupoId, {
      poll: { name: topico.tema, values: topico.opcoes, selectableCount: 1 }
    });
    persistMensagensEnviadas.mapa.set(`${pollMsg.key.remoteJid}:${pollMsg.key.id}`, pollMsg.message);
    persistMensagensEnviadas.agendarSalvar();

    // --- Contexto de decriptação, capturado agora, com tudo fresco ---
    const conteudoEnquete = pollMsg.message?.pollCreationMessage
      || pollMsg.message?.pollCreationMessageV2
      || pollMsg.message?.pollCreationMessageV3;

    const segredoEnquete = pollMsg.message?.messageContextInfo?.messageSecret
      || conteudoEnquete?.contextInfo?.messageSecret
      || null;
    const pollEncKeyB64 = bytesParaBase64(segredoEnquete);
    if (!pollEncKeyB64) {
      console.error('🔴 DIAGNÓSTICO ENQUETE: messageSecret NÃO veio na mensagem de enquete recém-criada. Nenhum voto vai decriptar neste ciclo.');
    }

    // Nome das opções como o WhatsApp realmente recebeu — é sobre ESSA string que o hash do voto
    // é calculado. Usar topico.opcoes seria aceitar qualquer diferença (espaço, acento, emoji)
    // introduzida no caminho.
    const pollOpcoesEnviadas = (conteudoEnquete?.options || [])
      .map((o) => o?.optionName)
      .filter((n) => typeof n === 'string' && n.length > 0);

    const pollCreatorCandidatos = await descobrirCandidatosCriadorNoGrupo(cfg.grupoId);
    console.log(`DIAGNÓSTICO ENQUETE: candidatos a JID de criador = [${pollCreatorCandidatos.join(', ')}]`);

    try {
      await sock.groupSettingUpdate(cfg.grupoId, 'announcement');
    } catch (err) {
      console.error('Erro ao ativar modo só-admin:', err.message);
    }
    try {
      await sock.groupJoinApprovalMode(cfg.grupoId, 'on');
    } catch (err) {
      console.error('Erro ao ligar aprovação de entrada no início da enquete:', err.message);
    }

    estadoDebate.set({
      fase: 'enquete',
      grupoId: cfg.grupoId,
      tema: topico.tema,
      opcoes: topico.opcoes,
      topicoId: topico.id,
      terminaEm: new Date(Date.now() + cfg.duracaoEnqueteHoras * 3600_000).toISOString(),
      pollMessageKey: { remoteJid: pollMsg.key.remoteJid, id: pollMsg.key.id },
      votosAcumulados: [],
      votantesConhecidos: [],
      pollEncKeyB64,
      pollOpcoesEnviadas: pollOpcoesEnviadas.length > 0 ? pollOpcoesEnviadas : topico.opcoes,
      // Aprendizado que vale a pena carregar entre ciclos: se numa enquete anterior uma forma
      // de JID decriptou, ela é a primeira aposta da próxima.
      pollCreatorConfirmado: estadoAtual.pollCreatorConfirmado || null,
      pollCreatorCandidatos,
      ultimoCicloIniciadoEm: new Date().toISOString(),
      ultimaMencaoEm: deveMencionar ? new Date().toISOString() : estadoAtual.ultimaMencaoEm,
      proximoDisparoEm: null
    });

    console.log(`Ciclo de debate iniciado: "${topico.tema}" em ${cfg.grupoId} (${deveMencionar ? 'com' : 'sem'} menção geral)`);
  } catch (err) {
    console.error('Erro ao iniciar ciclo de debate:', err.message);
  }
}

// Formas possíveis do JID do bot dentro daquele grupo. A decriptação exige a string EXATA que o
// servidor usou; em grupo @lid não é o número de telefone, e a v6.x não resolve isso sozinha.
// Ordem importa: a confirmada primeiro, depois a lida da groupMetadata (verdade daquele grupo).
function listaCandidatosCriador(estado) {
  const lista = [];
  const add = (j) => { if (j && typeof j === 'string' && !lista.includes(j)) lista.push(j); };

  add(estado.pollCreatorConfirmado);
  for (const c of estado.pollCreatorCandidatos || []) add(c);
  if (sock?.user?.lid) { add(seguroNormalizar(sock.user.lid)); add(sock.user.lid); }
  if (sock?.user?.id) { add(seguroNormalizar(sock.user.id)); add(sock.user.id); }
  return lista;
}

function seguroNormalizar(jid) {
  try { return jidNormalizedUser(jid); } catch { return jid; }
}

// Formas possíveis do votante: a que chegou, a ponte via /contatos nos dois sentidos, e as
// variações de sufixo do mesmo número base.
function listaCandidatosVotante(votanteJid) {
  const lista = [];
  const add = (j) => { if (j && typeof j === 'string' && !lista.includes(j)) lista.push(j); };

  add(votanteJid);
  add(seguroNormalizar(votanteJid));

  const info = contatosVistos.get(votanteJid);
  if (info?.numero) add(info.numero);
  for (const [idConhecido, dados] of contatosVistos) {
    if (dados?.numero && (dados.numero === votanteJid || idConhecido === votanteJid)) {
      add(idConhecido);
      add(dados.numero);
    }
  }

  const base = numeroBase(votanteJid);
  if (base) {
    add(`${base}@s.whatsapp.net`);
    add(`${base}@lid`);
  }
  return lista;
}

function opcaoPorHash(hashesEscolhidos, opcoesHash) {
  for (const [opcaoTexto, hashOpcao] of opcoesHash) {
    if (hashesEscolhidos.includes(hashOpcao)) return opcaoTexto;
  }
  return null;
}

// Monta, a partir do estado, tudo que a decriptação precisa. Tudo vem do estado-debate.json
// (gravado na criação da enquete), não de mensagens-enviadas.json — um arquivo a menos no
// caminho crítico, e a chave está em base64, imune ao round-trip de JSON.
function montarContextoEnquete(estado, pollEncKeyExterna = null) {
  const pollEncKey = garantirBuffer(estado.pollEncKeyB64) || garantirBuffer(pollEncKeyExterna);
  if (!Buffer.isBuffer(pollEncKey) || pollEncKey.length === 0) return null;
  if (!estado.pollMessageKey?.id) return null;

  const nomesOpcoes = (estado.pollOpcoesEnviadas?.length ? estado.pollOpcoesEnviadas : estado.opcoes) || [];
  const opcoesHash = nomesOpcoes.map((opcao) => [
    opcao,
    crypto.createHash('sha256').update(String(opcao), 'utf-8').digest('hex')
  ]);

  return { pollEncKey, pollMsgId: estado.pollMessageKey.id, opcoesHash };
}

// Descobre em qual opção a pessoa votou.
//
// Duas fontes, nesta ordem:
//   1. hashesSelecionados — o Baileys JÁ decriptou esse voto e entregou pronto. Antes esse campo
//      era simplesmente ignorado e o código ia direto tentar decryptPollVote num encPayload que
//      não existe nesse caminho: exceção garantida, voto contado como "não decriptou".
//   2. decriptação manual, varrendo as combinações de JID.
//
// Varrer combinação é seguro porque AES-GCM é AUTENTICADO: combinação errada falha na verificação
// da tag, não devolve texto plausível errado. Ou seja, não existe falso positivo aqui — só acerto
// verificado ou falha explícita.
function descobrirOpcaoDoVoto(registro, ctx) {
  if (registro.opcaoResolvida) {
    return { opcao: registro.opcaoResolvida, decriptou: true, via: 'cache', criador: null };
  }

  if (registro.hashesSelecionados?.length) {
    const opcao = opcaoPorHash(registro.hashesSelecionados, ctx.opcoesHash);
    if (opcao) return { opcao, decriptou: true, via: 'baileys', criador: null };
    console.warn('DIAGNÓSTICO ENQUETE: voto decriptado pelo Baileys, mas o hash não bate com nenhuma opção da enquete — texto da opção mudou depois do envio?');
    return { opcao: null, decriptou: true, via: 'baileys-hash-orfao', criador: null };
  }

  const encPayload = garantirBuffer(registro.encPayloadB64);
  const encIv = garantirBuffer(registro.encIvB64);
  if (!Buffer.isBuffer(encPayload) || !Buffer.isBuffer(encIv)) {
    return { opcao: null, decriptou: false, via: 'sem-payload', criador: null };
  }

  for (const pollCreatorJid of ctx.candidatosCriador) {
    for (const voterJid of listaCandidatosVotante(registro.votante)) {
      try {
        const voteMsg = decryptPollVote({ encPayload, encIv }, {
          pollCreatorJid,
          pollMsgId: ctx.pollMsgId,
          pollEncKey: ctx.pollEncKey,
          voterJid
        });
        const hashes = (voteMsg.selectedOptions || []).map((b) => garantirBuffer(b).toString('hex'));
        const opcao = opcaoPorHash(hashes, ctx.opcoesHash);
        return { opcao, decriptou: true, via: 'manual', criador: pollCreatorJid };
      } catch {
        // combinação errada: a tag do GCM rejeitou. Segue pra próxima.
      }
    }
  }
  return { opcao: null, decriptou: false, via: 'todas-combinacoes-falharam', criador: null };
}

// Tenta resolver UM voto no instante em que ele chega e grava o texto da opção no estado.
// Depois disso o voto está imune a restart, remontagem de Buffer e humor do Baileys.
function resolverVotoAgora(idVoto) {
  try {
    const estado = estadoDebate.get();
    const ctxBase = montarContextoEnquete(estado);
    if (!ctxBase) return;

    const votos = [...(estado.votosAcumulados || [])];
    const indice = votos.findIndex((v) => v.id === idVoto);
    if (indice < 0 || votos[indice].opcaoResolvida) return;

    const ctx = { ...ctxBase, candidatosCriador: listaCandidatosCriador(estado) };
    const resultado = descobrirOpcaoDoVoto(votos[indice], ctx);

    if (resultado.opcao) {
      votos[indice] = { ...votos[indice], opcaoResolvida: resultado.opcao };
      const patch = { votosAcumulados: votos };
      // Primeira combinação que funcionou vira a aposta principal dos próximos votos.
      if (resultado.criador && !estado.pollCreatorConfirmado) {
        patch.pollCreatorConfirmado = resultado.criador;
        console.log(`DIAGNÓSTICO ENQUETE: JID de criador que decripta confirmado = ${resultado.criador}`);
      }
      estadoDebate.set(patch);
      console.log(`Voto resolvido na hora (via ${resultado.via}): "${resultado.opcao}".`);
    } else {
      console.warn(`DIAGNÓSTICO ENQUETE: voto ${idVoto} ainda NÃO decriptou na chegada (via=${resultado.via}). Candidatos de criador tentados: ${ctx.candidatosCriador.join(', ') || 'nenhum'}.`);
    }
  } catch (err) {
    console.error('Erro ao tentar resolver voto na chegada:', err.message);
  }
}

async function resolverEnquete() {
  const estado = estadoDebate.get();
  const cfg = configDebate.get();
  let debateComeca = false;
  // Se não der pra apurar, usa a primeira opção como fallback de EXIBIÇÃO — mas sabemosVencedor
  // controla o texto do anúncio, pra nunca afirmar um vencedor específico sem ter certeza.
  let temaVencedor = estado.opcoes[0] || 'Tema geral';
  let sabemosVencedor = false;

  try {
    const mensagemCriacao = await getMessage(estado.pollMessageKey);
    const totalVotantes = new Set(estado.votantesConhecidos).size;
    console.log(`DIAGNÓSTICO ENQUETE: votantesConhecidos=${totalVotantes}, votosAcumulados.length=${estado.votosAcumulados.length}, mensagemCriacao encontrada=${!!mensagemCriacao}`);

    // A chave vem do estado (base64, gravada na criação). mensagemCriacao só entra como resgate
    // pra enquete que já estava aberta quando esta versão subiu.
    const ctxBase = montarContextoEnquete(estado, mensagemCriacao?.messageContextInfo?.messageSecret);

    if (!ctxBase) {
      console.error('🔴 DIAGNÓSTICO ENQUETE: sem chave de decriptação disponível (nem no estado, nem na mensagem de criação).');
    } else {
      try {
        const ctx = { ...ctxBase, candidatosCriador: listaCandidatosCriador(estado) };

        // Uma pessoa pode trocar de voto: cada troca é uma mensagem nova. Só a mais recente conta.
        const ultimoVotoPorPessoa = new Map();
        for (const registro of estado.votosAcumulados || []) {
          const chave = registro.votanteChave || registro.votante;
          if (!chave) continue;
          const atual = ultimoVotoPorPessoa.get(chave);
          if (!atual || (registro.ts || 0) >= (atual.ts || 0)) ultimoVotoPorPessoa.set(chave, registro);
        }

        const contagem = new Map();
        const naoResolvidos = [];
        let decriptados = 0;

        for (const registro of ultimoVotoPorPessoa.values()) {
          const resultado = descobrirOpcaoDoVoto(registro, ctx);
          if (resultado.decriptou) decriptados++;
          if (resultado.opcao) {
            contagem.set(resultado.opcao, (contagem.get(resultado.opcao) || 0) + 1);
          } else {
            naoResolvidos.push(`${registro.votante} (${resultado.via})`);
          }
        }

        console.log(`DIAGNÓSTICO ENQUETE: ${decriptados}/${ultimoVotoPorPessoa.size} voto(s) decriptado(s). Contagem por opção:`, JSON.stringify([...contagem]));
        if (naoResolvidos.length > 0) {
          console.error(`🔴 DIAGNÓSTICO ENQUETE: ${naoResolvidos.length} voto(s) sem opção resolvida — ${naoResolvidos.join(' | ')}`);
          console.error(`🔴 Candidatos de criador tentados: [${ctx.candidatosCriador.join(', ')}] | criador confirmado: ${estado.pollCreatorConfirmado || 'nenhum'}`);
        }

        if (contagem.size > 0) {
          const [opcaoVencedora] = [...contagem.entries()].reduce((a, b) => (b[1] > a[1] ? b : a));
          temaVencedor = opcaoVencedora;
          sabemosVencedor = true;
        }
      } catch (errDecrypt) {
        console.error('DIAGNÓSTICO ENQUETE: erro tentando decriptar votos —', errDecrypt.message);
      }
    }

    try {
      await sock.groupSettingUpdate(estado.grupoId, 'not_announcement');
    } catch (err) {
      console.error('Erro ao liberar mensagens do grupo:', err.message);
    }

    debateComeca = totalVotantes >= cfg.minVotosDebate;

    if (debateComeca) {
      let mensagemAnuncio = null;
      try {
        let jidsParaMencionar = [];
        try {
          const metadata = await sock.groupMetadata(estado.grupoId);
          jidsParaMencionar = metadata.participants.map((p) => p.id);
        } catch (err) {
          console.error('Erro ao buscar participantes pra mencionar no início do debate:', err.message);
        }
        const blocoMencoes = jidsParaMencionar.length > 0
          ? `\n\n${jidsParaMencionar.map((jid) => `@${jid.split('@')[0]}`).join(' ')}`
          : '';
        const textoAnuncio = sabemosVencedor
          ? `✅ ${totalVotantes} pessoas votaram — o tema mais votado foi *${temaVencedor}*. O debate começa agora e vai durar ${cfg.duracaoDebateHoras}h!${blocoMencoes}`
          : `✅ ${totalVotantes} pessoas votaram — não consegui confirmar qual opção teve mais votos, mas o debate começa agora sobre *${temaVencedor}* e vai durar ${cfg.duracaoDebateHoras}h!${blocoMencoes}`;
        mensagemAnuncio = await enviarComDigitando(estado.grupoId, textoAnuncio, jidsParaMencionar);
      } catch (err) {
        console.error('Erro ao anunciar início do debate:', err.message);
      }
      if (mensagemAnuncio) {
        try {
          await sock.sendMessage(estado.grupoId, { pin: { type: 1, time: 86400, key: mensagemAnuncio.key } });
          console.log('Mensagem de início do debate fixada.');
        } catch (err) {
          console.error('Erro ao fixar mensagem do debate:', err.message);
        }
      }
    } else {
      try {
        await enviarComDigitando(estado.grupoId, `📉 Só ${totalVotantes} voto(s) na enquete sobre *${estado.tema}* — não vai ter debate hoje.`);
      } catch (err) {
        console.error('Erro ao anunciar que não vai ter debate:', err.message);
      }
      try {
        await sock.groupJoinApprovalMode(estado.grupoId, 'off');
      } catch (err) {
        console.error('Erro ao desligar aprovação de entrada:', err.message);
      }
    }
  } catch (err) {
    console.error('Erro ao resolver enquete:', err.message);
  } finally {
    // pollCreatorConfirmado NÃO entra aqui de propósito: é o único campo que vale carregar
    // pro próximo ciclo.
    const limparEnquete = {
      pollMessageKey: null,
      votosAcumulados: [],
      votantesConhecidos: [],
      pollEncKeyB64: null,
      pollOpcoesEnviadas: [],
      pollCreatorCandidatos: []
    };

    if (debateComeca) {
      estadoDebate.set({
        ...limparEnquete,
        fase: 'debate',
        tema: temaVencedor,
        terminaEm: new Date(Date.now() + cfg.duracaoDebateHoras * 3600_000).toISOString()
      });
    } else {
      estadoDebate.set({ ...limparEnquete, fase: 'normal', tema: null, opcoes: [], terminaEm: null });
      atualizarProximoDisparo();
    }
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
    atualizarProximoDisparo();
  }
}

let processandoCicloDebate = false;
async function verificarCicloDebate() {
  if (!sock || !isConnected || processandoCicloDebate) return;
  processandoCicloDebate = true;
  try {
    const cfg = configDebate.get();
    const estado = estadoDebate.get();
    const agora = new Date();

    if (estado.fase === 'normal') {
      if (!cfg.grupoId) return;
      if (!estado.proximoDisparoEm) {
        atualizarProximoDisparo();
        return;
      }
      if (agora >= new Date(estado.proximoDisparoEm)) {
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

const ARQUIVOS_PROPRIOS_NO_AUTH_FOLDER = new Set([
  'contatos.json', 'violations.json', 'config-debate.json', 'estado-debate.json',
  'topicos-enquete.json', 'mensagens-enviadas.json', 'numeros-banidos.json', 'numeros-liberados.json'
]);

async function limparCredenciaisAntigasDoBaileys() {
  try {
    const arquivos = await readdir(AUTH_FOLDER);
    const paraApagar = arquivos.filter((nome) => !ARQUIVOS_PROPRIOS_NO_AUTH_FOLDER.has(nome));
    await Promise.all(paraApagar.map((nome) => unlink(path.join(AUTH_FOLDER, nome)).catch(() => {})));
    console.log(`Sessão antiga do Baileys limpa (${paraApagar.length} arquivo(s)) — dados do bot preservados. Gerando QR novo...`);
  } catch (err) {
    console.error('Erro ao limpar credenciais antigas do Baileys:', err.message);
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
    persistMensagensEnviadas.carregar(),
    semearListaDoEnvSeVazia(persistBanidos, 'NUMEROS_BANIDOS', 'Números banidos'),
    semearListaDoEnvSeVazia(persistLiberados, 'NUMEROS_LIBERADOS_DIVULGACAO', 'Números liberados pra divulgação'),
    garantirProtegidosDoDono()
  ]);
  if (estadoDebate.get().fase === 'normal' && !estadoDebate.get().proximoDisparoEm) {
    atualizarProximoDisparo();
  }
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
        setTimeout(connectToWhatsApp, 5000);
      } else {
        console.log(`Sessão desconectada (logout) — limpando credenciais antigas e reiniciando pra gerar um QR novo.`);
        await limparCredenciaisAntigasDoBaileys();
        setTimeout(connectToWhatsApp, 3000);
      }
    } else if (connection === 'open') {
      currentQR = null;
      isConnected = true;
      console.log('Conectado ao WhatsApp com sucesso.');
      if (!tickerDebateIniciado) {
        tickerDebateIniciado = true;
        setInterval(() => verificarCicloDebate().catch((err) => console.error('Erro no verificarCicloDebate:', err.message)), 60_000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      await processarMensagem(msg, type).catch((err) => console.error('Erro processando uma mensagem do lote:', err.message));
    }
  });

  sock.ev.on('group-participants.update', async (evento) => {
    if (evento.action !== 'add' || persistBanidos.mapa.size === 0) return;

    for (const participantJid of evento.participants) {
      if (await participantEstaNaLista(participantJid, persistProtegidos.mapa)) continue;
      if (await participantEstaNaLista(participantJid, persistBanidos.mapa)) {
        console.log('Número banido entrou no grupo — removendo:', participantJid, 'do grupo', evento.id);
        try {
          await sock.groupParticipantsUpdate(evento.id, [participantJid], 'remove');
        } catch (err) {
          console.error('Erro ao remover número banido:', err.message);
        }
      }
    }
  });

  sock.ev.on('messages.update', (updates) => {
    const estado = estadoDebate.get();
    if (estado.fase !== 'enquete' || !estado.pollMessageKey) {
      const temPollUpdate = updates.some(({ update }) => update?.pollUpdates);
      if (temPollUpdate) {
        console.log('DIAGNÓSTICO ENQUETE: pollUpdates via messages.update chegou, mas fase não é mais \'enquete\' (ou sem pollMessageKey) —',
          `fase=${estado.fase}`);
      }
      return;
    }

    for (const { key, update } of updates) {
      if (!update.pollUpdates) continue;
      if (key.id !== estado.pollMessageKey.id || key.remoteJid !== estado.pollMessageKey.remoteJid) {
        console.log('DIAGNÓSTICO ENQUETE: pollUpdates via messages.update NÃO bateu com a enquete atual —',
          `pollMessageKey.id=${estado.pollMessageKey.id}, key.id=${key.id}`);
        continue;
      }
      for (const u of update.pollUpdates) {
        const votanteJid = u.voterJid || u.pollUpdateMessageKey?.participant || u.pollUpdateMessageKey?.remoteJid;
        const jaDecriptado = Array.isArray(u.vote?.selectedOptions) && u.vote.selectedOptions.length > 0;
        console.log(`Voto via messages.update de ${votanteJid} — Baileys ${jaDecriptado ? 'JÁ decriptou (aproveitando)' : 'não decriptou, vai pro caminho manual'}.`);
        acumularVotoSeguro(u, votanteJid);
      }
      console.log(`Votos em enquete atualizados. Votantes únicos até agora: ${estadoDebate.get().votantesConhecidos.length}`);
    }
  });

  async function processarMensagem(msg, type) {
    if (!msg?.message) return;

    const msgId = msg.key.id;
    if (processedMessageIds.has(msgId)) {
      return;
    }
    processedMessageIds.add(msgId);
    if (processedMessageIds.size > 500) {
      processedMessageIds.delete(processedMessageIds.values().next().value);
    }

    if (msg.key.fromMe) return;

    const grupoId = msg.key.remoteJid;
    if (!grupoId || !grupoId.endsWith('@g.us')) {
      return;
    }

    const tipoConteudo = Object.keys(msg.message)[0];

    if (tipoConteudo === 'pollUpdateMessage') {
      // Roda incondicionalmente, não importa o "type" do lote (notify/append/o que for) — voto
      // dado enquanto a conexão caiu chega DEPOIS, na reconexão, como sincronização de histórico,
      // não como 'notify'. Enquete curta de teste quase nunca pega uma reconexão no meio; enquete
      // de 1h+ tem bem mais chance — é exatamente o padrão "só enquete longa falha" relatado.
      const estado = estadoDebate.get();
      const votoMsg = msg.message.pollUpdateMessage;
      const éDaEnqueteAtual = estado.fase === 'enquete' && estado.pollMessageKey
        && votoMsg?.pollCreationMessageKey?.id === estado.pollMessageKey.id;
      if (éDaEnqueteAtual) {
        try {
          const votanteJid = msg.key.participant || msg.participant || null;
          acumularVotoSeguro({
            pollUpdateMessageKey: msg.key,
            vote: votoMsg.vote,
            senderTimestampMs: votoMsg.senderTimestampMs,
            voterJid: votanteJid
          }, votanteJid);
          console.log(`Voto de enquete via messages.upsert acumulado (type=${type}). Votante: ${votanteJid}. Votantes únicos: ${estadoDebate.get().votantesConhecidos.length}`);
        } catch (err) {
          console.error('Erro ao acumular voto de enquete (via upsert):', err.message);
        }
      } else {
        console.log('DIAGNÓSTICO ENQUETE: pollUpdateMessage via upsert NÃO bateu com a enquete atual —',
          `type=${type}, fase=${estado.fase}, pollMessageKey.id=${estado.pollMessageKey?.id}, votoMsg.pollCreationMessageKey.id=${votoMsg?.pollCreationMessageKey?.id}`);
      }
      return;
    }

    // A partir daqui é fluxo de moderação normal — aí sim ignora histórico sincronizado (senão
    // reprocessa/modera mensagem antiga de novo toda vez que a conexão cai e volta).
    if (type !== 'notify') return;

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
      return;
    }

    const participant = msg.key.participant || grupoId;
    const remetente = msg.pushName || participant;
    const mensagensRecentes = contarMensagensRecentes(`${grupoId}:${participant}`);
    const podeDivulgar = await participantEstaNaLista(participant, persistLiberados.mapa);

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
        console.error('Erro ao baixar imagem:', err.message);
      }
    } else if (tipo === 'audio' || tipo === 'audio_voz') {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        audioBase64 = (await converterAudioParaMp3(buffer)).toString('base64');
      } catch (err) {
        console.error('Erro ao baixar/converter áudio:', err.message);
      }
    } else if (tipo === 'video') {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        framesBase64 = await extrairFramesDoVideo(buffer, duracaoSegundos);
        try {
          audioBase64 = (await extrairAudioDoVideo(buffer)).toString('base64');
        } catch (errAudio) {
          console.log('Vídeo sem áudio:', errAudio.message);
        }
      } catch (err) {
        console.error('Erro ao baixar/processar vídeo:', err.message);
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

    if (!N8N_WEBHOOK_URL) {
      return;
    }

    try {
      const resp = await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!resp.ok) {
        console.error(`n8n respondeu ${resp.status} ao receber a mensagem.`);
      }
    } catch (err) {
      console.error('Erro ao encaminhar mensagem pro n8n:', err.message);
    }
  }
}

connectToWhatsApp();

// --- Servidor HTTP ---

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

function escapeHtml(valor) {
  return String(valor ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function checkAuth(req, res, next) {
  if (!API_SECRET) {
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

app.get('/contatos', (req, res) => {
  const contatos = [...contatosVistos.entries()].sort((a, b) => new Date(b[1].ultimaVez) - new Date(a[1].ultimaVez));

  const linhasContatos = contatos
    .map(([id, info]) => {
      const estaBanido = persistBanidos.mapa.has(id);
      const estaLiberado = persistLiberados.mapa.has(id);
      const busca = `${info.nome} ${info.numero || ''} ${id}`.toLowerCase();
      let acoes = '';
      if (estaBanido) {
        acoes += `<span class="selo selo--vermelho">🚫 Banido</span>`;
      } else {
        acoes += `<form method="POST" action="/contatos/banir" class="form-inline"><input type="hidden" name="identificador" value="${id}"><button class="botao-mini botao-mini--vermelho" type="submit" title="Banir">🚫</button></form>`;
      }
      if (estaLiberado) {
        acoes += `<span class="selo selo--dourado">📣 Liberado</span>`;
      } else {
        acoes += `<form method="POST" action="/contatos/liberar" class="form-inline"><input type="hidden" name="identificador" value="${id}"><button class="botao-mini botao-mini--dourado" type="submit" title="Liberar pra divulgação">📣</button></form>`;
      }
      return `
      <tr data-busca="${escapeHtml(busca)}">
        <td>${escapeHtml(info.nome)}</td>
        <td><code class="copiavel" onclick="navigator.clipboard.writeText('${id}')" title="Clique pra copiar">${id}</code></td>
        <td>${info.numero || '—'}</td>
        <td>${info.grupoId}</td>
        <td>${new Date(info.ultimaVez).toLocaleString('pt-BR', { timeZone: FUSO_HORARIO })}</td>
        <td class="celula-acoes">${acoes}</td>
      </tr>`;
    })
    .join('');

  const linhasBanidos = [...persistBanidos.mapa.entries()]
    .map(([id, info]) => {
      const contato = contatosVistos.get(id);
      const nomeLinha = contato?.nome ? escapeHtml(contato.nome) : 'Nome desconhecido';
      const numeroLinha = contato?.numero ? ` · ${contato.numero}` : '';
      return `
      <div class="topico-linha">
        <div class="topico-corpo">
          <p class="topico-tema">${nomeLinha}${numeroLinha}</p>
          <p class="ticket__detalhe" style="margin:2px 0 4px;"><code class="copiavel" onclick="navigator.clipboard.writeText('${id}')">${id}</code></p>
          <span class="ticket__detalhe">Adicionado ${new Date(info.adicionadoEm).toLocaleString('pt-BR', { timeZone: FUSO_HORARIO })}${info.origem === 'env' ? ' · migrado da variável de ambiente' : ''}</span>
        </div>
        <form method="POST" action="/contatos/banir/remover"><input type="hidden" name="identificador" value="${id}"><button class="botao-secundario" type="submit">Remover</button></form>
      </div>`;
    })
    .join('');

  const linhasLiberados = [...persistLiberados.mapa.entries()]
    .map(([id, info]) => {
      const contato = contatosVistos.get(id);
      const nomeLinha = contato?.nome ? escapeHtml(contato.nome) : 'Nome desconhecido';
      const numeroLinha = contato?.numero ? ` · ${contato.numero}` : '';
      return `
      <div class="topico-linha">
        <div class="topico-corpo">
          <p class="topico-tema">${nomeLinha}${numeroLinha}</p>
          <p class="ticket__detalhe" style="margin:2px 0 4px;"><code class="copiavel" onclick="navigator.clipboard.writeText('${id}')">${id}</code></p>
          <span class="ticket__detalhe">Adicionado ${new Date(info.adicionadoEm).toLocaleString('pt-BR', { timeZone: FUSO_HORARIO })}${info.origem === 'env' ? ' · migrado da variável de ambiente' : ''}</span>
        </div>
        <form method="POST" action="/contatos/liberar/remover"><input type="hidden" name="identificador" value="${id}"><button class="botao-secundario" type="submit">Remover</button></form>
      </div>`;
    })
    .join('');

  const linhasProtegidos = [...persistProtegidos.mapa.entries()]
    .map(([id, info]) => {
      const contato = contatosVistos.get(id);
      const nomeLinha = contato?.nome ? escapeHtml(contato.nome) : 'Nome desconhecido';
      const numeroLinha = contato?.numero ? ` · ${contato.numero}` : '';
      return `
      <div class="topico-linha">
        <div class="topico-corpo">
          <p class="topico-tema">${nomeLinha}${numeroLinha}</p>
          <p class="ticket__detalhe" style="margin:2px 0 4px;"><code class="copiavel" onclick="navigator.clipboard.writeText('${id}')">${id}</code></p>
          <span class="ticket__detalhe">Protegido desde ${new Date(info.adicionadoEm).toLocaleString('pt-BR', { timeZone: FUSO_HORARIO })}</span>
        </div>
        <form method="POST" action="/contatos/proteger/remover"><input type="hidden" name="identificador" value="${id}"><button class="botao-secundario" type="submit">Remover</button></form>
      </div>`;
    })
    .join('');

  const aviso = req.query.aviso ? `<div class="aviso-sucesso">${escapeHtml(req.query.aviso)}</div>` : '';
  const bannerLink = req.query.link
    ? `<div class="aviso-sucesso">🔗 Se essa pessoa não estiver mais no grupo, manda esse link pra ela entrar de novo: <code class="copiavel" onclick="navigator.clipboard.writeText('${escapeHtml(req.query.link)}')">${escapeHtml(req.query.link)}</code></div>`
    : '';

  res.send(`
    <!doctype html>
    <html lang="pt-BR">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Pessoas vistas nos grupos</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
        <style>
          :root {
            --tinta: #1B2340; --papel: #EEF0F4; --superficie: #FFFFFF;
            --dourado: #C99A2E; --dourado-suave: #F3E6C6;
            --vermelho: #B23A2E; --vermelho-suave: #F4DCD8;
            --verde: #3F7859; --verde-suave: #DCEBE2;
            --linha: #DADCE3;
          }
          * { box-sizing: border-box; }
          body { margin: 0; background: var(--papel); color: var(--tinta); font-family: 'IBM Plex Sans', -apple-system, sans-serif; -webkit-font-smoothing: antialiased; line-height: 1.5; }
          .envelope { max-width: 900px; margin: 0 auto; padding: 32px 20px 64px; }
          .cabecalho h1 { font-family: 'Fraunces', Georgia, serif; font-size: 28px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 4px; }
          .cabecalho p { margin: 0; color: #5B6178; font-size: 14px; }
          .aviso-sucesso { background: var(--verde-suave); border: 1px solid var(--verde); color: #1F4A34; padding: 12px 16px; border-radius: 10px; margin-top: 16px; font-size: 14px; }
          .cartao { background: var(--superficie); border: 1px solid var(--linha); border-radius: 12px; padding: 22px; margin-top: 20px; }
          .cartao__olho { font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--dourado); font-weight: 500; margin: 0 0 4px; }
          .cartao h2 { font-family: 'Fraunces', Georgia, serif; font-size: 20px; font-weight: 600; margin: 0 0 4px; }
          .cartao__legenda { font-size: 13px; color: #5B6178; margin: 0 0 16px; }
          input[type="text"], .campo input { font: inherit; font-size: 15px; padding: 10px 12px; border: 1px solid var(--linha); border-radius: 8px; background: var(--papel); color: var(--tinta); width: 100%; }
          input:focus-visible { outline: 2px solid var(--dourado); outline-offset: 1px; background: var(--superficie); }
          .botao { font: inherit; font-weight: 600; font-size: 14px; padding: 11px 20px; border-radius: 8px; border: none; background: var(--tinta); color: #fff; cursor: pointer; margin-top: 12px; }
          .botao:hover { background: #10182E; }
          .botao-secundario { font: inherit; font-weight: 600; font-size: 12.5px; padding: 7px 12px; border-radius: 8px; border: 1px solid var(--vermelho); background: transparent; color: var(--vermelho); cursor: pointer; white-space: nowrap; }
          .botao-secundario:hover { background: #FBEAE7; }
          .botao-mini { font-size: 15px; padding: 5px 9px; border-radius: 7px; border: 1px solid var(--linha); background: var(--papel); cursor: pointer; line-height: 1; }
          .botao-mini--vermelho:hover { background: var(--vermelho-suave); border-color: var(--vermelho); }
          .botao-mini--dourado:hover { background: var(--dourado-suave); border-color: var(--dourado); }
          .form-inline { display: inline-block; margin-right: 6px; }
          .selo { display: inline-block; font-size: 11.5px; font-weight: 600; padding: 4px 9px; border-radius: 999px; margin-right: 6px; white-space: nowrap; }
          .selo--vermelho { background: var(--vermelho-suave); color: #7A2A20; }
          .selo--dourado { background: var(--dourado-suave); color: #6B4E14; }
          table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
          th { text-align: left; font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: #5B6178; padding: 8px 10px; border-bottom: 2px solid var(--linha); }
          td { padding: 10px; border-bottom: 1px solid var(--linha); vertical-align: middle; }
          tr:last-child td { border-bottom: none; }
          .copiavel { background: var(--papel); padding: 2px 7px; border-radius: 5px; font-family: 'IBM Plex Mono', monospace; font-size: 12px; cursor: pointer; }
          .celula-acoes { white-space: nowrap; }
          .tabela-scroll { overflow-x: auto; }
          .vazio { font-size: 14px; color: #5B6178; padding: 20px; text-align: center; border: 1px dashed var(--linha); border-radius: 10px; }
          .lista-topicos { display: flex; flex-direction: column; gap: 10px; margin-bottom: 4px; }
          .topico-linha { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border: 1px solid var(--linha); border-radius: 10px; background: var(--papel); }
          .topico-corpo { flex: 1; min-width: 0; }
          .topico-tema { font-weight: 500; font-size: 14.5px; margin: 0 0 4px; }
          .ticket__detalhe { font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #5B6178; }
          .grade-add { display: flex; gap: 10px; align-items: flex-end; }
          .grade-add .campo { flex: 1; }
          .dica { font-size: 12.5px; color: #5B6178; margin: 0 0 16px; }
        </style>
      </head>
      <body>
        <div class="envelope">
          <header class="cabecalho">
            <h1>Pessoas vistas nos grupos</h1>
            <p>Clique no identificador pra copiar. A coluna "Número" só aparece quando o WhatsApp expõe (nem sempre disponível).</p>
          </header>

          ${aviso}
          ${bannerLink}

          <section class="cartao">
            <p class="cartao__olho">Buscar</p>
            <h2>${contatos.length} pessoa(s) vista(s)</h2>
            <input type="text" id="busca" placeholder="Buscar por nome ou número..." oninput="filtrarContatos()" style="margin-bottom: 16px;">
            <div class="tabela-scroll">
              <table id="tabelaContatos">
                <tr><th>Nome</th><th>Identificador</th><th>Número</th><th>Grupo</th><th>Última mensagem</th><th>Ações</th></tr>
                ${linhasContatos}
              </table>
            </div>
            ${contatos.length === 0 ? '<div class="vazio">Ainda ninguém visto — peça pra alguém mandar uma mensagem em algum grupo.</div>' : ''}
            <p id="semResultado" class="vazio" style="display:none; margin-top: 12px;">Nenhum contato bate com essa busca.</p>
          </section>

          <section class="cartao">
            <p class="cartao__olho">Moderação</p>
            <h2>Números banidos</h2>
            <p class="cartao__legenda">Removidos automaticamente assim que entram em qualquer grupo.</p>
            <div class="lista-topicos">
              ${linhasBanidos || '<div class="vazio">Nenhum número banido ainda.</div>'}
            </div>
            <form method="POST" action="/contatos/banir" class="grade-add" style="margin-top: 16px;">
              <div class="campo">
                <label style="font-size:13px; font-weight:500;">Adicionar manualmente (número com DDI ou identificador completo)</label>
                <input type="text" name="identificador" placeholder="5511999998888" required>
              </div>
              <button class="botao" type="submit" style="margin-top:0;">Banir</button>
            </form>
          </section>

          <section class="cartao">
            <p class="cartao__olho">Moderação</p>
            <h2>Liberados pra divulgação</h2>
            <p class="cartao__legenda">Isentos da regra de spam/divulgação sem autorização.</p>
            <div class="lista-topicos">
              ${linhasLiberados || '<div class="vazio">Ninguém liberado ainda.</div>'}
            </div>
            <form method="POST" action="/contatos/liberar" class="grade-add" style="margin-top: 16px;">
              <div class="campo">
                <label style="font-size:13px; font-weight:500;">Adicionar manualmente (número com DDI ou identificador completo)</label>
                <input type="text" name="identificador" placeholder="5511999998888" required>
              </div>
              <button class="botao botao--dourado" type="submit" style="margin-top:0; background: var(--dourado); color:#2B2106;">Liberar</button>
            </form>
          </section>

          <section class="cartao">
            <p class="cartao__olho">Segurança</p>
            <h2>Números protegidos</h2>
            <p class="cartao__legenda">Nunca sofrem ação do bot — nem apagar mensagem, nem contar violação, nem remover, mesmo que também apareçam como banidos.</p>
            <div class="lista-topicos">
              ${linhasProtegidos || '<div class="vazio">Ninguém protegido ainda.</div>'}
            </div>
            <form method="POST" action="/contatos/proteger" class="grade-add" style="margin-top: 16px;">
              <div class="campo">
                <label style="font-size:13px; font-weight:500;">Adicionar manualmente (número com DDI ou identificador completo)</label>
                <input type="text" name="identificador" placeholder="5511999998888" required>
              </div>
              <button class="botao" type="submit" style="margin-top:0; background: var(--verde);">Proteger</button>
            </form>
          </section>
        </div>
        <script>
          function filtrarContatos() {
            const termo = document.getElementById('busca').value.trim().toLowerCase();
            const linhas = document.querySelectorAll('#tabelaContatos tr[data-busca]');
            let visiveis = 0;
            linhas.forEach((linha) => {
              const bate = linha.dataset.busca.includes(termo);
              linha.style.display = bate ? '' : 'none';
              if (bate) visiveis++;
            });
            document.getElementById('semResultado').style.display = (termo && visiveis === 0) ? 'block' : 'none';
          }
        </script>
      </body>
    </html>
  `);
});

app.post('/contatos/banir', (req, res) => {
  const identificador = normalizarIdentificador(req.body.identificador || '');
  if (!identificador || identificador === '@s.whatsapp.net') return res.status(400).send('Identificador inválido.');
  if (persistProtegidos.mapa.has(identificador)) {
    return res.redirect(`/contatos?aviso=${encodeURIComponent('🛡️ Esse número está protegido — remova a proteção antes de banir.')}`);
  }
  persistBanidos.mapa.set(identificador, { adicionadoEm: new Date().toISOString(), origem: 'painel' });
  persistBanidos.agendarSalvar();

  (async () => {
    const info = contatosVistos.get(identificador);
    if (info?.grupoId && sock) {
      try {
        await sock.groupParticipantsUpdate(info.grupoId, [identificador], 'remove');
      } catch (err) {
        console.error('Ban manual: erro ao remover do grupo:', err.message);
      }
    }
  })();

  res.redirect(`/contatos?aviso=${encodeURIComponent('🚫 Adicionado à lista de banidos.')}`);
});

app.post('/contatos/banir/remover', (req, res) => {
  const identificador = req.body.identificador || '';
  persistBanidos.mapa.delete(identificador);
  persistBanidos.agendarSalvar();
  res.redirect(`/contatos?aviso=${encodeURIComponent('Removido da lista de banidos.')}`);
});

app.post('/contatos/liberar', async (req, res) => {
  const identificador = normalizarIdentificador(req.body.identificador || '');
  if (!identificador || identificador === '@s.whatsapp.net') return res.status(400).send('Identificador inválido.');
  persistLiberados.mapa.set(identificador, { adicionadoEm: new Date().toISOString(), origem: 'painel' });
  persistLiberados.agendarSalvar();

  if (persistBanidos.mapa.has(identificador)) {
    persistBanidos.mapa.delete(identificador);
    persistBanidos.agendarSalvar();
  }

  const info = contatosVistos.get(identificador);
  const grupoId = info?.grupoId;
  let link = null;

  if (grupoId && sock) {
    try {
      const codigo = await sock.groupInviteCode(grupoId);
      link = `https://chat.whatsapp.com/${codigo}`;
    } catch (err) {
      console.error('Liberar: erro ao pegar link de convite:', err.message);
    }
    try {
      await enviarComDigitando(grupoId, `✅ ${info?.nome || identificador} liberado pra divulgação por autorização do admin`);
    } catch (err) {
      console.error('Liberar: erro ao anunciar no grupo:', err.message);
    }
  }

  const params = new URLSearchParams({ aviso: '📣 Liberado pra divulgação.' });
  if (link) params.set('link', link);
  res.redirect(`/contatos?${params.toString()}`);
});

app.post('/contatos/liberar/remover', (req, res) => {
  const identificador = req.body.identificador || '';
  persistLiberados.mapa.delete(identificador);
  persistLiberados.agendarSalvar();
  res.redirect(`/contatos?aviso=${encodeURIComponent('Removido da lista de liberados.')}`);
});

app.post('/contatos/proteger', (req, res) => {
  const identificador = normalizarIdentificador(req.body.identificador || '');
  if (!identificador || identificador === '@s.whatsapp.net') return res.status(400).send('Identificador inválido.');
  persistProtegidos.mapa.set(identificador, { adicionadoEm: new Date().toISOString(), origem: 'painel' });
  persistProtegidos.agendarSalvar();
  res.redirect(`/contatos?aviso=${encodeURIComponent('🛡️ Protegido — o bot nunca vai apagar, contar violação ou remover esse número.')}`);
});

app.post('/contatos/proteger/remover', (req, res) => {
  const identificador = req.body.identificador || '';
  persistProtegidos.mapa.delete(identificador);
  persistProtegidos.agendarSalvar();
  res.redirect(`/contatos?aviso=${encodeURIComponent('Proteção removida.')}`);
});

app.get('/painel', (req, res) => {
  const cfg = configDebate.get();
  const estado = estadoDebate.get();

  const linhasTopicos = [...topicosEnquete.entries()]
    .map(([id, t]) => `
        <div class="topico-linha${t.usado ? ' topico-linha--usado' : ''}">
          <form method="POST" action="/painel/topico/marcar" style="margin:0;">
            <input type="hidden" name="id" value="${id}">
            <input type="hidden" name="usado" value="${t.usado ? '0' : '1'}">
            <button type="submit" class="checkbox-topico" title="${t.usado ? 'Marcar como não usado' : 'Marcar como usado'}">${t.usado ? '✅' : '⬜'}</button>
          </form>
          <div class="topico-corpo">
            <p class="topico-tema">${escapeHtml(t.tema)}</p>
            <div class="topico-opcoes">${t.opcoes.map((o) => `<span class="chip">${escapeHtml(o)}</span>`).join('')}</div>
          </div>
        </div>`)
    .join('');
  const totalUsados = [...topicosEnquete.values()].filter((t) => t.usado).length;

  const importados = req.query.importados;
  const ignorados = req.query.ignorados;
  const bannerImportacao = importados !== undefined
    ? `<div class="aviso-sucesso">✅ ${escapeHtml(importados)} tópico(s) importado(s) com sucesso${ignorados && ignorados !== '0' ? ` — ${escapeHtml(ignorados)} linha(s) ignorada(s) por formato inválido` : ''}</div>`
    : '';
  const bannerReset = req.query.resetado !== undefined
    ? `<div class="aviso-sucesso">🔄 Ciclo resetado — grupo liberado e de volta pro normal.</div>`
    : '';
  const bannerTopicosResetados = req.query.topicosResetados !== undefined
    ? `<div class="aviso-sucesso">🔄 Todos os tópicos voltaram pra fila (nenhum marcado como usado).</div>`
    : '';
  const bannerTopicosApagados = req.query.topicosApagados !== undefined
    ? `<div class="aviso-sucesso">🗑️ ${escapeHtml(req.query.topicosApagados)} tópico(s) apagado(s) da lista.</div>`
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
          .botao-secundario { font: inherit; font-weight: 600; font-size: 12.5px; padding: 7px 12px; border-radius: 8px; border: 1px solid var(--vermelho); background: transparent; color: var(--vermelho); cursor: pointer; margin-top: 12px; }
          .botao-secundario:hover { background: #FBEAE7; }
          .botao-secundario:focus-visible { outline: 2px solid var(--vermelho); outline-offset: 2px; }
          .acoes-topicos { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; }
          .acoes-topicos .botao-secundario { margin-top: 0; }
          .lista-topicos { display: flex; flex-direction: column; gap: 10px; margin-bottom: 4px; }
          .topico-linha { display: flex; align-items: flex-start; gap: 12px; padding: 12px 14px; border: 1px solid var(--linha); border-radius: 10px; background: var(--papel); }
          .topico-linha--usado { opacity: 0.55; }
          .topico-status { font-size: 18px; line-height: 1; margin-top: 2px; }
          .checkbox-topico { font-size: 18px; line-height: 1; margin-top: 2px; background: none; border: none; padding: 4px; border-radius: 6px; cursor: pointer; }
          .checkbox-topico:hover { background: var(--papel); }
          .checkbox-topico:focus-visible { outline: 2px solid var(--dourado); outline-offset: 1px; }
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
            ${estado.terminaEm ? `<span class="ticket__detalhe">Termina em ${new Date(estado.terminaEm).toLocaleString('pt-BR', { timeZone: FUSO_HORARIO })}</span>` : ''}
            ${estado.fase === 'normal' && estado.proximoDisparoEm ? `<span class="ticket__detalhe">Próxima enquete em ${new Date(estado.proximoDisparoEm).toLocaleString('pt-BR', { timeZone: FUSO_HORARIO })}</span>` : ''}
            <span class="ticket__detalhe">Última menção geral: ${estado.ultimaMencaoEm ? new Date(estado.ultimaMencaoEm).toLocaleString('pt-BR', { timeZone: FUSO_HORARIO }) : 'nunca'}</span>
            <form method="POST" action="/painel/resetar" onsubmit="return confirm('Resetar? Libera o grupo se estiver preso em enquete/debate, devolve o tópico em andamento pra fila (se houver) e zera a marca de última menção geral, pra poder testar de novo mesmo depois de um ciclo já ter terminado.')">
              <button class="botao-secundario" type="submit">↺ Resetar ciclo (uso em teste)</button>
            </form>
          </div>

          ${bannerImportacao}
          ${bannerReset}
          ${bannerTopicosResetados}
          ${bannerTopicosApagados}

          <section class="cartao">
            <p class="cartao__olho">Configuração</p>
            <h2>Quando e como o ciclo roda</h2>
            <p class="cartao__legenda">O ciclo roda todo dia — horário muda sozinho conforme o dia da semana (detecção automática), o resto dos campos vale pros dois casos.</p>
            <form method="POST" action="/painel">
              <div class="grade-campos">
                <div class="campo campo--largo">
                  <label for="grupoId">ID do grupo</label>
                  <input id="grupoId" name="grupoId" value="${escapeHtml(cfg.grupoId)}" placeholder="123...@g.us">
                </div>
                <div class="campo">
                  <label for="horarioSemana">Horário de seg. a sex.</label>
                  <input id="horarioSemana" name="horarioSemana" value="${escapeHtml(cfg.horarioSemana)}" placeholder="20:00">
                </div>
                <div class="campo">
                  <label for="horario">Horário no sábado/domingo</label>
                  <input id="horario" name="horario" value="${escapeHtml(cfg.horario)}" placeholder="20:00">
                </div>
                <div class="campo">
                  <label for="intervaloDiasMencao">Menciona geral a cada (dias)</label>
                  <input id="intervaloDiasMencao" name="intervaloDiasMencao" type="number" min="1" value="${cfg.intervaloDiasMencao}">
                </div>
                <div class="campo">
                  <label for="duracaoEnqueteHoras">Duração da enquete (h)</label>
                  <input id="duracaoEnqueteHoras" name="duracaoEnqueteHoras" type="number" min="0.01" step="0.01" value="${cfg.duracaoEnqueteHoras}">
                </div>
                <div class="campo">
                  <label for="duracaoDebateHoras">Duração do debate (h)</label>
                  <input id="duracaoDebateHoras" name="duracaoDebateHoras" type="number" min="0.01" step="0.01" value="${cfg.duracaoDebateHoras}">
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
            <p class="cartao__legenda">${topicosEnquete.size} cadastrado(s) no total — ${totalUsados} já usado(s).</p>
            <div class="acoes-topicos">
              ${totalUsados > 0 ? `
              <form method="POST" action="/painel/topicos/resetar" onsubmit="return confirm('Marcar todos os ${topicosEnquete.size} tópicos como não usados de novo? Eles continuam na lista.')">
                <button class="botao-secundario" type="submit">↺ Marcar todos como não usados (${totalUsados} → fila)</button>
              </form>` : ''}
              ${topicosEnquete.size > 0 ? `
              <form method="POST" action="/painel/topicos/apagar" onsubmit="return confirm('Apagar TODOS os ${topicosEnquete.size} tópicos da lista? Isso não pode ser desfeito — vai precisar reimportar o arquivo.')">
                <button class="botao-secundario" type="submit">🗑️ Apagar todos os tópicos</button>
              </form>` : ''}
            </div>
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
  const { grupoId, intervaloDiasMencao, horario, horarioSemana, duracaoEnqueteHoras, duracaoDebateHoras, minVotosDebate } = req.body;
  configDebate.set({
    grupoId: (grupoId || '').trim(),
    intervaloDiasMencao: parseInt(intervaloDiasMencao, 10) || 7,
    horario: (horario || '20:00').trim(),
    horarioSemana: (horarioSemana || '20:00').trim(),
    duracaoEnqueteHoras: parseFloat(duracaoEnqueteHoras) || 1,
    duracaoDebateHoras: parseFloat(duracaoDebateHoras) || 1,
    minVotosDebate: parseInt(minVotosDebate, 10) || 6
  });
  if (estadoDebate.get().fase === 'normal') atualizarProximoDisparo();
  res.redirect('/painel');
});

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
    // não é JSON
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

app.post('/painel/topico/marcar', (req, res) => {
  const { id, usado } = req.body;
  if (!id || !topicosEnquete.has(id)) return res.status(400).send('Tópico não encontrado.');
  topicosEnquete.set(id, { ...topicosEnquete.get(id), usado: usado === '1' });
  persistTopicos.agendarSalvar();
  res.redirect('/painel');
});

app.post('/painel/topicos/resetar', (req, res) => {
  let alterados = 0;
  for (const [id, topico] of topicosEnquete) {
    if (topico.usado) {
      topicosEnquete.set(id, { ...topico, usado: false });
      alterados++;
    }
  }
  if (alterados > 0) persistTopicos.agendarSalvar();
  res.redirect('/painel?topicosResetados=1');
});

app.post('/painel/topicos/apagar', (req, res) => {
  const quantidade = topicosEnquete.size;
  topicosEnquete.clear();
  persistTopicos.agendarSalvar();
  res.redirect(`/painel?topicosApagados=${quantidade}`);
});

app.post('/painel/resetar', async (req, res) => {
  const estado = estadoDebate.get();

  if (estado.grupoId && sock) {
    try {
      await sock.groupSettingUpdate(estado.grupoId, 'not_announcement');
    } catch (err) {
      console.error('Reset: erro ao tirar o grupo do modo announcement:', err.message);
    }
    try {
      await sock.groupJoinApprovalMode(estado.grupoId, 'off');
    } catch (err) {
      console.error('Reset: erro ao desligar aprovação de entrada:', err.message);
    }
  }

  if (estado.topicoId && topicosEnquete.has(estado.topicoId)) {
    topicosEnquete.set(estado.topicoId, { ...topicosEnquete.get(estado.topicoId), usado: false });
    persistTopicos.agendarSalvar();
  }

  estadoDebate.set({
    fase: 'normal',
    tema: null,
    opcoes: [],
    terminaEm: null,
    pollMessageKey: null,
    votosAcumulados: [],
    votantesConhecidos: [],
    pollEncKeyB64: null,
    pollOpcoesEnviadas: [],
    pollCreatorCandidatos: [],
    topicoId: null,
    ultimaMencaoEm: null
  });
  atualizarProximoDisparo();

  res.redirect('/painel?resetado=1');
});

app.post('/apagar', checkAuth, async (req, res) => {
  const { grupo_id, message_id, participant } = req.body;
  if (!sock) return res.status(503).json({ erro: 'WhatsApp ainda não conectado' });

  if (await participantEstaNaLista(participant, persistProtegidos.mapa)) {
    console.log('Apagar bloqueado: participante protegido —', participant);
    return res.json({ ok: true, ignorado: 'participante protegido' });
  }

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

  if (await participantEstaNaLista(participant, persistProtegidos.mapa)) {
    console.log('Violação ignorada: participante protegido —', participant);
    return res.json({ ok: true, ignorado: 'participante protegido', contagem: 0 });
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
      console.error('Erro ao remover participante:', err.message);
      return res.status(500).json({ erro: err.message, contagem });
    }
  }

  res.json({ ok: true, contagem, removido });
});

app.listen(PORT, () => {
  console.log(`Servidor HTTP rodando na porta ${PORT}`);
});
