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

// Primeira coisa que sai no log. Se essa linha aparecer várias vezes em poucos minutos, o processo
// está morrendo e sendo ressuscitado — isso NÃO é boot normal, por mais que no fim funcione.
const INICIADO_EM = Date.now();
console.log(`[BOOT] pid=${process.pid} | node=${process.version} | cwd=${process.cwd()} | AUTH_FOLDER=${AUTH_FOLDER} | ${new Date(INICIADO_EM).toISOString()}`);
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

// Memória de "até onde eu já vi" que sobrevive a restart. Sem isso, mensagem que chega enquanto
// o Railway reinicia é entregue de novo como sincronização de histórico e o bot descarta em
// silêncio — e processedMessageIds, que só existe em memória, some junto.
const marcaDagua = criarValorPersistente('marca-dagua-mensagens.json', {
  ultimoTimestamp: 0,   // segundos; messageTimestamp da mensagem mais nova já processada
  idsProcessados: []    // últimos ids processados, pra dedup atravessar o restart
});

// Teto de resgate: mensagem mais velha que isso não é moderada mesmo chegando por histórico.
// Evita que uma perda do volume vire uma avalanche de moderação retroativa.
const HORAS_RESGATE = Number(process.env.HORAS_RESGATE_MENSAGENS || 24);

// Histórico de moderação: cada aviso, exclusão, violação, remoção e banimento vira um evento.
// Sem isso não existe "por que essa pessoa foi banida" — hoje o /registrar-violacao recebe a
// regra, usa no texto do aviso e joga fora, e o texto da mensagem nunca sai do processarMensagem.
// Regras do grupo, cadastradas aqui pra que o painel consiga traduzir "Regra 3" no texto da
// regra. O n8n só devolve o número; sem esse cadastro, o número sozinho não diz nada a quem lê.
const persistRegras = criarValorPersistente('regras.json', { regras: [], textoBruto: '' });

const historicoModeracao = criarValorPersistente('historico-moderacao.json', { eventos: [] });
const MAX_EVENTOS_HISTORICO = 400;

// Últimas mensagens vistas, pra recuperar o texto na hora em que o n8n manda apagar/punir.
// Fica só em memória de propósito: gravar cada mensagem do grupo em disco seria I/O demais, e a
// punição chega segundos depois da mensagem. Se o processo reiniciar nesse meio, o texto some —
// por isso os endpoints também aceitam `texto` no corpo, pra quem quiser garantia total.
const mensagensRecentes = new Map();
const MAX_MENSAGENS_CACHE = 400;

function guardarMensagemRecente(grupoId, participant, messageId, texto, tipo) {
  const registro = { messageId, texto: texto || '', tipo, quando: new Date().toISOString() };
  if (messageId) mensagensRecentes.set(`msg:${grupoId}:${messageId}`, registro);
  if (participant) mensagensRecentes.set(`autor:${grupoId}:${participant}`, registro);
  while (mensagensRecentes.size > MAX_MENSAGENS_CACHE) {
    mensagensRecentes.delete(mensagensRecentes.keys().next().value);
  }
}

function buscarMensagemRecente(grupoId, participant, messageId) {
  return mensagensRecentes.get(`msg:${grupoId}:${messageId}`)
    || mensagensRecentes.get(`autor:${grupoId}:${participant}`)
    || null;
}

function registrarEventoModeracao(evento) {
  const anteriores = historicoModeracao.get().eventos || [];
  const completo = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    quando: new Date().toISOString(),
    ...evento
  };
  historicoModeracao.set({ eventos: [...anteriores, completo].slice(-MAX_EVENTOS_HISTORICO) });
  return completo;
}

// Último motivo conhecido de uma pessoa — é o que a tela de banidos mostra ao lado do nome.
//
// O n8n dispara "Apagar mensagem" e "Registrar violação" em ramos separados, sem ordem garantida.
// Só o segundo carrega a regra. Se o de apagar chegar por último, uma busca ingênua pelo evento
// mais recente devolveria um evento sem regra e o cartão diria "Sem regra registrada" — mesmo
// com a regra tendo sido registrada segundos antes, na mesma punição.
// Por isso: primeiro procura um evento que tenha regra E texto; se não houver, compõe a partir do
// evento mais recente que tem regra e do mais recente que tem texto.
function ultimoMotivoDe(identificador) {
  const eventos = historicoModeracao.get().eventos || [];
  let comRegra = null;
  let comTexto = null;

  for (let i = eventos.length - 1; i >= 0; i--) {
    const e = eventos[i];
    if (e.participant !== identificador) continue;

    const temRegra = e.regra !== null && e.regra !== undefined && e.regra !== '';
    const temTexto = !!(e.texto && e.texto.trim());

    if (temRegra && temTexto) return e;
    if (temRegra && !comRegra) comRegra = e;
    if (temTexto && !comTexto) comTexto = e;
  }

  if (!comRegra && !comTexto) return null;
  return {
    ...(comTexto || {}),
    ...(comRegra || {}),
    texto: comTexto?.texto || '',
    tipo: comTexto?.tipo || comRegra?.tipo || null
  };
}

// Histórico de boots. É o que separa "deploy normal" de "crash-loop": deploy dá 1 boot, crash-loop
// dá vários seguidos com poucos segundos entre eles.
const historicoBoots = criarValorPersistente('boots.json', { boots: [] });

async function registrarBoot() {
  await historicoBoots.carregar();
  const anteriores = historicoBoots.get().boots || [];
  const agora = Date.now();
  const boots = [...anteriores, agora].slice(-50);
  historicoBoots.set({ boots });
  await historicoBoots.flush();

  const ultimo = anteriores[anteriores.length - 1];
  const ultimas24h = boots.filter((b) => agora - b < 24 * 3600_000).length;
  const intervalo = ultimo ? Math.round((agora - ultimo) / 1000) : null;

  console.log(`[BOOT] Boot nº ${boots.length} registrado. Anterior: ${intervalo === null ? 'nenhum' : `há ${intervalo}s`}. Boots nas últimas 24h: ${ultimas24h}.`);

  if (intervalo !== null && intervalo < 120) {
    console.error(`🔴 [BOOT] Menos de 2 min desde o boot anterior — isso é crash-loop, não deploy. Procure no log a linha [CRASH] ou o erro do Railway logo antes desta.`);
  }
  if (ultimas24h > 10) {
    console.error(`🔴 [BOOT] ${ultimas24h} boots em 24h. Cada um é uma janela em que o bot está cego. Vale investigar.`);
  }
}

function registrarMensagemVista(msgId, tsMsg) {
  const atual = marcaDagua.get();
  const ids = [...atual.idsProcessados, msgId];
  marcaDagua.set({
    ultimoTimestamp: Math.max(atual.ultimoTimestamp || 0, tsMsg || 0),
    idsProcessados: ids.length > 500 ? ids.slice(-500) : ids
  });
}

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

// --- Como o WhatsApp realmente embrulha uma mensagem ---
//
// `Object.keys(msg.message)[0]` parece o tipo da mensagem, mas não é. O WhatsApp envelopa o
// conteúdo real em várias camadas, e às vezes coloca metadado ANTES dele:
//
//   { senderKeyDistributionMessage: {...}, conversation: "oi" }
//        ^ primeira chave é isso, não 'conversation'
//
// Esse envelope aparece justamente quando alguém ENTRA no grupo e as chaves do grupo são
// redistribuídas — ou seja, exatamente na hora em que a moderação mais importa, porque é quando
// spammer novo chega. Também aparece em mensagem temporária (ephemeralMessage), de visualização
// única (viewOnce*), documento com legenda e mensagem editada — nesses, o conteúdo real está
// ANINHADO uma camada abaixo.
//
// Implementado aqui em vez de importado do Baileys de propósito: se um build não exportar a
// função, um import nomeado quebra o boot inteiro. Isso é a mesma lógica, sem esse risco.
function normalizarConteudo(conteudo) {
  let atual = conteudo;
  for (let i = 0; i < 5 && atual; i++) {
    const interno = atual.ephemeralMessage
      || atual.viewOnceMessage
      || atual.viewOnceMessageV2
      || atual.viewOnceMessageV2Extension
      || atual.documentWithCaptionMessage
      || atual.editedMessage;
    if (!interno?.message) break;
    atual = interno.message;
  }
  return atual;
}

// Acha a chave que é conteúdo de verdade, pulando os metadados.
function tipoDoConteudo(conteudo) {
  if (!conteudo) return null;
  const ignorar = new Set(['senderKeyDistributionMessage', 'messageContextInfo']);
  return Object.keys(conteudo).find((k) => !ignorar.has(k) && (k === 'conversation' || k.includes('Message'))) || null;
}

// messageTimestamp vem como número ou como Long do protobuf ({low, high}). Em segundos.
function timestampDaMensagem(msg) {
  const bruto = msg?.messageTimestamp;
  if (bruto === null || bruto === undefined) return 0;
  if (typeof bruto === 'number') return bruto;
  if (typeof bruto === 'string') return Number(bruto) || 0;
  if (typeof bruto.toNumber === 'function') return bruto.toNumber();
  if (typeof bruto.low === 'number') return bruto.low;
  return 0;
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
// Cada troca de voto é uma mensagem nova, então a lista cresce enquanto a enquete estiver de pé —
// e ela é reescrita em disco a cada 2s. Numa enquete de horas com gente trocando de opção isso vira
// I/O à toa. Guarda, por pessoa, só o voto mais recente + o mais recente que JÁ decriptou (quando
// são diferentes): o segundo é a rede de segurança pro caso do mais novo não decriptar.
function podarVotos(votos) {
  const porPessoa = new Map();
  for (const v of votos) {
    const chave = v.votanteChave || v.votante;
    if (!chave) continue;
    if (!porPessoa.has(chave)) porPessoa.set(chave, []);
    porPessoa.get(chave).push(v);
  }

  const mantidos = [];
  for (const lista of porPessoa.values()) {
    const ordenada = [...lista].sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const maisRecente = ordenada[0];
    mantidos.push(maisRecente);
    const resolvidoMaisRecente = ordenada.find((v) => v.opcaoResolvida);
    if (resolvidoMaisRecente && resolvidoMaisRecente !== maisRecente) mantidos.push(resolvidoMaisRecente);
  }
  return mantidos;
}

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

  // Poda só depois de resolver, pra nunca descartar um voto antes de tentar decriptá-lo.
  // votantesConhecidos é recalculado à parte e não encolhe: a poda mantém pelo menos um
  // registro por pessoa.
  const depois = estadoDebate.get();
  const podados = podarVotos(depois.votosAcumulados || []);
  if (podados.length !== (depois.votosAcumulados || []).length) {
    estadoDebate.set({ votosAcumulados: podados });
  }
}

// Salva tudo. Antes isso só existia dentro do handler de SIGTERM — ou seja, um crash de verdade
// (exceção não tratada, promise rejeitada) matava o processo sem passar por aqui e levava junto
// até 2s de estado: voto recém-chegado, contato novo, contagem de violação.
async function flushTudo() {
  await Promise.all([
    persistContatos.flush(),
    persistViolacoes.flush(),
    configDebate.flush(),
    estadoDebate.flush(),
    persistTopicos.flush(),
    persistMensagensEnviadas.flush(),
    marcaDagua.flush(),
    historicoModeracao.flush(),
    persistRegras.flush(),
    persistBanidos.flush(),
    persistLiberados.flush(),
    persistProtegidos.flush()
  ]);
}

// Um crash aqui não é "normal": o processo morre e o Railway sobe outro. Sem esses handlers, o
// motivo do crash pode nem aparecer no log — e é justamente ele que você precisa ler.
for (const evento of ['uncaughtException', 'unhandledRejection']) {
  process.on(evento, async (err) => {
    console.error(`🔴 [CRASH] ${evento}:`, err?.stack || err?.message || err);
    try {
      await flushTudo();
      console.error('🔴 [CRASH] Estado salvo antes de encerrar.');
    } catch (errFlush) {
      console.error('🔴 [CRASH] Falhou até ao salvar o estado:', errFlush.message);
    }
    process.exit(1);
  });
}

for (const sinal of ['SIGTERM', 'SIGINT']) {
  process.on(sinal, async () => {
    console.log(`Sinal ${sinal} recebido — salvando dados antes de encerrar...`);
    await flushTudo();
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
  const estadoInicial = estadoDebate.get();
  const cfg = configDebate.get();
  let debateComeca = false;
  // Se não der pra apurar, usa a primeira opção como fallback de EXIBIÇÃO — mas sabemosVencedor
  // controla o texto do anúncio, pra nunca afirmar um vencedor específico sem ter certeza.
  let temaVencedor = estadoInicial.opcoes[0] || 'Tema geral';
  let sabemosVencedor = false;

  try {
    const mensagemCriacao = await getMessage(estadoInicial.pollMessageKey);

    // estadoDebate.set() troca o objeto inteiro, então um snapshot tirado antes de um await
    // fica velho. Um voto que chegue nessa fresta sumiria da contagem — só acontece em enquete
    // com gente votando até o último segundo, ou seja, exatamente a enquete longa.
    const estado = estadoDebate.get();
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

// Tudo que é DADO DO BOT (não credencial do Baileys) precisa estar aqui, senão a limpeza de
// sessão por logout apaga junto. 'numeros-protegidos.json' estava faltando: um logout zerava a
// lista de protegidos — inclusive o dono do grupo, que voltaria a poder sofrer ação do bot.
const ARQUIVOS_PROPRIOS_NO_AUTH_FOLDER = new Set([
  'contatos.json', 'violations.json', 'config-debate.json', 'estado-debate.json',
  'topicos-enquete.json', 'mensagens-enviadas.json', 'numeros-banidos.json', 'numeros-liberados.json',
  'numeros-protegidos.json', 'marca-dagua-mensagens.json', 'boots.json', 'historico-moderacao.json', 'regras.json'
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
    marcaDagua.carregar(),
    historicoModeracao.carregar(),
    persistRegras.carregar(),
    registrarBoot(),
    semearListaDoEnvSeVazia(persistBanidos, 'NUMEROS_BANIDOS', 'Números banidos'),
    semearListaDoEnvSeVazia(persistLiberados, 'NUMEROS_LIBERADOS_DIVULGACAO', 'Números liberados pra divulgação'),
    garantirProtegidosDoDono()
  ]);
  // Sem isso, dedup zera a cada restart e a mesma mensagem pode ser moderada duas vezes.
  for (const id of marcaDagua.get().idsProcessados || []) processedMessageIds.add(id);

  // Primeiro boot depois do deploy: o arquivo não existe e a marca vem 0. Com marca 0, TODA
  // mensagem das últimas 24h que chegar por sincronização entraria na janela de resgate — o bot
  // acordaria moderando (e possivelmente apagando/banindo) coisa velha que você já resolveu na
  // mão. Começar a marca em "agora" faz o resgate valer só daqui pra frente.
  if (!marcaDagua.get().ultimoTimestamp) {
    marcaDagua.set({ ultimoTimestamp: Math.floor(Date.now() / 1000) });
    console.log('Marca d\'água inicializada em "agora" — nenhuma mensagem anterior a este boot será moderada retroativamente.');
  }

  const marca = marcaDagua.get();
  console.log(`Marca d'água carregada: última mensagem vista em ${marca.ultimoTimestamp ? new Date(marca.ultimoTimestamp * 1000).toISOString() : 'nunca'}, ${processedMessageIds.size} id(s) no dedup. Janela de resgate: ${HORAS_RESGATE}h.`);

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
    // Fotografa o teto ANTES do lote: dentro de um mesmo lote de sincronização as mensagens
    // podem vir fora de ordem, e comparar contra um teto que sobe a cada item descartaria a
    // mensagem mais antiga do próprio lote.
    const tetoDoLote = marcaDagua.get().ultimoTimestamp || 0;
    for (const msg of messages) {
      await processarMensagem(msg, type, tetoDoLote).catch((err) => console.error('Erro processando uma mensagem do lote:', err.message));
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

// Mensagem com BOTÃO não é imageMessage nem conversation. O WhatsApp usa containers próprios
// (templateMessage, interactiveMessage, buttonsMessage, listMessage...) que guardam o texto, a
// imagem e os botões aninhados lá dentro. Spam de divulgação usa exatamente esses formatos, porque
// é o que renderiza o botão de "GO"/CTA — e nenhum deles estava na lista de tipos tratados, então
// a mensagem caía no `else` e ia embora sem chegar na moderação.
//
// Aqui o texto todo é achatado num blob só, incluindo o texto e a URL dos botões: é na URL que
// mora a divulgação, e sem ela a IA não tem como julgar.
function extrairTextoDeContainer(conteudo, tipoConteudo) {
  const partes = [];
  const add = (v) => { if (typeof v === 'string' && v.trim()) partes.push(v.trim()); };

  if (tipoConteudo === 'templateMessage') {
    const t = conteudo.templateMessage || {};
    const modelo = t.hydratedTemplate || t.hydratedFourRowTemplate || t.fourRowTemplate || {};
    add(modelo.hydratedTitle);
    add(modelo.hydratedContentText);
    add(modelo.hydratedFooterText);
    add(modelo.imageMessage?.caption);
    add(modelo.videoMessage?.caption);
    add(modelo.documentMessage?.caption);
    for (const b of modelo.hydratedButtons || []) {
      add(b.urlButton?.displayText); add(b.urlButton?.url);
      add(b.callButton?.displayText); add(b.callButton?.phoneNumber);
      add(b.quickReplyButton?.displayText);
    }
  } else if (tipoConteudo === 'interactiveMessage') {
    const i = conteudo.interactiveMessage || {};
    add(i.header?.title); add(i.header?.subtitle); add(i.header?.imageMessage?.caption);
    add(i.body?.text); add(i.footer?.text);
    for (const b of i.nativeFlowMessage?.buttons || []) { add(b.name); add(b.buttonParamsJson); }
  } else if (tipoConteudo === 'buttonsMessage') {
    const b = conteudo.buttonsMessage || {};
    add(b.contentText); add(b.footerText); add(b.imageMessage?.caption); add(b.documentMessage?.caption);
    for (const bt of b.buttons || []) add(bt.buttonText?.displayText);
  } else if (tipoConteudo === 'listMessage') {
    const l = conteudo.listMessage || {};
    add(l.title); add(l.description); add(l.footerText); add(l.buttonText);
    for (const s of l.sections || []) {
      add(s.title);
      for (const r of s.rows || []) { add(r.title); add(r.description); }
    }
  } else if (tipoConteudo === 'productMessage') {
    const p = conteudo.productMessage?.product || {};
    add(p.title); add(p.description); add(p.url); add(p.retailerId);
  } else if (tipoConteudo === 'groupInviteMessage') {
    const g = conteudo.groupInviteMessage || {};
    add(g.groupName); add(g.caption);
    if (g.inviteCode) add(`https://chat.whatsapp.com/${g.inviteCode}`);
  } else {
    return null;
  }

  return partes.length > 0 ? partes.join('\n') : null;
}

  async function processarMensagem(msg, type, tetoDoLote) {
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

    // Desembrulha os envelopes do WhatsApp ANTES de olhar o tipo. Ver normalizarConteudo().
    const conteudo = normalizarConteudo(msg.message);
    const tipoConteudo = tipoDoConteudo(conteudo);
    const tsMsg = timestampDaMensagem(msg);

    if (tipoConteudo === 'pollUpdateMessage') {
      // Roda incondicionalmente, não importa o "type" do lote (notify/append/o que for) — voto
      // dado enquanto a conexão caiu chega DEPOIS, na reconexão, como sincronização de histórico,
      // não como 'notify'. Enquete curta de teste quase nunca pega uma reconexão no meio; enquete
      // de 1h+ tem bem mais chance — é exatamente o padrão "só enquete longa falha" relatado.
      const estado = estadoDebate.get();
      const votoMsg = conteudo.pollUpdateMessage;
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

    // Mensagem que chegou enquanto o processo estava fora volta na reconexão como sincronização
    // de histórico, não como 'notify'. O corte cego em `type !== 'notify'` descartava essas em
    // silêncio — é a cegueira a restart. Mas moderar histórico inteiro toda reconexão também não
    // serve. Critério: só entra o que é MAIS NOVO que a última mensagem já processada, e mesmo
    // assim só dentro da janela de resgate.
    if (type !== 'notify') {
      const agoraSeg = Math.floor(Date.now() / 1000);
      if (!tsMsg) {
        console.log(`[RESGATE] Ignorada: type=${type} sem messageTimestamp. id=${msgId}`);
        return;
      }
      if (tsMsg <= tetoDoLote) return;  // já era conhecida antes da queda
      if (agoraSeg - tsMsg > HORAS_RESGATE * 3600) {
        console.log(`[RESGATE] Ignorada por idade (${Math.round((agoraSeg - tsMsg) / 3600)}h): type=${type}, id=${msgId}`);
        return;
      }
      console.log(`[RESGATE] Mensagem perdida no restart, moderando agora: type=${type}, id=${msgId}, ${agoraSeg - tsMsg}s atrás.`);
    }

    let tipo = null;
    let texto = '';
    let duracaoSegundos = null;

    if (tipoConteudo === 'conversation') {
      tipo = 'texto';
      texto = conteudo.conversation || '';
    } else if (tipoConteudo === 'extendedTextMessage') {
      tipo = 'texto';
      texto = conteudo.extendedTextMessage?.text || '';
    } else if (tipoConteudo === 'imageMessage') {
      tipo = 'imagem';
      texto = conteudo.imageMessage?.caption || '';
    } else if (tipoConteudo === 'videoMessage') {
      tipo = 'video';
      texto = conteudo.videoMessage?.caption || '';
      duracaoSegundos = conteudo.videoMessage?.seconds ?? null;
    } else if (tipoConteudo === 'audioMessage') {
      tipo = conteudo.audioMessage?.ptt ? 'audio_voz' : 'audio';
      duracaoSegundos = conteudo.audioMessage?.seconds ?? null;
    } else if (tipoConteudo === 'stickerMessage') {
      tipo = 'figurinha';
    } else if (tipoConteudo === 'documentMessage') {
      tipo = 'documento';
      texto = conteudo.documentMessage?.caption || '';
    } else {
      // Antes de desistir: mensagem com botão/template guarda o conteúdo aninhado num container.
      const textoContainer = extrairTextoDeContainer(conteudo, tipoConteudo);
      if (textoContainer) {
        tipo = 'texto';
        texto = textoContainer;
        console.log(`[CONTAINER] ${tipoConteudo} (mensagem com botão/CTA) — texto extraído e enviado pra moderação. id=${msgId}`);
      } else {
        // Tipos que não são conteúdo de usuário (protocolMessage, reaction, etc.) passam por aqui
        // o tempo todo — mas se for algo com texto que a gente não trata, o log abaixo é a única
        // forma de descobrir. Antes esse `return` era mudo e a mensagem simplesmente sumia.
        const silenciosos = new Set(['protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage', 'messageContextInfo', 'pollCreationMessage', null]);
        if (!silenciosos.has(tipoConteudo)) {
          console.log(`[NÃO MODERADA] Tipo não tratado: ${tipoConteudo} | chaves do envelope: ${Object.keys(msg.message).join(',')} | id=${msgId}`);
        }
        return;
      }
    }

    registrarMensagemVista(msgId, tsMsg);

    // Guarda o texto pra poder mostrar depois "foi isso que causou o banimento". O n8n só devolve
    // grupo_id/participant/regra — sem esse cache, o motivo do ban seria sempre um vazio.
    guardarMensagemRecente(grupoId, msg.key.participant || msg.key.remoteJid, msgId, texto, tipo);

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
        midiaMimeType = conteudo.imageMessage?.mimetype || 'image/jpeg';
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

// --- Casca compartilhada das páginas do painel ---
//
// Antes cada rota carregava seu próprio <head>, sua própria paleta e sua própria tipografia:
// três cópias do mesmo CSS. Mudar uma cor exigia mudar em três lugares e lembrar dos três.
// Agora existe uma casca só, com o menu, e cada página entrega só o miolo.
//
// O CSS específico da página entra DEPOIS do base de propósito: onde os dois definirem a mesma
// classe, o da página vence — é por isso que a migração não mexeu na aparência de nada.
const MENU_PAINEL = [
  { href: '/painel', rotulo: 'Mesa de Debate', icone: '🗳️' },
  { href: '/contatos', rotulo: 'Contatos', icone: '👥' },
  { href: '/banidos', rotulo: 'Banidos', icone: '🚫' }
];

function paginaHtml({ titulo, ativo, largura = 860, cssExtra = '', corpo, scriptExtra = '' }) {
  const menu = MENU_PAINEL
    .map((item) => `<a href="${item.href}" class="${ativo === item.href ? 'ativo' : ''}"><span aria-hidden="true">${item.icone}</span>${item.rotulo}</a>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(titulo)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --tinta: #1B2340; --papel: #EEF0F4; --superficie: #FFFFFF;
      --dourado: #C99A2E; --dourado-suave: #F3E6C6;
      --vermelho: #B23A2E; --vermelho-suave: #F4DCD8;
      --verde: #3F7859; --verde-suave: #DCEBE2;
      --linha: #DADCE3; --apagado: #5B6178;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--papel); color: var(--tinta); font-family: 'IBM Plex Sans', -apple-system, sans-serif; -webkit-font-smoothing: antialiased; line-height: 1.5; }
    .envelope { max-width: ${largura}px; margin: 0 auto; padding: 18px 20px 64px; }

    .menu { display: flex; gap: 6px; overflow-x: auto; padding: 4px 0 14px; margin-bottom: 18px; border-bottom: 1px solid var(--linha); -webkit-overflow-scrolling: touch; scrollbar-width: none; }
    .menu::-webkit-scrollbar { display: none; }
    .menu a { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; font-size: 13.5px; font-weight: 500; text-decoration: none; color: var(--apagado); background: var(--superficie); border: 1px solid var(--linha); padding: 8px 15px; border-radius: 999px; transition: border-color .12s, color .12s; }
    .menu a:hover { border-color: var(--tinta); color: var(--tinta); }
    .menu a.ativo { background: var(--tinta); border-color: var(--tinta); color: #fff; }
    .menu a span { font-size: 14px; }

    .cabecalho h1 { font-family: 'Fraunces', Georgia, serif; font-size: 28px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 4px; }
    .cabecalho p { margin: 0; color: var(--apagado); font-size: 14px; }

    .botao { font: inherit; font-weight: 600; font-size: 14px; padding: 11px 20px; border-radius: 8px; border: none; background: var(--tinta); color: #fff; cursor: pointer; margin-top: 12px; }
    .botao:hover { background: #10182E; }
    .botao-secundario { font: inherit; font-weight: 600; font-size: 12.5px; padding: 7px 12px; border-radius: 8px; border: 1px solid var(--vermelho); background: transparent; color: var(--vermelho); cursor: pointer; white-space: nowrap; }
    .botao-secundario:hover { background: var(--vermelho-suave); }
    .copiavel { background: var(--papel); padding: 2px 7px; border-radius: 5px; font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; cursor: pointer; display: inline-block; word-break: break-all; }
    .aviso-sucesso { background: var(--verde-suave); border: 1px solid var(--verde); color: #1F4A34; padding: 12px 16px; border-radius: 10px; margin-top: 16px; font-size: 14px; }
${cssExtra}
  </style>
</head>
<body>
  <div class="envelope">
    <nav class="menu">${menu}</nav>
${corpo}
  </div>
  <script>
    // Copiar via delegação: o identificador vem de fora e, interpolado numa string JS dentro de
    // um atributo onclick, conseguia escapar dela.
    document.addEventListener('click', (ev) => {
      const alvo = ev.target.closest('[data-copiar]');
      if (alvo) navigator.clipboard.writeText(alvo.dataset.copiar);
    });
  </script>
${scriptExtra}
</body>
</html>`;
}

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

  res.send(paginaHtml({
    titulo: 'Pessoas vistas nos grupos',
    ativo: '/contatos',
    largura: 900,
    cssExtra: `
    .cartao { background: var(--superficie); border: 1px solid var(--linha); border-radius: 12px; padding: 22px; margin-top: 20px; }
    .cartao__olho { font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--dourado); font-weight: 500; margin: 0 0 4px; }
    .cartao h2 { font-family: 'Fraunces', Georgia, serif; font-size: 20px; font-weight: 600; margin: 0 0 4px; }
    .cartao__legenda { font-size: 13px; color: #5B6178; margin: 0 0 16px; }
    input[type="text"], .campo input { font: inherit; font-size: 15px; padding: 10px 12px; border: 1px solid var(--linha); border-radius: 8px; background: var(--papel); color: var(--tinta); width: 100%; }
    input:focus-visible { outline: 2px solid var(--dourado); outline-offset: 1px; background: var(--superficie); }
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
`,
    corpo: `
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
`,
    scriptExtra: `<script>
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
        </script>`
  }));
});

app.post('/contatos/banir', (req, res) => {
  const identificador = normalizarIdentificador(req.body.identificador || '');
  if (!identificador || identificador === '@s.whatsapp.net') return res.status(400).send('Identificador inválido.');
  if (persistProtegidos.mapa.has(identificador)) {
    return res.redirect(`/contatos?aviso=${encodeURIComponent('🛡️ Esse número está protegido — remova a proteção antes de banir.')}`);
  }
  persistBanidos.mapa.set(identificador, { adicionadoEm: new Date().toISOString(), origem: 'painel' });
  persistBanidos.agendarSalvar();

  const info = contatosVistos.get(identificador);
  const ultimo = ultimoMotivoDe(identificador);
  registrarEventoModeracao({
    acao: 'banido',
    grupoId: info?.grupoId || null,
    participant: identificador,
    remetente: info?.nome || null,
    // Ban manual não tem regra própria — herda o último motivo registrado da pessoa, que é o
    // que normalmente motivou o admin a banir.
    regra: ultimo?.regra ?? null,
    texto: ultimo?.texto || '',
    tipo: ultimo?.tipo || null,
    origem: 'painel'
  });

  (async () => {
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

  res.send(paginaHtml({
    titulo: 'Mesa de Debate',
    ativo: '/painel',
    largura: 720,
    cssExtra: `
    .ticket { position: relative; margin-top: 20px; background: var(--superficie); border: 1px solid var(--linha); border-left: 5px solid var(--cor-fase, var(--verde)); border-radius: 10px; padding: 16px 18px; display: flex; flex-direction: column; gap: 4px; }
    .ticket--normal { --cor-fase: var(--verde); }
    .ticket--enquete { --cor-fase: var(--dourado); }
    .ticket--debate { --cor-fase: var(--vermelho); }
    .ticket__selo { position: absolute; top: -14px; right: 16px; width: 40px; height: 40px; border-radius: 50%; background: var(--superficie); border: 2px dashed var(--cor-fase, var(--verde)); display: flex; align-items: center; justify-content: center; font-size: 18px; transform: rotate(-8deg); }
    .ticket__rotulo { font-family: 'Fraunces', Georgia, serif; font-size: 19px; font-weight: 600; }
    .ticket__detalhe { font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; color: #5B6178; }
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
    .botao:focus-visible { outline: 2px solid var(--dourado); outline-offset: 2px; }
    .botao--dourado { background: var(--dourado); color: #2B2106; }
    .botao--dourado:hover { background: #B48A28; }
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
`,
    corpo: `
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
`,
    scriptExtra: `<script>
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
        </script>`
  }));
});

// Aceita os formatos que as pessoas realmente escrevem:
//   1. Não divulgue produtos        3 - Respeite todos          Regra 5: proibido spam
// Linha sem número é continuação da regra anterior, então regra de vários parágrafos funciona —
// é o que faz uma regra longa, colada com quebra de linha no meio, não virar duas.
function interpretarRegras(textoBruto) {
  const regras = [];
  for (const linha of String(textoBruto || '').split('\n')) {
    const limpa = linha.trim();
    if (!limpa) continue;
    const casa = limpa.match(/^(?:regra\s*)?(\d{1,3})\s*[).:\-–]?\s+(.*)$/i);
    if (casa && casa[2]) {
      regras.push({ numero: Number(casa[1]), texto: casa[2].trim() });
    } else if (regras.length > 0) {
      regras[regras.length - 1].texto += ` ${limpa}`;
    } else {
      regras.push({ numero: regras.length + 1, texto: limpa });
    }
  }
  return regras;
}

function textoDaRegra(numero) {
  const achada = (persistRegras.get().regras || []).find((r) => r.numero === Number(numero));
  return achada?.texto || null;
}

const ROTULOS_ACAO = {
  apagada: { texto: 'Mensagem apagada', classe: 'dourado', icone: '🧹' },
  violacao: { texto: 'Violação registrada', classe: 'dourado', icone: '⚠️' },
  removido: { texto: 'Removido do grupo', classe: 'vermelho', icone: '🚪' },
  banido: { texto: 'Banido', classe: 'vermelho', icone: '🚫' },
  aviso: { texto: 'Aviso enviado', classe: 'verde', icone: '💬' }
};

// Devolve os selos numerados e, junto, o texto de cada regra citada — que é o que a pessoa
// que lê o painel realmente precisa. Número sozinho obriga a ir consultar o regulamento.
function blocoDeRegra(regra) {
  if (regra === null || regra === undefined || regra === '') {
    return { selos: '<span class="selo-regra selo-regra--vazio">Sem regra registrada</span>', textos: '' };
  }
  const bruto = String(regra);
  const numeros = bruto.match(/\d+/g);
  const soNumeros = numeros && numeros.length > 0 && bruto.replace(/[\d,;\s.\-–]|regras?/gi, '').length === 0;

  if (!soNumeros) {
    // A IA mandou a regra por extenso — mostra como veio, sem tentar adivinhar número.
    return { selos: `<span class="selo-regra selo-regra--texto">${escapeHtml(bruto)}</span>`, textos: '' };
  }

  const selos = numeros.map((n) => `<span class="selo-regra">Regra ${n}</span>`).join('');
  const textos = numeros.map((n) => {
    const texto = textoDaRegra(n);
    return texto
      ? `<p class="regra-texto"><span class="regra-texto__num">${n}</span>${escapeHtml(texto)}</p>`
      : `<p class="regra-texto regra-texto--faltando"><span class="regra-texto__num">${n}</span>Regra ${n} ainda não cadastrada — adicione em "Regras do grupo" acima.</p>`;
  }).join('');

  return { selos, textos };
}

function selosDeRegra(regra) {
  return blocoDeRegra(regra).selos;
}

function trechoDoTexto(texto, tipo) {
  if (!texto || !texto.trim()) {
    const rotuloTipo = tipo && tipo !== 'texto' ? ` (${escapeHtml(tipo)})` : '';
    return `<p class="citacao citacao--vazia">Texto não capturado${rotuloTipo}</p>`;
  }
  const limpo = escapeHtml(texto.length > 600 ? `${texto.slice(0, 600)}…` : texto);
  return `<p class="citacao">${limpo.replace(/\n/g, '<br>')}</p>`;
}

app.get('/banidos', (req, res) => {
  const eventos = [...(historicoModeracao.get().eventos || [])].reverse();
  const filtroAcao = req.query.acao || '';
  const regrasCadastradas = persistRegras.get().regras || [];

  const nomeDe = (id, fallback) => fallback || contatosVistos.get(id)?.nome || 'Nome desconhecido';

  const cartoesBanidos = [...persistBanidos.mapa.entries()]
    .sort((a, b) => new Date(b[1].adicionadoEm) - new Date(a[1].adicionadoEm))
    .map(([id, info]) => {
      const contato = contatosVistos.get(id);
      const motivo = ultimoMotivoDe(id);
      const numero = contato?.numero ? `<span class="pessoa__numero">${escapeHtml(contato.numero)}</span>` : '';
      const busca = `${contato?.nome || ''} ${contato?.numero || ''} ${id} ${motivo?.texto || ''} ${motivo?.regra || ''}`.toLowerCase();

      return `
      <article class="pessoa" data-busca="${escapeHtml(busca)}">
        <header class="pessoa__topo">
          <div>
            <h3 class="pessoa__nome">${escapeHtml(nomeDe(id, contato?.nome))}</h3>
            ${numero}
            <code class="copiavel" data-copiar="${escapeHtml(id)}" title="Clique pra copiar">${escapeHtml(id)}</code>
          </div>
          <form method="POST" action="/contatos/banir/remover">
            <input type="hidden" name="identificador" value="${id}">
            <button class="botao-secundario" type="submit">Desbanir</button>
          </form>
        </header>

        <div class="pessoa__motivo">
          <div class="rotulo-linha">
            <span class="rotulo">Regra apontada</span>
            ${blocoDeRegra(motivo?.regra).selos}
          </div>
          ${blocoDeRegra(motivo?.regra).textos}
          <div class="rotulo-linha" style="margin-top:10px;"><span class="rotulo">O que a pessoa enviou</span></div>
          ${trechoDoTexto(motivo?.texto, motivo?.tipo)}
        </div>

        <footer class="pessoa__rodape">
          Banido em ${new Date(info.adicionadoEm).toLocaleString('pt-BR', { timeZone: FUSO_HORARIO })}
          ${info.origem === 'env' ? ' · migrado da variável de ambiente' : info.origem === 'painel' ? ' · pelo painel' : ''}
        </footer>
      </article>`;
    })
    .join('');

  const linhasHistorico = eventos
    .filter((e) => !filtroAcao || e.acao === filtroAcao)
    .map((e) => {
      const rotulo = ROTULOS_ACAO[e.acao] || { texto: e.acao, classe: 'neutro', icone: '•' };
      const busca = `${e.remetente || ''} ${e.participant || ''} ${e.texto || ''} ${e.regra || ''}`.toLowerCase();
      const contagem = e.contagem ? `<span class="pilula">${e.contagem}ª violação</span>` : '';

      return `
      <article class="evento evento--${rotulo.classe}" data-busca="${escapeHtml(busca)}">
        <div class="evento__cabeca">
          <span class="selo-acao selo-acao--${rotulo.classe}">${rotulo.icone} ${rotulo.texto}</span>
          ${selosDeRegra(e.regra)}
          ${contagem}
          <time class="evento__quando">${new Date(e.quando).toLocaleString('pt-BR', { timeZone: FUSO_HORARIO })}</time>
        </div>
        <p class="evento__quem">
          <strong>${escapeHtml(nomeDe(e.participant, e.remetente))}</strong>
          <code class="copiavel" data-copiar="${escapeHtml(e.participant || '')}">${escapeHtml(e.participant || '—')}</code>
        </p>
        ${blocoDeRegra(e.regra).textos}
        ${trechoDoTexto(e.texto, e.tipo)}
      </article>`;
    })
    .join('');

  const contagens = eventos.reduce((acc, e) => { acc[e.acao] = (acc[e.acao] || 0) + 1; return acc; }, {});
  const abas = [['', 'Tudo', eventos.length], ...Object.keys(ROTULOS_ACAO).map((a) => [a, ROTULOS_ACAO[a].texto, contagens[a] || 0])]
    .filter(([chave, , n]) => chave === '' || n > 0)
    .map(([chave, nome, n]) => `<a class="aba ${filtroAcao === chave ? 'aba--ativa' : ''}" href="/banidos${chave ? `?acao=${chave}` : ''}">${nome} <span>${n}</span></a>`)
    .join('');

  res.send(paginaHtml({
    titulo: 'Banidos e histórico',
    ativo: '/banidos',
    largura: 780,
    cssExtra: `
    .busca { margin-top: 20px; position: relative; }
    .busca input { font: inherit; font-size: 15px; width: 100%; padding: 12px 14px 12px 40px; border: 1px solid var(--linha); border-radius: 10px; background: var(--superficie); color: var(--tinta); }
    .busca input:focus-visible { outline: 2px solid var(--dourado); outline-offset: 1px; }
    .busca::before { content: '🔎'; position: absolute; left: 13px; top: 50%; transform: translateY(-50%); font-size: 15px; opacity: 0.55; }
    .secao { margin-top: 34px; }
    .secao__olho { font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--dourado); font-weight: 500; margin: 0 0 4px; }
    .secao h2 { font-family: 'Fraunces', Georgia, serif; font-size: 21px; font-weight: 600; margin: 0 0 14px; }
    .pessoa { background: var(--superficie); border: 1px solid var(--linha); border-left: 5px solid var(--vermelho); border-radius: 12px; padding: 16px 18px; margin-bottom: 12px; }
    .pessoa__topo { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .pessoa__nome { font-family: 'Fraunces', Georgia, serif; font-size: 17px; font-weight: 600; margin: 0 0 2px; }
    .pessoa__numero { display: block; font-size: 13px; color: var(--apagado); margin-bottom: 4px; }
    .pessoa__motivo { margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--linha); }
    .pessoa__rodape { margin-top: 10px; font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; color: var(--apagado); }
    .rotulo-linha { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 7px; }
    .rotulo { font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 0.07em; text-transform: uppercase; color: var(--apagado); }
    .selo-regra { display: inline-block; background: var(--vermelho-suave); color: #7A2A20; font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; }
    .selo-regra--texto { background: var(--dourado-suave); color: #6B4E14; font-weight: 500; }
    .selo-regra--vazio { background: var(--papel); color: var(--apagado); font-weight: 400; }
    .citacao { margin: 0; background: var(--papel); border-radius: 8px; padding: 11px 13px; font-size: 14.5px; white-space: pre-wrap; word-break: break-word; border-left: 3px solid var(--linha); }
    .citacao--vazia { color: var(--apagado); font-style: italic; font-size: 13.5px; }
    .regra-texto { margin: 0 0 6px; font-size: 14px; color: var(--tinta); display: flex; gap: 9px; align-items: baseline; background: var(--vermelho-suave); border-radius: 8px; padding: 9px 12px; }
    .regra-texto--faltando { background: var(--papel); color: var(--apagado); font-style: italic; font-size: 13px; }
    .regra-texto__num { font-family: 'IBM Plex Mono', monospace; font-size: 11px; font-weight: 600; opacity: 0.6; flex-shrink: 0; }
    .editor { background: var(--superficie); border: 1px solid var(--linha); border-radius: 12px; margin-top: 20px; overflow: hidden; }
    .editor summary { cursor: pointer; padding: 14px 18px; font-weight: 600; font-size: 14.5px; list-style: none; display: flex; justify-content: space-between; align-items: center; gap: 10px; }
    .editor summary::-webkit-details-marker { display: none; }
    .editor summary::after { content: '▾'; color: var(--apagado); font-size: 13px; }
    .editor[open] summary { border-bottom: 1px solid var(--linha); }
    .editor[open] summary::after { content: '▴'; }
    .editor__corpo { padding: 16px 18px 18px; }
    .editor__dica { margin: 0 0 10px; font-size: 13px; color: var(--apagado); }
    .editor textarea { font: inherit; font-size: 14px; font-family: 'IBM Plex Mono', monospace; width: 100%; min-height: 190px; padding: 12px 14px; border: 1px solid var(--linha); border-radius: 9px; background: var(--papel); color: var(--tinta); resize: vertical; line-height: 1.6; }
    .editor textarea:focus-visible { outline: 2px solid var(--dourado); outline-offset: 1px; background: var(--superficie); }
    .editor__resultado { margin: 14px 0 0; font-size: 13px; color: var(--apagado); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .contador-regras { font-family: 'IBM Plex Mono', monospace; font-size: 11px; font-weight: 500; color: var(--apagado); }
    .abas { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
    .aba { font-size: 13px; text-decoration: none; color: var(--apagado); background: var(--superficie); border: 1px solid var(--linha); padding: 6px 12px; border-radius: 999px; }
    .aba span { font-family: 'IBM Plex Mono', monospace; font-size: 11px; opacity: 0.7; }
    .aba--ativa { background: var(--tinta); color: #fff; border-color: var(--tinta); }
    .evento { background: var(--superficie); border: 1px solid var(--linha); border-left: 4px solid var(--linha); border-radius: 10px; padding: 13px 15px; margin-bottom: 10px; }
    .evento--vermelho { border-left-color: var(--vermelho); }
    .evento--dourado { border-left-color: var(--dourado); }
    .evento--verde { border-left-color: var(--verde); }
    .evento__cabeca { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-bottom: 7px; }
    .evento__quando { margin-left: auto; font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; color: var(--apagado); }
    .evento__quem { margin: 0 0 8px; font-size: 14px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .selo-acao { font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; }
    .selo-acao--vermelho { background: var(--vermelho-suave); color: #7A2A20; }
    .selo-acao--dourado { background: var(--dourado-suave); color: #6B4E14; }
    .selo-acao--verde { background: var(--verde-suave); color: #1F4A34; }
    .selo-acao--neutro { background: var(--papel); color: var(--apagado); }
    .pilula { font-family: 'IBM Plex Mono', monospace; font-size: 11px; background: var(--papel); color: var(--apagado); padding: 3px 8px; border-radius: 999px; }
    .vazio { background: var(--superficie); border: 1px dashed var(--linha); border-radius: 12px; padding: 28px 20px; text-align: center; color: var(--apagado); font-size: 14px; }
    .vazio strong { display: block; font-family: 'Fraunces', Georgia, serif; font-size: 16px; color: var(--tinta); margin-bottom: 4px; }
    .pessoa__topo { flex-direction: column; }
    .evento__quando { margin-left: 0; width: 100%; }
`,
    corpo: `
    <header class="cabecalho">
      <h1>Banidos e histórico</h1>
      <p>Quem está banido, o que a pessoa escreveu e qual regra foi apontada.</p>
    </header>

    ${req.query.salvo ? `<div class="aviso-sucesso">✅ ${regrasCadastradas.length} regra(s) salva(s). O texto agora aparece junto de cada banimento.</div>` : ''}

    <details class="editor" ${regrasCadastradas.length === 0 ? 'open' : ''}>
      <summary>Regras do grupo <span class="contador-regras">${regrasCadastradas.length} cadastrada(s)</span></summary>
      <div class="editor__corpo">
        <p class="editor__dica">Uma regra por linha, começando pelo número. O painel usa isso pra mostrar o texto da regra ao lado de cada punição. Aceita <code>1.</code>, <code>2 -</code> ou <code>Regra 3:</code>.</p>
        <form method="POST" action="/banidos/regras">
          <textarea name="regras" placeholder="1. Não é permitido divulgar produtos, serviços ou links sem autorização do admin.&#10;2. Respeite todos os participantes: sem ofensas, discriminação ou assédio.&#10;3. Proibido conteúdo sexual, violento ou perturbador.">${escapeHtml(persistRegras.get().textoBruto || '')}</textarea>
          <button class="botao" type="submit">Salvar regras</button>
        </form>
        ${regrasCadastradas.length > 0 ? `<p class="editor__resultado">Interpretado como: ${regrasCadastradas.map((r) => `<span class="selo-regra">Regra ${r.numero}</span>`).join('')}</p>` : ''}
      </div>
    </details>

    <div class="busca">
      <input id="campoBusca" type="text" placeholder="Buscar por nome, número, texto ou regra…" autocomplete="off">
    </div>

    <section class="secao">
      <p class="secao__olho">Lista de bloqueio</p>
      <h2>Banidos agora (${persistBanidos.mapa.size})</h2>
      ${cartoesBanidos || '<div class="vazio"><strong>Ninguém banido</strong>A lista de bloqueio está vazia.</div>'}
    </section>

    <section class="secao">
      <p class="secao__olho">Linha do tempo</p>
      <h2>Histórico de moderação</h2>
      <div class="abas">${abas}</div>
      ${linhasHistorico || '<div class="vazio"><strong>Nada registrado ainda</strong>O histórico começa a partir da primeira ação de moderação depois desta atualização.</div>'}
    </section>
`,
    scriptExtra: `<script>
    const campo = document.getElementById('campoBusca');
    campo.addEventListener('input', () => {
      const termo = campo.value.trim().toLowerCase();
      for (const item of document.querySelectorAll('[data-busca]')) {
        item.style.display = !termo || item.dataset.busca.includes(termo) ? '' : 'none';
      }
    });
  </script>`
  }));
});

app.post('/banidos/regras', (req, res) => {
  const textoBruto = String(req.body.regras || '');
  persistRegras.set({ textoBruto, regras: interpretarRegras(textoBruto) });
  res.redirect('/banidos?salvo=1');
});

// Deixa o n8n buscar as regras daqui em vez de mantê-las coladas no nó "Regras (temporário)".
// Com isso elas passam a ter um lugar só: editadas no painel, usadas no prompt e exibidas na
// tela de banidos — sem chance de divergirem entre si.
app.get('/regras', (req, res) => {
  const regras = persistRegras.get().regras || [];
  res.json({
    regras,
    texto: regras.map((r) => `${r.numero}. ${r.texto}`).join('\n')
  });
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

    const cache = buscarMensagemRecente(grupo_id, participant, message_id);
    registrarEventoModeracao({
      acao: 'apagada',
      grupoId: grupo_id,
      participant,
      remetente: req.body.remetente || contatosVistos.get(participant)?.nome || null,
      regra: req.body.regra ?? null,
      texto: req.body.texto || cache?.texto || '',
      tipo: cache?.tipo || null,
      messageId: message_id
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

  const cache = buscarMensagemRecente(grupo_id, participant, req.body.message_id);
  const textoDaVez = req.body.texto || cache?.texto || '';
  const nomeDaVez = remetente || contatosVistos.get(participant)?.nome || null;

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

  registrarEventoModeracao({
    acao: removido ? 'removido' : 'violacao',
    grupoId: grupo_id,
    participant,
    remetente: nomeDaVez,
    regra: regra ?? null,
    texto: textoDaVez,
    tipo: cache?.tipo || null,
    messageId: req.body.message_id || cache?.messageId || null,
    contagem: removido ? REMOVE_THRESHOLD : contagem
  });

  res.json({ ok: true, contagem, removido });
});

app.listen(PORT, () => {
  console.log(`Servidor HTTP rodando na porta ${PORT}`);
});
