import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, downloadMediaMessage, decryptPollVote, jidNormalizedUser } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import pino from 'pino';
import express from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, unlink, readdir, mkdir, copyFile } from 'fs/promises';
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
// Figurinha é WebP, e a maioria das figurinhas de hoje é WebP ANIMADO. Isso importa porque o
// decodificador nativo de webp do ffmpeg NÃO lê webp animado — ele reclama de "unsupported chunk:
// ANIM" e não escreve quadro nenhum. Testado, não suposto. Então não dá pra ter um comando só.
//
// A ordem abaixo é uma escada: cada degrau cobre o que o anterior não cobre, e o log diz qual
// pegou. Se um dia nenhum funcionar na hospedagem, a linha de log aponta o problema direto, em
// vez de a figurinha sumir em silêncio como acontecia antes.
async function figurinhaParaImagem(bufferOriginal) {
  const idTemp = Math.random().toString(36).slice(2);
  const entrada = path.join(tmpdir(), `sticker-in-${idTemp}.webp`);
  const animada = bufferOriginal.indexOf(Buffer.from('ANIM')) !== -1;

  const degraus = [
    // ffmpeg resolve figurinha estática, e é a única ferramenta que o bot já usa pra áudio/vídeo,
    // então é a mais garantida de existir.
    { nome: 'ffmpeg', saida: `sticker-out-${idTemp}.jpg`, mime: 'image/jpeg',
      cmd: (e, s) => `ffmpeg -y -i "${e}" -frames:v 1 -q:v 3 "${s}"` },
    // ImageMagick lê webp animado; o [0] pega o primeiro quadro.
    { nome: 'imagemagick', saida: `sticker-im-${idTemp}.jpg`, mime: 'image/jpeg',
      cmd: (e, s) => `convert "${e}[0]" "${s}"` },
    // libwebp, se estiver instalada.
    { nome: 'dwebp', saida: `sticker-dw-${idTemp}.png`, mime: 'image/png',
      cmd: (e, s) => `dwebp "${e}" -o "${s}"` }
  ];

  try {
    await writeFile(entrada, bufferOriginal);
    for (const degrau of degraus) {
      const saida = path.join(tmpdir(), degrau.saida);
      try {
        await execAsync(degrau.cmd(entrada, saida), { timeout: 15000 });
        const bytes = await readFile(saida);
        if (bytes.length === 0) throw new Error('arquivo vazio');
        console.log(`[FIGURINHA] Convertida por ${degrau.nome}${animada ? ' (animada)' : ''}.`);
        return { base64: bytes.toString('base64'), mime: degrau.mime };
      } catch {
        // degrau não deu conta; tenta o próximo
      } finally {
        await unlink(saida).catch(() => {});
      }
    }
    console.error(`[FIGURINHA] Nenhum conversor deu conta${animada ? ' (animada)' : ''} — mandando o webp cru, a IA pode não conseguir ler.`);
    return { base64: bufferOriginal.toString('base64'), mime: 'image/webp' };
  } finally {
    await unlink(entrada).catch(() => {});
  }
}

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

// --- Senha do painel ---
//
// Fica em variável de ambiente, nunca no código: este arquivo vai pro GitHub, e senha em
// repositório é senha vazada. Se PAINEL_SENHA não estiver configurada, o painel NÃO abre —
// falha fechada de propósito. O contrário (abrir sem senha quando a variável falta) daria a
// impressão de estar protegido enquanto estivesse escancarado.
const PAINEL_SENHA = process.env.PAINEL_SENHA || '';
const DIAS_SESSAO_PAINEL = Number(process.env.DIAS_SESSAO_PAINEL || 90);
const COOKIE_SESSAO = 'painel_sessao';

// Rotas que não exigem login: healthcheck do Railway e a própria tela de entrar.
const ROTAS_PUBLICAS = new Set(['/health', '/login', '/logout']);

function assinarSessao(dado) {
  return crypto.createHmac('sha256', PAINEL_SENHA).update(String(dado)).digest('hex');
}

// Comparação em tempo constante: comparar string com === vaza, pelo tempo de resposta, quantos
// caracteres iniciais estavam certos.
function iguaisEmTempoConstante(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// O cookie não guarda a senha — guarda um prazo de validade assinado com ela. Quem não sabe a
// senha não consegue forjar a assinatura, e trocar a senha invalida todas as sessões de uma vez.
function criarTokenSessao() {
  const expiraEm = Date.now() + DIAS_SESSAO_PAINEL * 86400_000;
  return `${expiraEm}.${assinarSessao(expiraEm)}`;
}

function tokenSessaoValido(token) {
  if (!token || !PAINEL_SENHA) return false;
  const [expiraEm, assinatura] = String(token).split('.');
  if (!expiraEm || !assinatura) return false;
  if (!iguaisEmTempoConstante(assinatura, assinarSessao(expiraEm))) return false;
  return Number(expiraEm) > Date.now();
}

function lerCookie(req, nome) {
  for (const parte of (req.headers.cookie || '').split(';')) {
    const [chave, ...resto] = parte.trim().split('=');
    if (chave === nome) return decodeURIComponent(resto.join('='));
  }
  return null;
}

// Aceita cookie do navegador OU o header do n8n — assim as integrações continuam funcionando
// sem precisar de sessão.
function estaAutenticado(req) {
  if (API_SECRET && req.headers['x-api-secret'] === API_SECRET) return true;
  return tokenSessaoValido(lerCookie(req, COOKIE_SESSAO));
}

// Trava simples contra força bruta: 10 tentativas erradas por IP a cada 15 min.
const tentativasLogin = new Map();
const JANELA_TENTATIVAS_MS = 15 * 60_000;
const MAX_TENTATIVAS = 10;

function podeTentarLogin(ip) {
  const registro = tentativasLogin.get(ip);
  if (!registro) return true;
  if (Date.now() - registro.desde > JANELA_TENTATIVAS_MS) {
    tentativasLogin.delete(ip);
    return true;
  }
  return registro.erros < MAX_TENTATIVAS;
}

function registrarErroLogin(ip) {
  const registro = tentativasLogin.get(ip);
  if (!registro || Date.now() - registro.desde > JANELA_TENTATIVAS_MS) {
    tentativasLogin.set(ip, { erros: 1, desde: Date.now() });
  } else {
    registro.erros++;
  }
  while (tentativasLogin.size > 500) tentativasLogin.delete(tentativasLogin.keys().next().value);
}
const AUTH_FOLDER = process.env.AUTH_FOLDER || 'auth_info_baileys';
const PORT = process.env.PORT || 3000;

// Identidade que o bot apresenta ao WhatsApp, no formato "SO,Navegador,Versão"
// (ex.: "Ubuntu,Chrome,22.04.4"). É o nome que aparece em "Aparelhos conectados" no celular.
//
// VAZIO é o padrão e é o que está no ar hoje: nada é passado e o Baileys usa a identidade dele.
// Esta variável existe por um motivo só — o pareamento por CÓDIGO é sensível a esse campo em
// alguns ambientes, e sem ela um eventual ajuste exigiria novo deploy. Mexer nisso muda o
// handshake com o WhatsApp: use enquanto estiver PAREANDO um número, nunca numa sessão que já
// está funcionando.
const BAILEYS_BROWSER = (process.env.BAILEYS_BROWSER || '')
  .split(',')
  .map((parte) => parte.trim())
  .filter(Boolean);
if (BAILEYS_BROWSER.length > 0 && BAILEYS_BROWSER.length !== 3) {
  console.error(`[BOOT] BAILEYS_BROWSER precisa de 3 partes separadas por vírgula; recebi ${BAILEYS_BROWSER.length}. Ignorando e usando o padrão do Baileys.`);
}

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
// Calcula quando a próxima enquete deve sair.
//
// O `ultimoCicloIniciadoEm` existe desde sempre no estado, mas nunca era consultado aqui — e essa
// era a falha. Sem ele, a conta é só "próxima vez que o horário configurado acontece depois de
// agora". Então salvar a configuração de manhã, com um horário ainda à frente no mesmo dia,
// agendava uma SEGUNDA enquete pro mesmo dia. Foi o que aconteceu: 09:02 e depois 09:17.
//
// O painel promete "o ciclo roda todo dia", no singular. Agora o código cumpre isso: dia que já
// teve ciclo é pulado, independente de quantas vezes a configuração for salva.
function calcularProximoDisparo(cfg, apartirDe = new Date(), ultimoCicloIniciadoEm = null) {
  const diaDoUltimoCiclo = ultimoCicloIniciadoEm ? dataLocalISO(new Date(ultimoCicloIniciadoEm)) : null;

  for (let diasAFrente = 0; diasAFrente <= 7; diasAFrente++) {
    const candidatoBase = new Date(apartirDe.getTime() + diasAFrente * 86_400_000);
    const dataISO = dataLocalISO(candidatoBase);
    if (dataISO === diaDoUltimoCiclo) continue; // esse dia já teve a enquete dele
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
  const identificadoresDono = [
    '5511986694787@s.whatsapp.net',   // dono, formato número
    '157728429347047@lid',            // dono, formato @lid
    '5547996763184@s.whatsapp.net',   // protegido adicional, pedido em 04/08/2026
    '230824427417681@lid'             // protegido adicional, pedido em 04/08/2026
  ];
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

// --- Múltiplas contas de WhatsApp ---
//
// O AUTH_FOLDER sempre guardou DUAS coisas no mesmo diretório: a sessão do Baileys (creds.json,
// session-*, pre-key-*) e todos os dados do bot (contatos, banidos, regras, histórico). Duas
// contas ali dentro se sobrescreveriam.
//
// A separação é assimétrica de propósito: os DADOS ficam exatamente onde estão — nada é movido,
// nenhuma migração de arquivo, zero risco de perder banidos ou regras. Só as SESSÕES descem um
// nível, para AUTH_FOLDER/sessoes/<conta>/. Cada conta tem a sua; os dados são compartilhados,
// que é o que se quer: trocar o número do bot não pode zerar o histórico do grupo.
const PASTA_SESSOES = path.join(AUTH_FOLDER, 'sessoes');
const ARQUIVOS_DE_SESSAO = /^(creds\.json|app-state-sync-|session-|pre-key-|sender-key-)/;

const configContas = criarValorPersistente('contas.json', {
  ativa: 'principal',   // null = bot desligado, sem conectar em nenhuma conta
  contas: { principal: { rotulo: 'Conta principal', criadaEm: null, ultimoJid: null } }
});

function pastaDaConta(nome) {
  if (!nome || !/^[a-z0-9-]{1,30}$/i.test(nome)) return null;
  return path.join(PASTA_SESSOES, nome);
}

// Leva a sessão que hoje está solta no AUTH_FOLDER para sessoes/principal/. Copia em vez de mover:
// se algo der errado, os arquivos originais continuam lá e basta voltar a versão anterior do
// código. Roda uma vez só — depois que o destino existe, não repete.
async function migrarSessaoSolta() {
  try {
    await mkdir(PASTA_SESSOES, { recursive: true });
    const destino = pastaDaConta('principal');
    const jaMigrado = await readdir(destino).then((f) => f.includes('creds.json')).catch(() => false);
    if (jaMigrado) return;

    const naRaiz = await readdir(AUTH_FOLDER).catch(() => []);
    const sessao = naRaiz.filter((n) => ARQUIVOS_DE_SESSAO.test(n));
    if (sessao.length === 0) return;

    await mkdir(destino, { recursive: true });
    for (const nome of sessao) {
      await copyFile(path.join(AUTH_FOLDER, nome), path.join(destino, nome)).catch((err) =>
        console.error(`Falha ao copiar ${nome}:`, err.message));
    }
    console.log(`[CONTAS] Sessão existente copiada para sessoes/principal/ (${sessao.length} arquivo(s)). Os originais foram mantidos como backup.`);
  } catch (err) {
    console.error('[CONTAS] Erro ao migrar a sessão solta:', err.message);
  }
}

// --- Resposta automática em conversa privada ---
//
// O WhatsApp comum não tem "mensagem de saudação": isso é recurso do app Business, executado no
// celular. Como o bot já recebe as mensagens privadas dele (e hoje simplesmente descarta), dá pra
// fazer aqui — e com a vantagem de funcionar com o celular desligado.
//
// Responder automaticamente a desconhecido é padrão que a detecção de abuso do WhatsApp marca,
// então as travas abaixo não são detalhe, são o que torna isso seguro:
//   • uma resposta por contato, com carência de dias antes de repetir
//   • só mensagem que chega AGORA — sincronização de histórico é ignorada, senão o primeiro boot
//     depois do pareamento dispararia uma resposta pra cada conversa antiga de uma vez
//   • teto por hora, como freio de emergência caso algo escape
const configResposta = criarValorPersistente('resposta-automatica.json', {
  ativa: false,
  texto: 'Nosso atendimento agradece seu contato. Por aqui não atendemos solicitações, favor entrar em contato no número 1198669-4787',
  diasParaRepetir: 14
});
const persistSaudacoes = criarMapaPersistente('saudacoes-enviadas.json');

const MAX_RESPOSTAS_POR_HORA = 20;
const IDADE_MAXIMA_RESPOSTA_MS = 60 * 60_000;
let respostasNaHora = { contagem: 0, desde: Date.now() };

function podeResponderAgora() {
  if (Date.now() - respostasNaHora.desde > 3600_000) respostasNaHora = { contagem: 0, desde: Date.now() };
  return respostasNaHora.contagem < MAX_RESPOSTAS_POR_HORA;
}

async function responderPrivadoSePreciso(msg, type, jid) {
  const cfg = configResposta.get();

  // Cada motivo de não responder sai no log. Antes eram returns mudos: a resposta simplesmente
  // não acontecia e não havia como descobrir qual das seis travas tinha pegado.
  const pular = (motivo) => { console.log(`[RESPOSTA] Ignorado (${motivo}): ${msg.pushName || jid}`); };

  if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return;
  if (!cfg.ativa) return pular('resposta automática desligada em /resposta');
  if (!cfg.texto?.trim()) return pular('texto da resposta está vazio');

  // Histórico sincronizado não dispara resposta. Sem isso, o primeiro boot depois de parear um
  // número novo responderia todas as conversas antigas de uma vez — exatamente o comportamento
  // que faz o WhatsApp derrubar a conta.
  if (type !== 'notify') return pular(`veio como "${type}", não é mensagem nova`);

  const ts = timestampDaMensagem(msg);
  if (ts && Date.now() - ts * 1000 > IDADE_MAXIMA_RESPOSTA_MS) {
    return pular(`mensagem tem ${Math.round((Date.now() - ts * 1000) / 60000)} min, mais velha que o limite de 60`);
  }

  if (await participantEstaNaLista(jid, persistProtegidos.mapa)) {
    return pular('número está na lista de PROTEGIDOS — protegido não recebe saudação');
  }

  const jaEnviado = persistSaudacoes.mapa.get(jid);
  const carenciaMs = Math.max(0, Number(cfg.diasParaRepetir) || 0) * 86400_000;
  if (jaEnviado?.quando && Date.now() - new Date(jaEnviado.quando).getTime() < carenciaMs) {
    const dias = Math.floor((Date.now() - new Date(jaEnviado.quando).getTime()) / 86400_000);
    return pular(`já recebeu há ${dias} dia(s), carência é de ${cfg.diasParaRepetir}`);
  }

  if (!podeResponderAgora()) {
    console.warn(`[RESPOSTA] Teto de ${MAX_RESPOSTAS_POR_HORA}/h atingido — resposta para ${jid} não enviada.`);
    return;
  }

  try {
    respostasNaHora.contagem++;
    await enviarComDigitando(jid, cfg.texto.trim());
    persistSaudacoes.mapa.set(jid, { quando: new Date().toISOString(), nome: msg.pushName || null });
    persistSaudacoes.agendarSalvar();
    console.log(`[RESPOSTA] Saudação enviada para ${msg.pushName || jid}.`);
  } catch (err) {
    console.error(`[RESPOSTA] Falha ao responder ${jid}:`, err.message);
  }
}

// --- Remoção de participante ---
//
// sock.groupParticipantsUpdate NÃO lança exceção quando o servidor recusa: devolve um array com
// status por participante ('403' sem permissão, '404' JID desconhecido, '200' sucesso). O código
// antigo só usava try/catch, então uma recusa passava por sucesso — o bot anunciava "foi removido"
// e a pessoa continuava no grupo.
//
// Além de conferir o status, tenta a outra forma do JID: em grupo @lid o identificador que chega
// na mensagem nem sempre é o mesmo que o servidor aceita para remover. A groupMetadata é a
// verdade sobre aquele grupo, então é de lá que sai a segunda tentativa.
async function removerParticipante(grupoId, participant) {
  const tentativas = [];

  const tentar = async (jid, origem) => {
    try {
      const resultado = await sock.groupParticipantsUpdate(grupoId, [jid], 'remove');
      const status = String(resultado?.[0]?.status ?? 'sem-resposta');
      tentativas.push({ jid, origem, status });
      return status === '200';
    } catch (err) {
      tentativas.push({ jid, origem, status: `erro: ${err.message}` });
      return false;
    }
  };

  if (await tentar(participant, 'jid da mensagem')) return { ok: true, tentativas };

  // Segunda chance: o identificador exato que o grupo conhece.
  try {
    const metadata = await sock.groupMetadata(grupoId);
    const base = numeroBase(participant);
    const encontrado = (metadata?.participants || []).find((p) =>
      [p.id, p.jid, p.lid, p.phoneNumber]
        .filter((f) => typeof f === 'string')
        .some((f) => f === participant || (base && numeroBase(f) === base)));

    if (encontrado?.id && encontrado.id !== participant) {
      if (await tentar(encontrado.id, 'groupMetadata')) return { ok: true, tentativas };
    } else if (!encontrado) {
      tentativas.push({ jid: participant, origem: 'groupMetadata', status: 'não está mais no grupo' });
      return { ok: false, jaSaiu: true, tentativas };
    }
  } catch (err) {
    tentativas.push({ jid: participant, origem: 'groupMetadata', status: `erro: ${err.message}` });
  }

  return { ok: false, tentativas };
}

// --- Contexto da conversa ---
//
// A IA recebia só a mensagem isolada. Com isso, um link de suplemento respondendo a "alguém
// conhece um bom ômega 3?" e o mesmo link jogado do nada chegavam nela idênticos — não havia
// como distinguir recomendação de divulgação, porque a informação que separa as duas coisas
// (o que veio antes) não estava sendo enviada.
const JANELA_CONVERSA_MS = 20 * 60_000;
const MAX_CONVERSA = 8;
const historicoConversa = new Map();

function guardarNaConversa(grupoId, autor, texto, tipo) {
  // Mídia aparece com o tipo à frente da legenda: "[imagem] olha esse aqui". Sem isso, a IA lia
  // a legenda como se fosse mensagem de texto e perdia que havia um arquivo na conversa.
  const legenda = (texto || '').trim();
  const resumo = tipo === 'texto' ? legenda : `[${tipo}]${legenda ? ' ' + legenda : ''}`;
  const lista = (historicoConversa.get(grupoId) || []).filter((m) => Date.now() - m.quando < JANELA_CONVERSA_MS);
  lista.push({ autor, texto: resumo.slice(0, 220), quando: Date.now() });
  if (lista.length > MAX_CONVERSA) lista.splice(0, lista.length - MAX_CONVERSA);
  historicoConversa.set(grupoId, lista);
  while (historicoConversa.size > 20) historicoConversa.delete(historicoConversa.keys().next().value);
}

// Devolve a conversa ANTES da mensagem atual (ela já foi guardada quando isto é chamado).
function conversaAntesDe(grupoId) {
  const lista = (historicoConversa.get(grupoId) || []).filter((m) => Date.now() - m.quando < JANELA_CONVERSA_MS);
  return lista.slice(0, -1).map((m) => `${m.autor}: ${m.texto}`);
}

// Responder a alguém é o sinal mais forte de que a mensagem tem contexto: link em resposta a uma
// pergunta é recomendação, link solto é divulgação. O contextInfo fica em lugares diferentes
// dependendo do tipo de mensagem, por isso a varredura.
function mensagemCitada(conteudo) {
  const ctx = conteudo?.extendedTextMessage?.contextInfo
    || conteudo?.imageMessage?.contextInfo
    || conteudo?.videoMessage?.contextInfo
    || conteudo?.documentMessage?.contextInfo
    || conteudo?.audioMessage?.contextInfo
    || conteudo?.stickerMessage?.contextInfo;
  if (!ctx?.quotedMessage) return null;

  const citado = normalizarConteudo(ctx.quotedMessage);
  const tipoCitado = tipoDoConteudo(citado);
  const texto = citado?.conversation
    || citado?.extendedTextMessage?.text
    || citado?.imageMessage?.caption
    || citado?.videoMessage?.caption
    || citado?.documentMessage?.caption
    || '';

  const autorJid = ctx.participant || null;
  const autor = (autorJid && contatosVistos.get(autorJid)?.nome) || autorJid || 'alguém';
  return { autor, texto: (texto || `[${tipoCitado || 'mídia'}]`).slice(0, 300) };
}

// --- Prévia do link ---
//
// Quando alguém manda um link, o WhatsApp anexa título, descrição e domínio do destino dentro
// do extendedTextMessage. O bot enviava só o `text` da mensagem — num link solto isso é a URL
// crua, e a IA não tinha como saber se apontava para uma música ou para um cassino.
// Vai como campo separado de propósito: esse texto é do SITE, não é o que a pessoa escreveu.
function extrairPreviaLink(conteudo) {
  const ext = conteudo?.extendedTextMessage;
  if (!ext) return null;

  const url = ext.canonicalUrl || ext.matchedText || null;
  const titulo = (ext.title || '').trim();
  const descricao = (ext.description || '').trim();
  if (!url && !titulo && !descricao) return null;

  let dominio = null;
  try { if (url) dominio = new URL(url).hostname.replace(/^www\./, ''); } catch { /* url torta */ }

  return {
    url: url ? url.slice(0, 300) : null,
    dominio,
    titulo: titulo.slice(0, 200),
    descricao: descricao.slice(0, 400)
  };
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

// --- Repetição de verdade, não só volume ---
//
// `mensagens_recentes_60s` conta QUANTAS mensagens a pessoa mandou, não se elas eram iguais.
// Mandar 7 mensagens diferentes e mandar a mesma 7 vezes davam exatamente o mesmo número, então
// a IA não tinha como separar as duas coisas — e classificava conversa animada como spam.
// Aqui o texto é normalizado e comparado com o que a pessoa mandou nos últimos minutos.
const JANELA_REPETICAO_MS = 5 * 60_000;
const MAX_HISTORICO_TEXTO = 30;
const historicoTextos = new Map();

// Compara pelo conteúdo, não pela forma: "OI!!!" , "oi" e "Oi..." são a mesma mensagem.
function normalizarParaComparar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// Impressão digital do arquivo, pra detectar a MESMA mídia reenviada. Sem isso, quem manda a
// mesma imagem de divulgação sete vezes passava batido: sem legenda não havia texto pra comparar,
// e a contagem de repetição devolvia sempre 1.
function impressaoDaMidia(midiaBase64, audioBase64, framesBase64) {
  const pedacos = [midiaBase64, audioBase64, ...(Array.isArray(framesBase64) ? framesBase64 : [])].filter(Boolean);
  if (pedacos.length === 0) return null;
  return 'midia' + crypto.createHash('sha256').update(pedacos.join('|')).digest('hex').slice(0, 32);
}

// Devolve quantas vezes ESTA mensagem apareceu na janela, contando a atual.
// 1 = mensagem inédita. 2+ = repetiu.
// Compara pela legenda quando existe; sem legenda, cai na impressão digital do arquivo.
function contarRepeticoes(chave, texto, impressaoMidia = null) {
  const alvo = normalizarParaComparar(texto) || impressaoMidia;
  if (!alvo) return 1;

  const agora = Date.now();
  const lista = (historicoTextos.get(chave) || []).filter((r) => agora - r.quando < JANELA_REPETICAO_MS);
  const iguais = lista.filter((r) => r.txt === alvo).length;

  lista.push({ txt: alvo, quando: agora });
  if (lista.length > MAX_HISTORICO_TEXTO) lista.splice(0, lista.length - MAX_HISTORICO_TEXTO);
  historicoTextos.set(chave, lista);
  while (historicoTextos.size > 300) historicoTextos.delete(historicoTextos.keys().next().value);

  return iguais + 1;
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

// Violação não é permanente: depois de HORAS_RESET_VIOLACOES sem infringir, a ficha da pessoa
// volta a zero. O relógio conta a partir da ÚLTIMA violação, não de um horário fixo do dia —
// ou seja, é preciso ficar 24h limpo pra zerar, não basta esperar a meia-noite.
const HORAS_RESET_VIOLACOES = Number(process.env.HORAS_RESET_VIOLACOES || 24);

// Lê a contagem já aplicando a expiração. Entende o formato antigo (número puro) pra não perder
// o que já está gravado em violations.json.
function lerViolacoes(chave) {
  const bruto = violationCounts.get(chave);
  if (bruto === null || bruto === undefined) return { contagem: 0, expirou: false, contagemAnterior: 0 };

  const contagem = typeof bruto === 'number' ? bruto : Number(bruto.contagem) || 0;
  const ultimaEm = typeof bruto === 'number' ? null : bruto.ultimaEm;
  if (!ultimaEm) return { contagem, expirou: false, contagemAnterior: contagem };

  const idadeMs = Date.now() - new Date(ultimaEm).getTime();
  if (Number.isFinite(idadeMs) && idadeMs >= HORAS_RESET_VIOLACOES * 3600_000) {
    return { contagem: 0, expirou: contagem > 0, contagemAnterior: contagem };
  }
  return { contagem, expirou: false, contagemAnterior: contagem };
}

function anotarViolacao(chave) {
  const antes = lerViolacoes(chave);
  const contagem = antes.contagem + 1;
  violationCounts.set(chave, { contagem, ultimaEm: new Date().toISOString() });
  persistViolacoes.agendarSalvar();
  return { contagem, expirou: antes.expirou, contagemAnterior: antes.contagemAnterior };
}

function zerarViolacoes(chave) {
  violationCounts.set(chave, { contagem: 0, ultimaEm: new Date().toISOString() });
  persistViolacoes.agendarSalvar();
}

// Fichas já expiradas não precisam ocupar espaço no arquivo. Roda uma vez no boot.
function limparViolacoesExpiradas() {
  let removidas = 0;
  for (const chave of [...violationCounts.keys()]) {
    const bruto = violationCounts.get(chave);
    if (typeof bruto === 'number' || !bruto?.ultimaEm) continue;
    if (Date.now() - new Date(bruto.ultimaEm).getTime() >= HORAS_RESET_VIOLACOES * 3600_000) {
      violationCounts.delete(chave);
      removidas++;
    }
  }
  if (removidas > 0) {
    persistViolacoes.agendarSalvar();
    console.log(`${removidas} ficha(s) de violação expiradas foram limpas (janela de ${HORAS_RESET_VIOLACOES}h).`);
  }
}

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
  mencionouNesteCiclo: false,
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
  const proximo = calcularProximoDisparo(cfg, new Date(), estadoDebate.get().ultimoCicloIniciadoEm);
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

let bootJaRegistrado = false;

async function registrarBoot() {
  // connectToWhatsApp() roda de novo a cada reconexão. Sem essa trava, cada queda de rede virava
  // um "boot" no boots.json e o contador — que existe justamente pra detectar crash-loop —
  // acusaria crash-loop onde havia só reconexão.
  if (bootJaRegistrado) return;
  bootJaRegistrado = true;

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
  // Busca pelo id puro; a chave composta é só pra achar o que ficou gravado no formato antigo.
  const registro = persistMensagensEnviadas.mapa.get(key.id)
    || persistMensagensEnviadas.mapa.get(`${key.remoteJid}:${key.id}`);
  // Este log é o único jeito de ver o pedido de reenvio acontecendo. O Baileys chama getMessage
  // quando o aparelho de alguém não decriptou e pediu a mensagem de volta. Achou = reenvia e o
  // "Aguardando mensagem" some. Não achou = a mensagem congela naquele estado pra sempre, e sem
  // esta linha isso acontece em silêncio absoluto.
  if (registro) {
    console.log(`[REENVIO] Mensagem ${key.id} pedida de volta e encontrada no cache — reenviando.`);
  } else {
    console.log(`[REENVIO] Mensagem ${key.id} pedida de volta e NÃO estava no cache (${persistMensagensEnviadas.mapa.size} guardada(s)) — vai ficar em "Aguardando mensagem".`);
    return undefined;
  }
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
    estadoConexao.flush(),
    historicoModeracao.flush(),
    persistRegras.flush(),
    configContas.flush(),
    configResposta.flush(),
    persistSaudacoes.flush(),
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
let contaConectada = null;    // qual conta o socket atual está usando
// Cada tentativa de conexão recebe um número. Se a conta mudar, o número muda junto e tudo que
// ficou agendado pela conexão anterior (reconexão em 5s, eventos de um socket morrendo) percebe
// que está velho e se cala. Sem isso, uma queda de rede segundos antes de você trocar de conta
// faria o timer antigo abrir um SEGUNDO socket depois da troca.
let geracaoConexao = 0;
let trocaEmAndamento = false; // suprime a reconexão automática durante troca ou desligamento
let currentQR = null;
let isConnected = false;
let tickerDebateIniciado = false;

// --- Pareamento por código de 8 dígitos ---
//
// Alternativa ao QR: em vez de apontar a câmera pra uma tela, você digita o número no painel,
// o WhatsApp devolve um código, e você digita esse código no celular em "Conectar com número
// de telefone". Some o problema todo de código expirado, foto de tela e câmera.
//
// 'numero' é o pedido em aberto (só dígitos, com DDI). 'codigo' é o que o WhatsApp devolveu —
// ele morre junto com o socket, exatamente como o QR, e por isso é zerado no 'close'.
let pareamento = { numero: null, codigo: null, pedidoEm: null, erro: null };

function limparPareamento() {
  pareamento = { numero: null, codigo: null, pedidoEm: null, erro: null };
}

// Guarda o que o bot mandou, pra poder REENVIAR quando o aparelho de alguém não conseguir
// decriptar. Quando isso acontece, o celular do destinatário pede a mensagem de volta e o Baileys
// chama getMessage() pra reencriptar e mandar de novo. Se getMessage devolver undefined, não há
// reenvio: a mensagem congela em "Aguardando mensagem. Essa ação pode levar alguns instantes"
// PARA SEMPRE, e nada no bot indica erro — do lado dele o envio foi um sucesso.
//
// Antes, só a enquete era guardada (linha do pollMsg). Todo aviso, anúncio e alerta ficava de
// fora, então todo texto do bot era irrecuperável. Sessão nova, com as chaves ainda assentando,
// é justamente quando mais se pede reenvio — que é o caso de um número pareado hoje.
function guardarMensagemEnviada(mensagemEnviada) {
  try {
    if (!mensagemEnviada?.key?.id || !mensagemEnviada?.message) return;
    // Guardado só pelo id da mensagem, NUNCA por `remoteJid:id`.
    //
    // O id do WhatsApp já é único. Compor com o remoteJid quebrava tudo, porque no envio ele vem
    // como número (5511986694787@s.whatsapp.net) e no pedido de reenvio o aparelho se identifica
    // pelo @lid (157728429347047@lid). Chaves diferentes, busca sempre vazia — provado no log:
    // "[ENVIO] id=3EB0281C..." seguido de "[REENVIO] 3EB0281C... NÃO estava no cache".
    persistMensagensEnviadas.mapa.set(mensagemEnviada.key.id, mensagemEnviada.message);
    // Teto pra não crescer sem fim: pedido de reenvio chega em minutos, não em dias.
    while (persistMensagensEnviadas.mapa.size > 300) {
      persistMensagensEnviadas.mapa.delete(persistMensagensEnviadas.mapa.keys().next().value);
    }
    persistMensagensEnviadas.agendarSalvar();
    // O id sai no log pra dar pra cruzar com as linhas de [REENVIO]. Sem ele não dá pra saber se
    // um pedido que não achou é de mensagem velha (anterior ao conserto) ou se o pedido chegou
    // antes de eu guardar — são causas diferentes, com consertos diferentes.
    console.log(`[ENVIO] id=${mensagemEnviada.key.id} guardada pra reenvio (${persistMensagensEnviadas.mapa.size} no cache).`);
  } catch (err) {
    console.error('Erro ao guardar mensagem enviada pra reenvio:', err.message);
  }
}

async function enviarComDigitando(jid, texto, mentions = []) {
  try {
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise((resolve) => setTimeout(resolve, 1200 + Math.random() * 1300));
    const mensagemEnviada = await sock.sendMessage(jid, mentions.length > 0 ? { text: texto, mentions } : { text: texto });
    await sock.sendPresenceUpdate('paused', jid);
    guardarMensagemEnviada(mensagemEnviada);
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
    guardarMensagemEnviada(pollMsg);

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
      // Guarda a DECISÃO, não recalcula depois. O anúncio de início do debate acontece 1h
      // adiante, quando `ultimaMencaoEm` já é hoje — recalcular ali daria sempre 0 dias e ele
      // nunca mencionaria, nem no dia certo. A decisão é uma por ciclo, tomada aqui.
      mencionouNesteCiclo: deveMencionar,
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
      // Compara com o valor guardado em vez de só preencher quando está vazio. Se a conta do bot
      // mudar (número novo = @lid novo), o JID antigo continuaria eternamente como primeira aposta
      // e nunca seria substituído, porque o campo já estava preenchido.
      if (resultado.criador && resultado.criador !== estado.pollCreatorConfirmado) {
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
          // DESEMPATE PELA ORDEM DA ENQUETE.
          //
          // `contagem` é um Map, e a ordem dele é a ordem em que os VOTOS foram processados, não
          // a ordem das opções na enquete. O reduce antigo (`b[1] > a[1] ? b : a`) mantinha o
          // primeiro do Map em caso de empate — ou seja, ganhava a opção que recebeu voto mais
          // cedo, o que da tela do WhatsApp parece aleatório.
          //
          // Empate agora vai pra opção listada primeiro na enquete, que é o critério visível pra
          // quem votou: 4 x 4 entre a 1ª e a 3ª opção dá a 1ª.
          const ordemNaEnquete = (estado.pollOpcoesEnviadas?.length ? estado.pollOpcoesEnviadas : estado.opcoes) || [];
          const posicao = (opcao) => {
            const i = ordemNaEnquete.indexOf(opcao);
            return i === -1 ? Number.MAX_SAFE_INTEGER : i;
          };
          const [opcaoVencedora, votosVencedor] = [...contagem.entries()].reduce((a, b) => {
            if (b[1] !== a[1]) return b[1] > a[1] ? b : a;
            return posicao(b[0]) < posicao(a[0]) ? b : a;
          });
          const empatadas = [...contagem.entries()].filter(([, n]) => n === votosVencedor);
          if (empatadas.length > 1) {
            console.log(`DIAGNÓSTICO ENQUETE: empate em ${votosVencedor} voto(s) entre [${empatadas.map(([o]) => o).join(' | ')}] — venceu "${opcaoVencedora}" por vir primeiro na enquete.`);
          }
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
        // Menção geral aqui segue a MESMA decisão da enquete deste ciclo.
        //
        // Antes este trecho marcava o grupo inteiro sempre, sem consultar nada e sem gravar
        // `ultimaMencaoEm`. Ou seja: o intervalo configurado no painel valia só pra metade dos
        // anúncios, e o outro anúncio marcava todo mundo TODO DIA. Num grupo de 40 pessoas isso
        // é uma parede de menções diária — e é exatamente o padrão que queima número.
        //
        // Dia de menção: marca todo mundo aqui também, como o dono pediu.
        // Dia comum: não marca ninguém. Quem está no grupo vê o anúncio do mesmo jeito.
        let jidsParaMencionar = [];
        if (estado.mencionouNesteCiclo) {
          try {
            const metadata = await sock.groupMetadata(estado.grupoId);
            jidsParaMencionar = metadata.participants.map((p) => p.id);
          } catch (err) {
            console.error('Erro ao buscar participantes pra mencionar no início do debate:', err.message);
          }
        }
        console.log(`Início do debate anunciado ${jidsParaMencionar.length > 0 ? `com menção geral (${jidsParaMencionar.length} pessoas)` : 'sem menção geral'}.`);
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
  'numeros-protegidos.json', 'marca-dagua-mensagens.json', 'boots.json', 'historico-moderacao.json', 'regras.json', 'contas.json', 'resposta-automatica.json', 'saudacoes-enviadas.json', 'estado-conexao.json'
]);

// Agora que sessão e dados moram em diretórios diferentes, a limpeza é trivial e segura: apaga
// a pasta da conta e pronto. Antes ela varria o AUTH_FOLDER inteiro e dependia de uma lista de
// exceções pra não levar os dados junto — foi assim que 'numeros-protegidos.json' quase sumiu.
async function limparCredenciaisAntigasDoBaileys(nomeConta = null) {
  const pasta = pastaDaConta(nomeConta || configContas.get().ativa);
  if (!pasta) return;
  try {
    const arquivos = await readdir(pasta).catch(() => []);
    await Promise.all(arquivos.map((nome) => unlink(path.join(pasta, nome)).catch(() => {})));
    console.log(`Sessão limpa (${arquivos.length} arquivo(s)) — dados do bot intactos. Gerando QR novo...`);
  } catch (err) {
    console.error('Erro ao limpar credenciais do Baileys:', err.message);
  }
}

// Guarda qual conta do WhatsApp o bot está usando. Trocar o número do bot gera um @lid novo, e
// algumas coisas gravadas ficam presas na conta antiga — em especial o pollCreatorConfirmado, que
// é a primeira aposta na hora de decriptar voto de enquete. Sem limpar, ele apontaria pra sempre
// pro JID do bot velho.
function detectarTrocaDeConta() {
  try {
    const atual = sock?.user?.id ? seguroNormalizar(sock.user.id) : null;
    if (!atual) return;

    if (contaConectada) {
      const cfg = configContas.get();
      const info = cfg.contas?.[contaConectada];
      if (info) {
        configContas.set({ contas: { ...cfg.contas, [contaConectada]: { ...info, ultimoJid: atual } } });
      }
    }

    const anterior = marcaDagua.get().contaDoBot || null;
    if (anterior === atual) return;

    marcaDagua.set({ contaDoBot: atual });

    if (!anterior) {
      console.log(`Conta do bot registrada: ${atual}`);
      return;
    }

    console.log(`🔄 Conta do bot mudou: ${anterior} -> ${atual}. Limpando o que estava preso na conta antiga.`);
    const estado = estadoDebate.get();
    if (estado.pollCreatorConfirmado) {
      estadoDebate.set({ pollCreatorConfirmado: null });
      console.log('   pollCreatorConfirmado zerado — será reaprendido no primeiro voto da próxima enquete.');
    }
    if (estado.fase === 'enquete') {
      console.log('   ⚠️ Havia uma enquete aberta criada pela conta antiga: os votos dela não vão decriptar. Use "Resetar ciclo" no /painel.');
    }
    persistMensagensEnviadas.mapa.clear();
    persistMensagensEnviadas.agendarSalvar();
    console.log('   Cache de mensagens enviadas limpo (as mensagens antigas eram da outra conta).');
  } catch (err) {
    console.error('Erro ao verificar troca de conta do bot:', err.message);
  }
}

// Troca a conta ativa (ou desliga, com nome = null) sem derrubar o processo. Fecha o socket
// atual, grava a escolha e reconecta. O flag trocaEmAndamento impede que o handler de 'close'
// dispare a reconexão automática no meio do caminho.
// ============================================================
// SOBREVIVER À QUEDA DE CONEXÃO
//
// O WhatsApp derruba sessão por motivos que não estão sob nosso controle: reinício do lado
// deles, conflito com outra sessão, rede da hospedagem. Não dá pra impedir a queda; dá pra
// impedir que ela vire uma janela longa de silêncio.
//
// Três coisas mudaram aqui:
//   1. Espera crescente entre tentativas, em vez de 5s fixos. Reconectar de 5 em 5 segundos
//      contra um servidor que está recusando é o que transforma queda de 1 minuto em bloqueio
//      de meia hora.
//   2. O motivo numérico da queda passou a ser registrado. Antes o log dizia só a mensagem de
//      erro, que às vezes vem vazia, e ficava impossível saber por que caiu.
//   3. Vigia de conexão morta em silêncio: socket meio aberto não dispara 'close', o bot acha
//      que está conectado e simplesmente para de receber mensagem. É o modo de falha mais
//      traiçoeiro, porque de fora parece que o bot está bem.
// ============================================================
const ESPERAS_RECONEXAO_MS = [3_000, 5_000, 10_000, 20_000, 40_000, 60_000, 120_000];
let tentativasReconexao = 0;
let ultimoSinalDeVida = Date.now();
let vigiaConexaoIniciado = false;

// ============================================================
// AVISO DE QUEDA NO PRIVADO
//
// Limitação que não dá pra contornar: o único jeito que o bot tem de mandar mensagem no WhatsApp
// é pelo socket que acabou de morrer. Avisar NO MOMENTO da queda é impossível — seria pedir pra
// ele usar exatamente aquilo que parou de funcionar.
//
// Então o aviso é gravado em disco quando cai e disparado quando volta, dizendo quanto tempo
// ficou fora e por quê. Gravar em disco (e não numa variável) é o que faz o aviso sobreviver
// quando o próprio processo morre e o Railway sobe outro: nesse caso a variável sumiria junto.
//
// O que isso NÃO cobre: bot que cai e não volta. Se o processo estiver morto, nada dentro dele
// avisa. Pra esse caso o que serve é um monitor externo batendo no /status de fora.
// ============================================================
const NUMERO_ALERTA = (process.env.NUMERO_ALERTA_QUEDA || '5511986694787').replace(/\D/g, '');
const QUEDA_MINIMA_PRA_AVISAR_MS = Number(process.env.QUEDA_MINIMA_PRA_AVISAR_MS || 60_000);
const INTERVALO_MINIMO_ENTRE_AVISOS_MS = Number(process.env.INTERVALO_MINIMO_ENTRE_AVISOS_MS || 15 * 60_000);

const estadoConexao = criarValorPersistente('estado-conexao.json', {
  caiuEm: null,
  motivo: null,
  ultimoAvisoEm: null
});

function registrarQueda(statusCode, mensagemErro) {
  // Só a PRIMEIRA queda da sequência conta. Reconexão que falha três vezes seguidas é uma queda
  // só do ponto de vista de quem está lendo o aviso, não três.
  if (estadoConexao.get().caiuEm) return;
  estadoConexao.set({
    caiuEm: Date.now(),
    motivo: `${statusCode ?? 'n/d'} (${nomeDoMotivo(statusCode)})${mensagemErro ? ' — ' + mensagemErro : ''}`
  });
}

function duracaoLegivel(ms) {
  const seg = Math.round(ms / 1000);
  if (seg < 60) return `${seg} segundo(s)`;
  const min = Math.round(seg / 60);
  if (min < 60) return `${min} minuto(s)`;
  const h = Math.floor(min / 60);
  return `${h}h${String(min % 60).padStart(2, '0')}`;
}

async function avisarQuedaSeHouver() {
  const estado = estadoConexao.get();
  if (!estado.caiuEm) return;

  const duracao = Date.now() - estado.caiuEm;
  const motivo = estado.motivo;
  // Limpa antes de tentar enviar: se o envio falhar, é melhor perder um aviso do que ficar com
  // uma queda velha gravada disparando aviso a cada reconexão pra sempre.
  estadoConexao.set({ caiuEm: null, motivo: null });

  if (duracao < QUEDA_MINIMA_PRA_AVISAR_MS) {
    console.log(`[ALERTA] Queda de ${duracaoLegivel(duracao)} — curta demais pra avisar.`);
    return;
  }
  const desdeUltimo = Date.now() - (estado.ultimoAvisoEm || 0);
  if (desdeUltimo < INTERVALO_MINIMO_ENTRE_AVISOS_MS) {
    console.log(`[ALERTA] Queda de ${duracaoLegivel(duracao)}, mas já avisei há ${duracaoLegivel(desdeUltimo)} — segurando pra não virar spam.`);
    return;
  }
  if (!NUMERO_ALERTA) return;

  try {
    // Resolve o JID pelo próprio WhatsApp em vez de montar na mão: número do Brasil tem a
    // pegadinha do nono dígito, e quem sabe o formato certo da conta é o servidor.
    let jid = `${NUMERO_ALERTA}@s.whatsapp.net`;
    try {
      const achado = await sock.onWhatsApp(NUMERO_ALERTA);
      if (achado?.[0]?.jid) jid = achado[0].jid;
      else console.log(`[ALERTA] ${NUMERO_ALERTA} não apareceu no onWhatsApp — tentando o JID montado na mão.`);
    } catch (err) {
      console.log('[ALERTA] onWhatsApp falhou, usando JID montado na mão:', err.message);
    }

    const avisoEnviado = await sock.sendMessage(jid, {
      text: `⚠️ O moderador ficou fora do ar por ${duracaoLegivel(duracao)} e acabou de voltar.\n\n`
        + `Motivo da queda: ${motivo}\n`
        + `Voltou em: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}\n\n`
        + `As mensagens desse período são resgatadas automaticamente, dentro da janela de ${HORAS_RESGATE}h.`
    });
    guardarMensagemEnviada(avisoEnviado);
    estadoConexao.set({ ultimoAvisoEm: Date.now() });
    console.log(`[ALERTA] Aviso de queda (${duracaoLegivel(duracao)}) enviado pra ${jid}.`);
  } catch (err) {
    console.error('[ALERTA] Não consegui avisar a queda no privado:', err.message);
  }
}

function marcarSinalDeVida() {
  ultimoSinalDeVida = Date.now();
}

function nomeDoMotivo(statusCode) {
  const nomes = Object.entries(DisconnectReason).find(([, v]) => v === statusCode);
  return nomes ? nomes[0] : 'desconhecido';
}

function esperaDaVez() {
  const base = ESPERAS_RECONEXAO_MS[Math.min(tentativasReconexao, ESPERAS_RECONEXAO_MS.length - 1)];
  // Jitter pra não bater no servidor sempre no mesmo instante depois de uma queda geral.
  return base + Math.floor(Math.random() * 2000);
}

// Reconexão agendada só vale se ninguém trocou de conta nesse meio-tempo.
function reconectarSeAindaForAVez(geracao, atraso) {
  setTimeout(() => {
    if (geracao !== geracaoConexao) {
      console.log('[CONTAS] Reconexão agendada cancelada: a conta ativa mudou nesse meio-tempo.');
      return;
    }
    connectToWhatsApp().catch((err) => console.error('Erro ao reconectar:', err.message));
  }, atraso);
}

// Pede o código de 8 dígitos ao WhatsApp.
//
// O momento de chamar isso é delicado: requestPairingCode manda um nó pela conexão, então exige
// o socket JÁ de pé, e exige a sessão ainda NÃO registrada. Chamar logo depois do makeWASocket
// costuma estourar "Connection Closed" porque o handshake não terminou. O gatilho usado é a
// chegada de um QR: quando o WhatsApp manda um QR, as duas condições estão provadas de uma vez.
async function pedirCodigoDePareamento(geracao) {
  const numero = pareamento.numero;
  if (!numero || !sock) return;
  try {
    const bruto = await sock.requestPairingCode(numero);
    // Socket trocou no meio do pedido: o código pertence a uma conexão que já morreu.
    if (geracao !== geracaoConexao) return;

    const limpo = String(bruto).replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const formatado = limpo.length === 8 ? `${limpo.slice(0, 4)}-${limpo.slice(4)}` : limpo;
    pareamento = { ...pareamento, codigo: formatado, pedidoEm: Date.now(), erro: null };
    console.log(`[PAREAMENTO] Código para +${numero}: ${formatado} — digite no celular em "Conectar com número de telefone".`);
  } catch (err) {
    if (geracao !== geracaoConexao) return;
    pareamento = { ...pareamento, codigo: null, pedidoEm: null, erro: err.message };
    console.error('[PAREAMENTO] Falha ao pedir o código:', err.message);
  }
}

// Roda uma vez só, independente de quantas reconexões aconteçam.
function iniciarVigiaDeConexao() {
  if (vigiaConexaoIniciado) return;
  vigiaConexaoIniciado = true;

  const SILENCIO_MAXIMO_MS = Number(process.env.SILENCIO_MAXIMO_MS || 10 * 60_000);

  setInterval(async () => {
    if (!isConnected || trocaEmAndamento || !sock) return;

    const silencio = Date.now() - ultimoSinalDeVida;
    if (silencio < SILENCIO_MAXIMO_MS) return;

    // Grupo parado é normal, então silêncio sozinho não prova nada. Antes de derrubar, cutuca a
    // conexão: se ela estiver viva, isto responde e renova o sinal de vida sem efeito nenhum
    // visível no grupo.
    try {
      await sock.sendPresenceUpdate('available');
      marcarSinalDeVida();
      return;
    } catch (err) {
      console.error(`[VIGIA] Conexão não respondeu após ${Math.round(silencio / 60000)}min de silêncio (${err.message}). Forçando reconexão.`);
    }

    isConnected = false;
    try { sock.end(new Error('vigia: conexão sem resposta')); } catch { /* já morto */ }
    reconectarSeAindaForAVez(geracaoConexao, 1000);
  }, 60_000);
}

// Reinicia o socket SEM trocar de conta. Existe por causa do pareamento: com creds.json na pasta
// o Baileys tenta retomar a sessão gravada e nunca aceita um pareamento novo — nem QR, nem código.
// Era o buraco do painel: só dava pra apagar a sessão de uma conta que NÃO estivesse ativa.
async function reiniciarSocket({ limparSessao = false } = {}) {
  geracaoConexao++;   // invalida timers e handlers da conexão anterior
  trocaEmAndamento = true;
  try {
    if (sock) {
      try { sock.end(undefined); } catch { /* socket já morto */ }
    }
    sock = null;
    isConnected = false;
    currentQR = null;
    // A ordem aqui não é cosmética. O socket que está morrendo ainda tem o handler de
    // 'creds.update' ligado no saveCreds da sessão ANTIGA — se a limpeza rodar antes de ele
    // terminar de fechar, um creds.json ressuscita depois do apagamento e o socket novo tenta
    // retomar a sessão morta em vez de parear. Espera fechar, DEPOIS apaga.
    await new Promise((r) => setTimeout(r, 1200));
    if (limparSessao) await limparCredenciaisAntigasDoBaileys();
  } finally {
    trocaEmAndamento = false;
  }
  connectToWhatsApp().catch((err) => console.error('[PAREAMENTO] Erro ao reconectar:', err.message));
}

async function trocarConta(nome) {
  geracaoConexao++;   // invalida timers e handlers da conexão anterior
  trocaEmAndamento = true;
  try {
    if (sock) {
      try { sock.end(undefined); } catch { /* socket já morto */ }
    }
    sock = null;
    isConnected = false;
    currentQR = null;
    limparPareamento();   // pedido de código de outra conta não sobrevive à troca
    contaConectada = null;

    configContas.set({ ativa: nome });
    await configContas.flush();

    await new Promise((r) => setTimeout(r, 1200));  // deixa o socket antigo terminar de fechar
  } finally {
    trocaEmAndamento = false;
  }

  if (nome) {
    connectToWhatsApp().catch((err) => console.error('[CONTAS] Erro ao conectar na conta nova:', err.message));
  } else {
    console.log('[CONTAS] Bot desligado — nenhuma conta ativa.');
  }
}

async function connectToWhatsApp() {
  await configContas.carregar();
  await migrarSessaoSolta();
  await Promise.all([
    persistContatos.carregar(),
    persistViolacoes.carregar(),
    configDebate.carregar(),
    estadoDebate.carregar(),
    persistTopicos.carregar(),
    persistMensagensEnviadas.carregar(),
    marcaDagua.carregar(),
    estadoConexao.carregar(),
    historicoModeracao.carregar(),
    persistRegras.carregar(),
    configContas.carregar(),
    configResposta.carregar(),
    persistSaudacoes.carregar(),
    registrarBoot(),
    semearListaDoEnvSeVazia(persistBanidos, 'NUMEROS_BANIDOS', 'Números banidos'),
    semearListaDoEnvSeVazia(persistLiberados, 'NUMEROS_LIBERADOS_DIVULGACAO', 'Números liberados pra divulgação'),
    garantirProtegidosDoDono()
  ]);
  // Sem isso, dedup zera a cada restart e a mesma mensagem pode ser moderada duas vezes.
  for (const id of marcaDagua.get().idsProcessados || []) processedMessageIds.add(id);
  limparViolacoesExpiradas();

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
  // Nenhuma conta ativa = bot desligado. Carrega os dados mesmo assim, pra que o painel continue
  // funcionando e você consiga religar por lá.
  const nomeConta = configContas.get().ativa;
  if (!nomeConta) {
    sock = null;
    isConnected = false;
    currentQR = null;
    limparPareamento();   // pedido de código de outra conta não sobrevive à troca
    contaConectada = null;
    console.log('[CONTAS] Nenhuma conta ativa — o bot está desligado. Ligue em /contas.');
    return;
  }

  const minhaGeracao = ++geracaoConexao;

  const pasta = pastaDaConta(nomeConta);
  if (!pasta) {
    console.error(`[CONTAS] Nome de conta inválido: "${nomeConta}". Bot não vai conectar.`);
    return;
  }
  await mkdir(pasta, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(pasta);
  contaConectada = nomeConta;
  console.log(`[CONTAS] Conectando com a conta "${nomeConta}".`);

  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Usando WhatsApp Web v${version.join('.')} (mais recente conhecida: ${isLatest})`);

  const identidade = BAILEYS_BROWSER.length === 3 ? BAILEYS_BROWSER : null;
  if (identidade) console.log(`[CONTAS] Identidade do cliente vinda de BAILEYS_BROWSER: ${identidade.join(' / ')}`);

  sock = makeWASocket({
    auth: state,
    version,
    // Espalhado condicionalmente: sem a variável, a chave 'browser' nem existe no objeto e o
    // Baileys segue com o padrão dele — exatamente o comportamento de antes desta mudança.
    ...(identidade ? { browser: identidade } : {}),
    logger: pino({ level: 'silent' }),
    getMessage
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    // Evento de um socket de geração anterior: ignora, quem manda agora é outro.
    if (minhaGeracao !== geracaoConexao) return;

    marcarSinalDeVida();
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Chegou QR = o handshake com o servidor do WhatsApp funcionou; o que falta é só alguém
      // escanear. Isso NÃO é falha de rede, então a espera não pode crescer por causa dele.
      // Antes, cada código expirado sem scan contava como queda e a escala subia até 120s —
      // o /qr recarregava a cada 15s e passava minutos em "Preparando o código…".
      tentativasReconexao = 0;

      // Pedido de pareamento por código em aberto: o QR é o gatilho (ver pedirCodigoDePareamento).
      // Nesse modo o QR não é publicado nem no painel nem no terminal: duas formas de parear na
      // mesma tela só criam chance de você escanear um e digitar o outro.
      if (pareamento.numero && !pareamento.codigo && !pareamento.erro) {
        currentQR = null;
        pedirCodigoDePareamento(minhaGeracao).catch((err) => console.error('[PAREAMENTO] Erro inesperado:', err.message));
      } else if (pareamento.numero) {
        currentQR = null;   // já tem código (ou erro) na tela: o QR não entra no meio
      } else {
        currentQR = qr;
        console.log('\n=== Escaneie este QR code no WhatsApp: Aparelhos conectados > Conectar aparelho ===\n');
        qrcode.generate(qr, { small: true });
      }
    }

    if (connection === 'close') {
      isConnected = false;
      // O QR morre junto com o socket: cada código só vale enquanto ESTE socket estiver de pé
      // esperando por ele. Sem zerar aqui, a variável guardava o último código e a página /qr
      // continuava desenhando um cadáver a cada recarga — o celular lia, não achava ninguém do
      // outro lado e respondia "Não foi possível conectar". Rescanear dava sempre o mesmo erro.
      currentQR = null;
      // Mesma coisa vale pro código de 8 dígitos: ele só é válido no socket que o pediu. O número
      // continua guardado, então o próximo socket pede um código novo sozinho.
      pareamento = { ...pareamento, codigo: null, pedidoEm: null };
      // Fechamento provocado por troca de conta ou desligamento: não reconectar, senão o socket
      // velho ressuscita e briga com o novo.
      if (trocaEmAndamento) {
        console.log('[CONTAS] Conexão encerrada de propósito (troca/desligamento).');
        return;
      }
      const statusCode = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode
        : undefined;

      // Motivos em que a credencial gravada não serve mais para nada. Reconectar com ela é
      // looping infinito e — pior — SILENCIOSO: com creds.json na pasta o Baileys tenta RETOMAR
      // a sessão em vez de parear, então nenhum QR é emitido e o painel fica eternamente em
      // "Ativa, conectando…". Números escritos na mão de propósito: DisconnectReason.forbidden
      // não existe em todas as versões do Baileys e um `undefined` no Set faria o 403 escapar.
      //   401 loggedOut — desvinculado no celular
      //   403 forbidden — número bloqueado/restrito pelo WhatsApp
      //
      // 411 e 500 chegaram a entrar aqui e FORAM RETIRADOS. Eles não tinham evidência no log,
      // vieram de precaução minha, e o custo de errar neles é o pior possível: apagar uma sessão
      // boa por causa de uma falha passageira, derrubar o bot e exigir pareamento na mão — que é
      // justamente o que faz a enquete do dia não sair. Na dúvida, reconectar é sempre mais
      // barato que apagar.
      const MOTIVOS_SEM_VOLTA = new Set([401, 403]);
      const shouldReconnect = !MOTIVOS_SEM_VOLTA.has(statusCode);

      // Outra sessão assumiu a conta (abriram o WhatsApp Web com o mesmo número). Reconectar
      // rápido aqui vira cabo de guerra: as duas sessões derrubam uma à outra em looping. Espera
      // longa e deixa a outra ponta se resolver.
      const sessaoSubstituida = statusCode === DisconnectReason.connectionReplaced;

      const atraso = sessaoSubstituida ? 60_000 : esperaDaVez();
      tentativasReconexao++;
      registrarQueda(statusCode, lastDisconnect?.error?.message);
      console.log(
        `Conexão fechada: ${lastDisconnect?.error?.message || 'sem mensagem'} | motivo=${statusCode ?? 'n/d'} (${nomeDoMotivo(statusCode)})`
        + ` | reconectar=${shouldReconnect} | tentativa ${tentativasReconexao} em ${Math.round(atraso / 1000)}s`
      );

      if (shouldReconnect) {
        reconectarSeAindaForAVez(minhaGeracao, atraso);
      } else {
        // 403 não se resolve com QR novo: o problema é a conta, não a credencial. Mas limpar e
        // gerar o código mesmo assim é o certo — é o que permite parear OUTRO número por ali.
        if (statusCode === 403) {
          console.error('🔴 [CONTAS] Motivo 403 (forbidden): o WhatsApp recusou esta conta. O número está bloqueado ou restrito.');
          console.error('🔴 Escanear de novo com o MESMO número não vai funcionar. Pareie outro número em /qr.');
        }
        console.log(`Sessão inutilizável (motivo ${statusCode ?? 'n/d'} — ${nomeDoMotivo(statusCode)}). Limpando credenciais e reiniciando pra gerar um QR novo.`);
        await limparCredenciaisAntigasDoBaileys();
        reconectarSeAindaForAVez(minhaGeracao, 3000);
      }
    } else if (connection === 'open') {
      currentQR = null;
      // Pareou: o pedido cumpriu a função. Deixar o número guardado faria a próxima queda de rede
      // disparar um pedido de código novo numa sessão que já está registrada.
      if (pareamento.numero) {
        console.log(`[PAREAMENTO] Concluído com sucesso para +${pareamento.numero}.`);
        limparPareamento();
      }
      isConnected = true;
      // Só zera depois de conectar de verdade. Zerar em 'connecting' faria a espera reiniciar do
      // começo a cada tentativa e o crescimento nunca aconteceria.
      if (tentativasReconexao > 0) {
        console.log(`Reconectado após ${tentativasReconexao} tentativa(s).`);
      }
      tentativasReconexao = 0;
      console.log('Conectado ao WhatsApp com sucesso.');
      detectarTrocaDeConta();
      iniciarVigiaDeConexao();
      avisarQuedaSeHouver().catch((err) => console.error('[ALERTA] Erro no aviso de queda:', err.message));
      if (!tickerDebateIniciado) {
        tickerDebateIniciado = true;
        setInterval(() => verificarCicloDebate().catch((err) => console.error('Erro no verificarCicloDebate:', err.message)), 60_000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    marcarSinalDeVida();
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
      // Conversa individual: não há moderação a fazer, mas pode haver resposta automática.
      await responderPrivadoSePreciso(msg, type, grupoId);
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

    // Registra ANTES do corte de protegidos: se o dono perguntou "alguém conhece um bom ômega 3?",
    // essa pergunta precisa estar no contexto mesmo sem ter ido pra moderação.
    guardarNaConversa(grupoId, remetente, texto, tipo);
    const mensagensRecentes = contarMensagensRecentes(`${grupoId}:${participant}`);
    // Protegido não é moderado, ponto final. Antes essa checagem existia só no /apagar e no
    // /registrar-violacao — o /avisar não tinha como checar, porque o n8n manda só grupo_id e
    // mensagem, sem dizer de quem é o aviso. Resultado: pessoa protegida levava aviso do bot.
    // Barrar aqui, antes de encaminhar, fecha os três caminhos de uma vez e ainda economiza a
    // chamada de IA.
    if (await participantEstaNaLista(participant, persistProtegidos.mapa)) {
      console.log(`[PROTEGIDO] Mensagem de ${remetente || participant} não foi enviada pra moderação.`);
      return;
    }

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
    } else if (tipo === 'figurinha') {
      // Faltava este ramo. A figurinha era encaminhada com texto vazio e midia_base64 nulo, ou
      // seja: a IA recebia uma mensagem sem conteúdo NENHUM e obviamente não achava nada errado.
      // Figurinha obscena passava batido não por permissividade do modelo, mas porque ninguém
      // nunca mostrou a imagem pra ele.
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        const convertida = await figurinhaParaImagem(buffer);
        midiaBase64 = convertida.base64;
        midiaMimeType = convertida.mime;
        console.log(`[FIGURINHA] Imagem anexada pra moderação (${convertida.mime}${conteudo.stickerMessage?.isAnimated ? ', animada' : ''}). id=${msgId}`);
      } catch (err) {
        console.error('Erro ao baixar figurinha:', err.message);
      }
    }

    const estadoAtualDebate = estadoDebate.get();
    const debateAtivo = estadoAtualDebate.fase === 'debate' && estadoAtualDebate.grupoId === grupoId;

    // Só agora a mídia está baixada, então é aqui que dá pra comparar arquivo com arquivo.
    const vezesQueRepetiu = contarRepeticoes(
      `${grupoId}:${participant}`,
      texto,
      impressaoDaMidia(midiaBase64, audioBase64, framesBase64)
    );

    const payload = {
      grupo_id: grupoId,
      message_id: msgId,
      participant,
      remetente,
      tipo,
      texto,
      duracao_segundos: duracaoSegundos,
      mensagens_recentes_60s: mensagensRecentes,
      // Quantas vezes ESTA mensagem apareceu nos últimos 5 min, contando a atual.
      // 1 = inédita. 2+ = repetida. É este o campo que o prompt deve usar pra julgar spam.
      mensagens_identicas_5min: vezesQueRepetiu,
      mensagem_repetida: vezesQueRepetiu >= 2,
      // Contexto: o que veio antes e a quem esta mensagem responde. É o que permite separar
      // recomendação (link pedido ou encaixado na conversa) de divulgação (link solto).
      conversa_recente: conversaAntesDe(grupoId),
      respondendo_a: mensagemCitada(conteudo),
      // Título e descrição que o WhatsApp puxou do destino do link. É o que permite julgar um
      // link solto, sem nenhum texto acompanhando.
      previa_link: extrairPreviaLink(conteudo),
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

// Porteiro de TODAS as rotas. Registrado aqui em cima de propósito: middleware vale só pro que
// vem depois, então qualquer rota nova nasce protegida sem ninguém precisar lembrar disso.
// A /qr era a mais perigosa estando aberta — quem carregasse aquela página podia escanear o QR
// e vincular o próprio aparelho à conta do bot.
app.use((req, res, next) => {
  if (ROTAS_PUBLICAS.has(req.path)) return next();
  if (estaAutenticado(req)) return next();

  // Chamada de máquina (n8n, curl) recebe erro; navegador vai pra tela de login.
  const querJson = req.headers.accept?.includes('application/json') || req.method !== 'GET';
  if (querJson && !req.headers.accept?.includes('text/html')) {
    return res.status(401).json({ erro: 'não autorizado' });
  }
  const destino = encodeURIComponent(req.originalUrl || '/painel');
  res.redirect(`/login?de=${destino}`);
});

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

// Segunda via de pareamento, oferecida embaixo do QR. Some quando um pedido está em andamento,
// porque aí a tela inteira já é sobre o código.
const FORMULARIO_CODIGO = `
  <details class="editor" style="margin-top:16px">
    <summary>Não consegue escanear? Parear digitando um código</summary>
    <div class="editor__corpo">
      <p class="editor__dica">O WhatsApp gera um código de 8 dígitos e você digita ele no celular, sem câmera. <strong>Isto apaga a sessão gravada desta conta</strong> e começa um pareamento do zero — use quando for conectar um número novo.</p>
      <form method="POST" action="/qr/codigo" onsubmit="return confirm('Apagar a sessão gravada desta conta e parear por código? Os dados do grupo não são afetados.')">
        <label class="campo">Número com DDI e DDD, só dígitos<input type="tel" name="numero" placeholder="5511986694787" inputmode="numeric" required></label>
        <button class="botao" type="submit">Gerar código</button>
      </form>
    </div>
  </details>`;

app.get('/qr', async (req, res) => {
  const cfg = configContas.get();
  const rotuloConta = cfg.ativa ? (cfg.contas?.[cfg.ativa]?.rotulo || cfg.ativa) : null;

  // Página separada de propósito: ela se recarrega sozinha a cada 15s porque o QR expira rápido,
  // e não faz sentido ficar recarregando a tela de contas por causa disso.
  // O QR roda mais rápido do que parece: o PRIMEIRO de cada ciclo vive 60s, os cinco seguintes
  // vivem 20s cada (medido no log: 19 trocas de 20s contra 4 de 60s). Com recarga de 15s, o
  // código na tela podia estar a 15s de vida de um total de 20 — você escaneava um cadáver e o
  // celular respondia "Não foi possível conectar". 5s limita o atraso a 1/4 da vida do código.
  const autoRefresh = !isConnected ? '<script>setTimeout(() => location.reload(), 5000);</script>' : '';

  let miolo;
  if (!cfg.ativa) {
    miolo = `
      <div class="painel-qr painel-qr--neutro">
        <h2>Bot desligado</h2>
        <p>Não há conta ativa pra parear. Ative uma conta primeiro.</p>
        <a class="botao-link" href="/contas">Ir para Contas</a>
      </div>`;
  } else if (isConnected) {
    miolo = `
      <div class="painel-qr painel-qr--ok">
        <h2>✅ Já conectado</h2>
        <p>A conta <strong>${escapeHtml(rotuloConta)}</strong> está pareada e no ar. Não precisa escanear nada.</p>
        <a class="botao-link" href="/contas">Voltar para Contas</a>
      </div>`;
  } else if (pareamento.erro) {
    miolo = `
      <div class="painel-qr painel-qr--neutro">
        <h2>O WhatsApp recusou o pedido</h2>
        <p>Não foi possível gerar o código para <strong>+${escapeHtml(pareamento.numero || '')}</strong>:</p>
        <p class="pareamento__erro">${escapeHtml(pareamento.erro)}</p>
        <p class="nota">Causas comuns: número digitado errado (precisa do DDI 55 e do DDD), número sem WhatsApp ativo, ou conta restrita.</p>
        <form method="POST" action="/qr/cancelar-codigo">
          <button class="botao" type="submit">Voltar para o QR code</button>
        </form>
      </div>`;
  } else if (pareamento.numero && pareamento.codigo) {
    miolo = `
      <div class="painel-qr">
        <h2>Digite este código no celular<br><em>+${escapeHtml(pareamento.numero)}</em></h2>
        <p class="pareamento__codigo">${escapeHtml(pareamento.codigo)}</p>
        <p>No aparelho: <strong>Aparelhos conectados → Conectar aparelho → Conectar com número de telefone</strong></p>
        <p class="nota">O código vale poucos minutos. Se expirar, esta página gera outro sozinha — sempre use o que estiver na tela agora, nunca um anotado antes.</p>
        <form method="POST" action="/qr/cancelar-codigo">
          <button class="botao-secundario" type="submit">Cancelar e usar QR code</button>
        </form>
      </div>`;
  } else if (pareamento.numero) {
    miolo = `
      <div class="painel-qr painel-qr--esperando">
        <h2>Pedindo o código…</h2>
        <p>Gerando o código de 8 dígitos para <strong>+${escapeHtml(pareamento.numero)}</strong>. Esta página se atualiza sozinha.</p>
        <form method="POST" action="/qr/cancelar-codigo">
          <button class="botao-secundario" type="submit">Cancelar</button>
        </form>
      </div>`;
  } else if (!currentQR) {
    miolo = `
      <div class="painel-qr painel-qr--esperando">
        <h2>Preparando o código…</h2>
        <p>O QR da conta <strong>${escapeHtml(rotuloConta)}</strong> aparece aqui em alguns segundos. Esta página se atualiza sozinha.</p>
      </div>
      ${FORMULARIO_CODIGO}`;
  } else {
    try {
      const imagem = await QRCode.toDataURL(currentQR, { width: 300 });
      miolo = `
      <div class="painel-qr">
        <h2>Escaneie com o número da conta<br><em>${escapeHtml(rotuloConta)}</em></h2>
        <p>No celular: <strong>Aparelhos conectados → Conectar aparelho</strong></p>
        <img src="${imagem}" width="300" height="300" alt="QR code para parear">
        <p class="nota">O código expira em segundos. Esta página se atualiza sozinha a cada 5s. Escaneie o código que estiver na tela AGORA — cada um vive 20 segundos.</p>
        <a class="botao-link" href="/contas">Voltar para Contas</a>
      </div>
      ${FORMULARIO_CODIGO}`;
    } catch (err) {
      miolo = `<div class="painel-qr painel-qr--neutro"><h2>Erro ao gerar o QR</h2><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  res.send(paginaHtml({
    titulo: 'Parear número',
    ativo: '/contas',
    largura: 560,
    scriptExtra: autoRefresh,
    cssExtra: `
    .painel-qr { background: var(--superficie); border: 1px solid var(--dourado); border-radius: 14px; padding: 26px 20px; margin-top: 18px; text-align: center; }
    .painel-qr--ok { border-color: var(--verde); }
    .painel-qr--neutro { border-color: var(--linha); }
    .painel-qr--esperando { border-style: dashed; }
    .painel-qr h2 { font-family: 'Fraunces', Georgia, serif; font-size: 20px; font-weight: 600; margin: 0 0 8px; line-height: 1.35; }
    .painel-qr h2 em { font-style: normal; color: var(--dourado); }
    .painel-qr p { margin: 0 0 16px; font-size: 13.5px; color: var(--apagado); }
    .painel-qr img { display: block; margin: 0 auto 16px; border-radius: 10px; max-width: 100%; height: auto; }
    .painel-qr .nota { font-size: 12.5px; }
    .pareamento__codigo { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 40px; font-weight: 600; letter-spacing: 0.08em;
                          color: var(--tinta) !important; background: var(--papel); border: 1px dashed var(--dourado); border-radius: 12px;
                          padding: 18px 10px; margin: 4px 0 16px !important; user-select: all; word-break: break-all; }
    .pareamento__erro { background: var(--vermelho-suave); color: #7A2A20 !important; border-radius: 8px; padding: 10px 13px; font-size: 13.5px; }
    .botao-link { display: inline-block; font-weight: 600; font-size: 13.5px; text-decoration: none; color: var(--tinta); background: var(--papel); border: 1px solid var(--linha); padding: 9px 16px; border-radius: 8px; }
    .botao-link:hover { border-color: var(--tinta); }`,
    corpo: `
    <header class="cabecalho">
      <h1>Parear número</h1>
      <p>Conectar um número de WhatsApp à conta ativa do bot.</p>
    </header>
    ${miolo}`
  }));
});

app.post('/qr/codigo', (req, res) => {
  if (!configContas.get().ativa) return res.redirect('/qr');

  const numero = String(req.body.numero || '').replace(/\D/g, '');
  // 10 = menor número plausível com DDI. 15 = teto do padrão E.164.
  if (numero.length < 10 || numero.length > 15) {
    pareamento = {
      numero: numero || null,
      codigo: null,
      pedidoEm: null,
      erro: 'Número fora do formato esperado. Use DDI + DDD + número, só dígitos — ex.: 5511986694787.'
    };
    return res.redirect('/qr');
  }

  pareamento = { numero, codigo: null, pedidoEm: null, erro: null };
  console.log(`[PAREAMENTO] Pedido aberto para +${numero} na conta "${configContas.get().ativa}". Apagando a sessão gravada e subindo um socket limpo.`);

  // Responde primeiro: a reinicialização leva alguns segundos e não há motivo pra segurar o
  // navegador esperando. A página se atualiza sozinha e mostra o código quando ele chegar.
  res.redirect('/qr');
  reiniciarSocket({ limparSessao: true }).catch((err) => console.error('[PAREAMENTO] Falha ao reiniciar:', err.message));
});

app.post('/qr/cancelar-codigo', (req, res) => {
  const tinhaPedido = !!pareamento.numero;
  limparPareamento();
  res.redirect('/qr');
  // Sem sessão gravada (ela foi apagada ao abrir o pedido), o socket novo cai direto no QR.
  // Sem reiniciar, o painel esperaria o rodízio de códigos do socket atual — até um minuto.
  if (tinhaPedido) {
    console.log('[PAREAMENTO] Pedido cancelado. Voltando pro QR code.');
    reiniciarSocket().catch((err) => console.error('[PAREAMENTO] Falha ao reiniciar:', err.message));
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
  { href: '/banidos', rotulo: 'Banidos', icone: '🚫' },
  { href: '/contas', rotulo: 'Contas', icone: '📱' },
  { href: '/resposta', rotulo: 'Resposta automática', icone: '💬' }
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
    .menu__sair { margin: 0 0 0 auto; padding-left: 8px; }
    .menu__sair button { font: inherit; font-size: 13px; color: var(--apagado); background: none; border: none; cursor: pointer; padding: 8px 4px; white-space: nowrap; }
    .menu__sair button:hover { color: var(--vermelho); text-decoration: underline; }

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
    <nav class="menu">${menu}<form method="POST" action="/logout" class="menu__sair"><button type="submit">Sair</button></form></nav>
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
    .campo__dica { font-weight: 400; color: var(--apagado); }
    .diagnostico { margin-top: 26px; border-top: 1px solid var(--linha); padding-top: 14px; }
    .diagnostico summary { cursor: pointer; font-size: 13px; color: var(--apagado); letter-spacing: .04em; text-transform: uppercase; }
    .diagnostico summary::marker { color: var(--apagado); }
    .diagnostico form { margin-top: 12px; }
    .caixinha { display: flex; gap: 10px; align-items: flex-start; margin: 16px 0 4px; font-size: 13.5px; line-height: 1.45; cursor: pointer; }
    .caixinha input { margin-top: 2px; width: 17px; height: 17px; flex: none; accent-color: var(--dourado); }
    .caixinha small { display: block; font-weight: 400; color: var(--apagado); font-size: 12.5px; }
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
            <span class="ticket__detalhe">Última menção geral: ${estado.ultimaMencaoEm ? new Date(estado.ultimaMencaoEm).toLocaleString('pt-BR', { timeZone: FUSO_HORARIO }) : 'nunca — o próximo ciclo vai mencionar'}</span>
            ${estado.ultimaMencaoEm ? `<span class="ticket__detalhe">Menciona de novo a partir de ${new Date(new Date(estado.ultimaMencaoEm).getTime() + cfg.intervaloDiasMencao * 86400000).toLocaleDateString('pt-BR', { timeZone: FUSO_HORARIO })}</span>` : ''}
            <form method="POST" action="/painel/adiar-mencao">
              <button class="botao-secundario" type="submit">🔕 Contar o intervalo a partir de hoje</button>
            </form>
            <form method="POST" action="/painel/resetar" onsubmit="return confirm('Cancelar o ciclo de hoje? Libera o grupo se estiver preso em enquete/debate, devolve o tópico pra fila e marca o dia de hoje como já usado — nenhuma enquete nova sai hoje.')">
              <button class="botao-secundario" type="submit">⏹ Cancelar o ciclo de hoje</button>
            </form>
            <form method="POST" action="/painel/rodar-agora" onsubmit="return confirm('Disparar a enquete agora? Use só pra testar.')">
              <button class="botao-secundario" type="submit">▶ Rodar enquete agora (teste)</button>
            </form>
          </div>

          <section class="cartao">
            <p class="cartao__olho">Plano B</p>
            <h2>Começar debate na mão</h2>
            <p class="cartao__legenda">Pra quando a apuração falhar — troca de número no meio da enquete, queda longa. Você lê a contagem na tela do WhatsApp e informa aqui. Isso destranca o grupo, liga a moderação de fora do tema e anuncia.</p>
            <form method="POST" action="/painel/debate-manual" onsubmit="return confirm('Começar debate com este tema? Fora do tema conta pro banimento — confira o tema antes.')">
              <div class="grade-campos">
                <div class="campo campo--largo">
                  <label for="temaManual">Tema vencedor</label>
                  <input id="temaManual" name="tema" type="text" placeholder="Ex: É possível ser feliz sozinho?" required>
                </div>
                <div class="campo">
                  <label for="votosManual">Nº de votos <span class="campo__dica">(opcional)</span></label>
                  <input id="votosManual" name="votos" type="number" min="0" placeholder="Ex: 14">
                </div>
                <div class="campo">
                  <label for="horasManual">Duração (h)</label>
                  <input id="horasManual" name="horas" type="number" min="0.01" step="0.01" value="${cfg.duracaoDebateHoras}">
                </div>
              </div>
              <label class="caixinha">
                <input name="mencionar" type="checkbox" value="1">
                <span>Marcar todo mundo no anúncio <small>conta pro intervalo de menção geral</small></span>
              </label>
              <button class="botao" type="submit">▶ Iniciar debate com este tema</button>
            </form>
          </section>

          <details class="diagnostico">
            <summary>Diagnóstico de entrega</summary>
            <p class="cartao__legenda">Só serve quando o bot manda mensagem e alguém vê "Aguardando mensagem" no lugar do texto. Fora disso, não precisa abrir.</p>
            <form method="POST" action="/painel/testar-entrega">
              <button class="botao-secundario" type="submit">✉ Testar entrega no meu privado</button>
            </form>
            <form method="POST" action="/painel/resetar-sessao" onsubmit="return confirm('Apagar a sessão criptográfica deste contato? Não pede QR e não afeta ninguém mais — o bot só refaz a negociação com ele no próximo envio.')">
              <div class="campo">
                <label for="numeroSessao">Refazer a sessão deste número</label>
                <input id="numeroSessao" name="numero" type="text" inputmode="numeric" placeholder="Nº com DDI, ex: 5511986694787" value="${NUMERO_ALERTA}">
              </div>
              <button class="botao-secundario" type="submit">🔑 Refazer sessão</button>
            </form>
          </details>

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
  remocao_falhou: { texto: 'Remoção FALHOU', classe: 'vermelho', icone: '⚠️' },
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

app.post('/contas/ativar', async (req, res) => {
  const nome = String(req.body.conta || '').trim();
  const contas = configContas.get().contas || {};
  if (!contas[nome]) return res.redirect(`/contas?aviso=${encodeURIComponent('Conta não encontrada.')}`);
  trocarConta(nome).catch((err) => console.error('[CONTAS] Erro ao ativar:', err.message));
  res.redirect(`/contas?aviso=${encodeURIComponent(`Ativando "${contas[nome].rotulo || nome}". Recarregue em alguns segundos.`)}`);
});

app.post('/contas/desligar', async (req, res) => {
  trocarConta(null).catch((err) => console.error('[CONTAS] Erro ao desligar:', err.message));
  res.redirect(`/contas?aviso=${encodeURIComponent('Bot desligado. Ele não vai moderar nem enviar nada até você ativar uma conta.')}`);
});

app.post('/contas/adicionar', async (req, res) => {
  const rotulo = String(req.body.rotulo || '').trim() || 'Nova conta';
  const nome = String(req.body.nome || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30);
  if (!nome) return res.redirect(`/contas?aviso=${encodeURIComponent('Dê um apelido válido pra conta (letras e números).')}`);

  const atual = configContas.get();
  if (atual.contas?.[nome]) return res.redirect(`/contas?aviso=${encodeURIComponent('Já existe uma conta com esse apelido.')}`);

  await mkdir(pastaDaConta(nome), { recursive: true });
  configContas.set({ contas: { ...atual.contas, [nome]: { rotulo, criadaEm: new Date().toISOString(), ultimoJid: null } } });
  res.redirect(`/contas?aviso=${encodeURIComponent(`Conta "${rotulo}" criada. Ative ela e escaneie o QR com o número novo.`)}`);
});

app.post('/contas/remover', async (req, res) => {
  const nome = String(req.body.conta || '').trim();
  const atual = configContas.get();
  if (nome === atual.ativa) {
    return res.redirect(`/contas?aviso=${encodeURIComponent('Essa conta está ativa. Desligue o bot ou ative outra antes de remover.')}`);
  }
  if (!atual.contas?.[nome]) return res.redirect('/contas');

  await limparCredenciaisAntigasDoBaileys(nome);
  const contas = { ...atual.contas };
  delete contas[nome];
  configContas.set({ contas });
  res.redirect(`/contas?aviso=${encodeURIComponent('Conta removida e sessão apagada. Seus dados do grupo não foram tocados.')}`);
});

app.get('/login', (req, res) => {
  if (estaAutenticado(req)) return res.redirect('/painel');

  const de = typeof req.query.de === 'string' ? req.query.de : '/painel';
  const erro = req.query.erro;
  const semSenhaConfigurada = !PAINEL_SENHA;

  const avisos = {
    invalida: 'Senha incorreta.',
    bloqueado: 'Muitas tentativas. Espere 15 minutos e tente de novo.'
  };
  const aviso = erro && avisos[erro] ? `<p class="erro">${avisos[erro]}</p>` : '';

  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Entrar</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root { --tinta:#1B2340; --papel:#EEF0F4; --superficie:#FFFFFF; --dourado:#C99A2E; --vermelho:#B23A2E; --vermelho-suave:#F4DCD8; --linha:#DADCE3; --apagado:#5B6178; }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px;
           background:var(--papel); color:var(--tinta); font-family:'IBM Plex Sans',-apple-system,sans-serif; line-height:1.5; }
    .cartao { background:var(--superficie); border:1px solid var(--linha); border-radius:16px; padding:32px 28px; width:100%; max-width:380px; }
    h1 { font-family:'Fraunces',Georgia,serif; font-size:26px; font-weight:600; margin:0 0 6px; letter-spacing:-0.01em; }
    .sub { margin:0 0 22px; font-size:14px; color:var(--apagado); }
    label { display:block; font-size:13.5px; font-weight:500; margin-bottom:6px; }
    input { font:inherit; font-size:16px; width:100%; padding:12px 14px; border:1px solid var(--linha); border-radius:9px; background:var(--papel); color:var(--tinta); }
    input:focus-visible { outline:2px solid var(--dourado); outline-offset:1px; background:var(--superficie); }
    button { font:inherit; font-weight:600; font-size:15px; width:100%; margin-top:16px; padding:13px; border:none; border-radius:9px; background:var(--tinta); color:#fff; cursor:pointer; }
    button:hover { background:#10182E; }
    .erro { background:var(--vermelho-suave); color:#7A2A20; font-size:13.5px; padding:10px 13px; border-radius:8px; margin:0 0 16px; }
    .nota { margin:18px 0 0; font-size:12.5px; color:var(--apagado); }
    code { background:var(--papel); padding:2px 6px; border-radius:4px; font-size:12px; }
  </style>
</head>
<body>
  <div class="cartao">
    <h1>Painel do bot</h1>
    <p class="sub">Entre para continuar.</p>
    ${aviso}
    ${semSenhaConfigurada ? `
      <p class="erro">A variável <code>PAINEL_SENHA</code> não está configurada no Railway. Sem ela o painel não abre — defina a variável e reinicie o serviço.</p>
    ` : `
      <form method="POST" action="/login">
        <input type="hidden" name="de" value="${escapeHtml(de)}">
        <label for="senha">Senha</label>
        <input id="senha" name="senha" type="password" autocomplete="current-password" autofocus required>
        <button type="submit">Entrar</button>
      </form>
      <p class="nota">Este navegador fica conectado por ${DIAS_SESSAO_PAINEL} dias.</p>
    `}
  </div>
</body>
</html>`);
});

app.post('/login', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || 'desconhecido';
  const de = typeof req.body.de === 'string' && req.body.de.startsWith('/') ? req.body.de : '/painel';

  if (!PAINEL_SENHA) return res.redirect('/login');
  if (!podeTentarLogin(ip)) return res.redirect('/login?erro=bloqueado');

  if (!iguaisEmTempoConstante(req.body.senha || '', PAINEL_SENHA)) {
    registrarErroLogin(ip);
    console.log(`[LOGIN] Senha incorreta vinda de ${ip}.`);
    return res.redirect(`/login?erro=invalida&de=${encodeURIComponent(de)}`);
  }

  tentativasLogin.delete(ip);
  // Secure só quando a conexão é HTTPS, senão o cookie não gruda em teste local.
  const https = req.headers['x-forwarded-proto'] === 'https' || req.protocol === 'https';
  res.setHeader('Set-Cookie', [
    `${COOKIE_SESSAO}=${criarTokenSessao()}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${DIAS_SESSAO_PAINEL * 86400}`,
    ...(https ? ['Secure'] : [])
  ].join('; '));
  res.redirect(de);
});

app.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_SESSAO}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.redirect('/login');
});

app.post('/resposta', (req, res) => {
  const texto = String(req.body.texto || '').slice(0, 1500);
  const dias = Math.min(365, Math.max(0, Number(req.body.dias) || 0));
  const ativa = req.body.ativa === 'on';
  configResposta.set({ ativa, texto, diasParaRepetir: dias });
  res.redirect(`/resposta?aviso=${encodeURIComponent(ativa ? 'Resposta automática ligada.' : 'Resposta automática desligada.')}`);
});

app.post('/resposta/limpar', (req, res) => {
  persistSaudacoes.mapa.clear();
  persistSaudacoes.agendarSalvar();
  res.redirect(`/resposta?aviso=${encodeURIComponent('Histórico limpo. Todo mundo pode receber a saudação de novo.')}`);
});

app.get('/resposta', (req, res) => {
  const cfg = configResposta.get();
  const enviadas = [...persistSaudacoes.mapa.entries()]
    .sort((a, b) => new Date(b[1].quando) - new Date(a[1].quando))
    .slice(0, 40);

  const linhas = enviadas.map(([jid, info]) => `
      <li>
        <strong>${escapeHtml(info.nome || 'Sem nome')}</strong>
        <code class="copiavel" data-copiar="${escapeHtml(jid)}">${escapeHtml(jid)}</code>
        <time>${new Date(info.quando).toLocaleString('pt-BR', { timeZone: FUSO_HORARIO })}</time>
      </li>`).join('');

  res.send(paginaHtml({
    titulo: 'Resposta automática',
    ativo: '/resposta',
    largura: 680,
    cssExtra: `
    .estado { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; background: var(--superficie); border: 1px solid var(--linha); border-left: 5px solid var(--linha); border-radius: 12px; padding: 16px 18px; margin-top: 18px; }
    .estado--ligada { border-left-color: var(--verde); }
    .estado strong { display: block; font-family: 'Fraunces', Georgia, serif; font-size: 17px; margin-bottom: 2px; }
    .estado span { font-size: 13.5px; color: var(--apagado); }
    .cartao { background: var(--superficie); border: 1px solid var(--linha); border-radius: 12px; padding: 18px; margin-top: 16px; }
    .campo { display: block; font-size: 13.5px; font-weight: 500; margin-bottom: 14px; }
    .campo textarea { font: inherit; font-size: 15px; width: 100%; min-height: 130px; margin-top: 6px; padding: 12px 14px; border: 1px solid var(--linha); border-radius: 9px; background: var(--papel); color: var(--tinta); resize: vertical; line-height: 1.55; }
    .campo input[type=number] { font: inherit; font-family: 'IBM Plex Mono', monospace; width: 90px; margin-top: 6px; padding: 9px 11px; border: 1px solid var(--linha); border-radius: 8px; background: var(--papel); color: var(--tinta); }
    .campo textarea:focus-visible, .campo input:focus-visible { outline: 2px solid var(--dourado); outline-offset: 1px; background: var(--superficie); }
    .campo small { display: block; font-weight: 400; color: var(--apagado); font-size: 12.5px; margin-top: 4px; }
    .liga { display: flex; align-items: flex-start; gap: 10px; font-size: 14.5px; font-weight: 500; margin-bottom: 16px; }
    .liga input { width: 20px; height: 20px; margin: 1px 0 0; flex-shrink: 0; }
    .liga small { display: block; font-weight: 400; color: var(--apagado); font-size: 12.5px; margin-top: 3px; }
    .alerta { background: var(--dourado-suave); color: #6B4E14; border-radius: 9px; padding: 12px 14px; font-size: 13px; margin-top: 16px; line-height: 1.5; }
    .lista { list-style: none; padding: 0; margin: 12px 0 0; }
    .lista li { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; padding: 9px 0; border-bottom: 1px solid var(--linha); font-size: 13.5px; }
    .lista li:last-child { border-bottom: none; }
    .lista time { margin-left: auto; font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; color: var(--apagado); }
    .secao { margin-top: 30px; }
    .secao h2 { font-family: 'Fraunces', Georgia, serif; font-size: 20px; font-weight: 600; margin: 0 0 6px; }
    .vazio { color: var(--apagado); font-size: 13.5px; margin: 10px 0 0; }`,
    corpo: `
    <header class="cabecalho">
      <h1>Resposta automática</h1>
      <p>Responde quem manda mensagem no privado do número do bot. Funciona sem WhatsApp Business e com o celular desligado.</p>
    </header>
    ${req.query.aviso ? `<div class="aviso-sucesso">${escapeHtml(req.query.aviso)}</div>` : ''}

    <div class="estado ${cfg.ativa ? 'estado--ligada' : ''}">
      <div>
        <strong>${cfg.ativa ? 'Ligada' : 'Desligada'}</strong>
        <span>${cfg.ativa ? 'Quem escrever no privado recebe a mensagem abaixo.' : 'Mensagens privadas são ignoradas em silêncio.'}</span>
      </div>
    </div>

    <form class="cartao" method="POST" action="/resposta">
      <label class="liga">
        <input type="checkbox" name="ativa" ${cfg.ativa ? 'checked' : ''}>
        <span>Responder automaticamente no privado
          <small>Desmarque para desligar sem perder o texto.</small>
        </span>
      </label>

      <label class="campo">Mensagem
        <textarea name="texto" placeholder="O que responder a quem escrever no privado…">${escapeHtml(cfg.texto || '')}</textarea>
      </label>

      <label class="campo">Repetir depois de
        <input type="number" name="dias" min="0" max="365" value="${Number(cfg.diasParaRepetir) || 0}">
        <small>Dias de carência antes de responder a mesma pessoa de novo. O WhatsApp Business usa 14. Com 0, responde só uma vez e nunca mais.</small>
      </label>

      <button class="botao" type="submit">Salvar</button>

      <div class="alerta">
        <strong>Números protegidos não recebem esta mensagem.</strong> Se você testar mandando do seu próprio número, nada vai acontecer — o seu está na lista de protegidos. Teste com um número que não esteja lá.
      </div>

      <div class="alerta">
        <strong>Por que só uma vez por pessoa:</strong> responder toda mensagem de desconhecido é o padrão que a detecção de abuso do WhatsApp marca — e este grupo já foi suspenso uma vez. O bot também ignora sincronização de histórico e para em ${MAX_RESPOSTAS_POR_HORA} respostas por hora.
      </div>
    </form>

    <section class="secao">
      <h2>Já responderam (${persistSaudacoes.mapa.size})</h2>
      ${enviadas.length > 0
        ? `<ul class="lista">${linhas}</ul>
           <form method="POST" action="/resposta/limpar" onsubmit="return confirm('Limpar o histórico? Todo mundo pode receber a saudação de novo.')">
             <button class="botao-secundario" type="submit" style="margin-top:14px">Limpar histórico</button>
           </form>`
        : '<p class="vazio">Ninguém recebeu a saudação ainda.</p>'}
    </section>`
  }));
});

app.get('/contas', (req, res) => {
  const cfg = configContas.get();
  const contas = cfg.contas || {};
  const aviso = req.query.aviso ? `<div class="aviso-sucesso">${escapeHtml(req.query.aviso)}</div>` : '';

  const numeroDoBot = sock?.user?.id ? sock.user.id.split(':')[0].split('@')[0] : null;

  const cartoes = Object.entries(contas).map(([nome, info]) => {
    const ativa = cfg.ativa === nome;
    const conectada = ativa && isConnected;
    const estado = !ativa ? { txt: 'Parada', cls: 'neutro' }
      : conectada ? { txt: 'Ativa e conectada', cls: 'verde' }
      : { txt: 'Ativa, conectando…', cls: 'dourado' };

    return `
      <article class="conta ${ativa ? 'conta--ativa' : ''}">
        <div class="conta__topo">
          <div>
            <h3>${escapeHtml(info.rotulo || nome)}</h3>
            <code class="copiavel" data-copiar="${escapeHtml(nome)}">${escapeHtml(nome)}</code>
            ${ativa && numeroDoBot ? `<span class="conta__num">+${escapeHtml(numeroDoBot)}</span>` : ''}
          </div>
          <span class="selo-acao selo-acao--${estado.cls}">${estado.txt}</span>
        </div>
        ${info.ultimoJid ? `<p class="conta__jid">Último login: <code>${escapeHtml(info.ultimoJid)}</code></p>` : ''}
        <div class="conta__acoes">
          ${!ativa ? `<form method="POST" action="/contas/ativar"><input type="hidden" name="conta" value="${escapeHtml(nome)}"><button class="botao" type="submit">Ativar esta</button></form>` : ''}
          ${!ativa ? `<form method="POST" action="/contas/remover" onsubmit="return confirm('Remover a conta e apagar a sessão dela? Os dados do grupo não são afetados.')"><input type="hidden" name="conta" value="${escapeHtml(nome)}"><button class="botao-secundario" type="submit">Remover</button></form>` : ''}
        </div>
      </article>`;
  }).join('');

  const corpo = `
    <header class="cabecalho">
      <h1>Contas do bot</h1>
      <p>Mantenha vários números pareados e escolha qual está no ar — sem deslogar nenhum aparelho.</p>
    </header>
    ${aviso}

    <div class="chave-geral ${cfg.ativa ? 'chave-geral--ligado' : 'chave-geral--desligado'}">
      <div>
        <strong>${cfg.ativa ? 'Bot ligado' : 'Bot desligado'}</strong>
        <span>${cfg.ativa ? `Moderando pela conta "${escapeHtml(contas[cfg.ativa]?.rotulo || cfg.ativa)}".` : 'Nenhuma conta ativa. Nada é moderado, nenhuma enquete é disparada.'}</span>
      </div>
      ${cfg.ativa
        ? `<form method="POST" action="/contas/desligar" onsubmit="return confirm('Desligar o bot? Ele para de moderar e de disparar enquetes até você ativar uma conta.')"><button class="botao-secundario" type="submit">Desligar bot</button></form>`
        : ''}
    </div>

    ${cfg.ativa && !isConnected ? `
    <a class="chamada-qr" href="/qr">
      <div>
        <strong>Esta conta ainda não foi pareada</strong>
        <span>Abra a página do QR code e escaneie com o número desta conta.</span>
      </div>
      <span class="chamada-qr__seta">Abrir QR →</span>
    </a>` : ''}

    <section class="secao">
      <p class="secao__olho">Números pareados</p>
      <h2>Suas contas (${Object.keys(contas).length})</h2>
      ${cartoes || '<div class="vazio"><strong>Nenhuma conta</strong>Adicione uma abaixo.</div>'}
    </section>

    <details class="editor">
      <summary>Adicionar uma conta</summary>
      <div class="editor__corpo">
        <p class="editor__dica">Cada conta guarda a própria sessão. Depois de criar, clique em "Ativar esta" e escaneie o QR com o número novo. Seus dados do grupo (banidos, regras, histórico) são compartilhados entre todas.</p>
        <form method="POST" action="/contas/adicionar">
          <label class="campo">Apelido visível<input type="text" name="rotulo" placeholder="Ex: Número reserva" required></label>
          <label class="campo">Identificador (só letras, números e hífen)<input type="text" name="nome" placeholder="reserva" required></label>
          <button class="botao" type="submit">Criar conta</button>
        </form>
      </div>
    </details>`;

  res.send(paginaHtml({
    titulo: 'Contas do bot',
    ativo: '/contas',
    largura: 720,
    cssExtra: `
    .chamada-qr { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; text-decoration: none; color: inherit; background: var(--superficie); border: 1px solid var(--dourado); border-radius: 12px; padding: 15px 18px; margin-top: 16px; }
    .chamada-qr:hover { background: var(--dourado-suave); }
    .chamada-qr strong { display: block; font-family: 'Fraunces', Georgia, serif; font-size: 16px; margin-bottom: 2px; }
    .chamada-qr span { font-size: 13.5px; color: var(--apagado); }
    .chamada-qr__seta { font-weight: 600; font-size: 13.5px; color: #6B4E14 !important; white-space: nowrap; }
    .chave-geral { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; background: var(--superficie); border: 1px solid var(--linha); border-left: 5px solid var(--linha); border-radius: 12px; padding: 16px 18px; margin-top: 18px; }
    .chave-geral--ligado { border-left-color: var(--verde); }
    .chave-geral--desligado { border-left-color: var(--vermelho); }
    .chave-geral strong { display: block; font-family: 'Fraunces', Georgia, serif; font-size: 17px; margin-bottom: 2px; }
    .chave-geral span { font-size: 13.5px; color: var(--apagado); }
    .secao { margin-top: 30px; }
    .secao__olho { font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--dourado); font-weight: 500; margin: 0 0 4px; }
    .secao h2 { font-family: 'Fraunces', Georgia, serif; font-size: 21px; font-weight: 600; margin: 0 0 14px; }
    .conta { background: var(--superficie); border: 1px solid var(--linha); border-left: 5px solid var(--linha); border-radius: 12px; padding: 15px 17px; margin-bottom: 11px; }
    .conta--ativa { border-left-color: var(--verde); }
    .conta__topo { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .conta__topo h3 { font-family: 'Fraunces', Georgia, serif; font-size: 16.5px; font-weight: 600; margin: 0 0 5px; }
    .conta__num { display: inline-block; margin-left: 7px; font-size: 13px; color: var(--apagado); }
    .conta__jid { margin: 9px 0 0; font-size: 12.5px; color: var(--apagado); }
    .conta__acoes { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
    .conta__acoes form { margin: 0; }
    .conta__acoes .botao { margin-top: 0; padding: 8px 15px; font-size: 13px; }
    .selo-acao { font-size: 12px; font-weight: 600; padding: 4px 11px; border-radius: 999px; white-space: nowrap; }
    .selo-acao--verde { background: var(--verde-suave); color: #1F4A34; }
    .selo-acao--dourado { background: var(--dourado-suave); color: #6B4E14; }
    .selo-acao--neutro { background: var(--papel); color: var(--apagado); }
    .editor { background: var(--superficie); border: 1px solid var(--linha); border-radius: 12px; margin-top: 22px; overflow: hidden; }
    .editor summary { cursor: pointer; padding: 14px 18px; font-weight: 600; font-size: 14.5px; list-style: none; }
    .editor summary::-webkit-details-marker { display: none; }
    .editor[open] summary { border-bottom: 1px solid var(--linha); }
    .editor__corpo { padding: 16px 18px 18px; }
    .editor__dica { margin: 0 0 12px; font-size: 13px; color: var(--apagado); }
    .campo { display: block; font-size: 13.5px; font-weight: 500; margin-bottom: 11px; }
    .campo input { font: inherit; font-size: 14.5px; width: 100%; margin-top: 5px; padding: 10px 12px; border: 1px solid var(--linha); border-radius: 8px; background: var(--papel); color: var(--tinta); }
    .campo input:focus-visible { outline: 2px solid var(--dourado); outline-offset: 1px; background: var(--superficie); }
    .vazio { background: var(--superficie); border: 1px dashed var(--linha); border-radius: 12px; padding: 26px 20px; text-align: center; color: var(--apagado); font-size: 14px; }
    .vazio strong { display: block; font-family: 'Fraunces', Georgia, serif; font-size: 16px; color: var(--tinta); margin-bottom: 4px; }`,
    corpo
  }));
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

// Entrar em modo debate SEM depender da apuração da enquete.
//
// Existe porque a apuração pode falhar por motivo que não tem conserto — troca da conta do bot no
// meio da enquete, queda longa que fez o bot perder votos. Quando isso acontece, a contagem está
// na tela do WhatsApp, visível pro admin, e não está em lugar nenhum que o código alcance. Sem
// esta rota o único caminho era resetar e perder o ciclo.
//
// Importante: isto liga a moderação de fora do tema, que hoje CONTA pro banimento. Tema errado
// aqui significa apagar e punir quem está falando do assunto certo. O tema vem digitado à mão de
// propósito — é o admin afirmando qual é, não o código adivinhando.
// Manda uma mensagem no privado do admin. Serve pra duas coisas ao mesmo tempo:
//
// 1. TESTAR ENTREGA sem depender de alguém violar regra no grupo. Se chegar legível, o caminho
//    de texto do bot está inteiro; se chegar como "Aguardando mensagem", não está.
// 2. CONSERTAR a sessão. Quando o aparelho do admin tem sessão quebrada com o bot — o que
//    acontece depois de trocar de número ou deslogar, porque a identidade criptográfica muda —
//    a chave de grupo não chega nele e os avisos ficam ilegíveis SÓ pra ele. Uma troca no
//    privado obriga os dois lados a refazerem a sessão par a par, e aí o grupo volta a
//    renderizar. É o único caminho que reconstrói esse par: apagar conversa não resolve.
// Apaga a SESSÃO de um contato específico, sem tocar nas credenciais do bot.
//
// Existe porque reenviar não resolve sessão corrompida: o reenvio sai cifrado com a mesma sessão
// quebrada e chega ilegível de novo. Foi o que aconteceu — três mensagens foram reenviadas com
// sucesso pelo bot e continuaram em "Aguardando mensagem" no aparelho do admin.
//
// O Signal guarda uma sessão por destinatário, em arquivo separado dentro da pasta da conta.
// Apagar só o arquivo daquele contato obriga o Baileys a negociar tudo de novo com ele no próximo
// envio, e não afeta mais ninguém. O creds.json fica intacto, então NÃO pede QR e nenhuma outra
// sessão do grupo é perdida — é o oposto do logout, que apaga tudo e troca a identidade.
// Marca a menção geral como se tivesse acontecido agora, sem mencionar ninguém.
//
// Serve pra duas situações que dão no mesmo: pular a menção do próximo ciclo, e fazer o intervalo
// começar a contar de hoje. Faz falta porque `ultimaMencaoEm` nasce nulo, e nulo é tratado como
// "infinitos dias sem mencionar" — então o primeiro ciclo depois de configurar SEMPRE menciona
// todo mundo, por mais alto que esteja o intervalo. Era o que não dava pra evitar antes.
// Dispara o ciclo na hora, sem depender do relógio.
//
// Existe pra tirar o teste do caminho do agendamento. Antes, testar significava mexer no horário
// configurado e esperar — e era isso que produzia enquete repetida, porque salvar a configuração
// com horário à frente reagenda pro mesmo dia. Com um botão explícito, testar não interfere no
// agendamento de ninguém.
app.post('/painel/rodar-agora', async (req, res) => {
  if (estadoDebate.get().fase !== 'normal') {
    console.log('[CICLO MANUAL] Já existe enquete ou debate em andamento — nada foi feito.');
    return res.redirect('/painel?rodar=ocupado');
  }
  console.log('[CICLO MANUAL] Enquete disparada pelo painel.');
  iniciarCicloDebate().catch((err) => console.error('[CICLO MANUAL] Falhou:', err.message));
  res.redirect('/painel?rodar=1');
});

app.post('/painel/adiar-mencao', (req, res) => {
  estadoDebate.set({ ultimaMencaoEm: new Date().toISOString() });
  const cfg = configDebate.get();
  console.log(`[MENÇÃO] Contador zerado a partir de agora — próxima menção geral só depois de ${cfg.intervaloDiasMencao} dia(s).`);
  res.redirect('/painel?mencao=adiada');
});

app.post('/painel/resetar-sessao', async (req, res) => {
  const alvo = String(req.body.numero || '').replace(/\D/g, '');
  const pasta = pastaDaConta(configContas.get().ativa);
  if (!alvo || !pasta) return res.redirect('/painel?sessao=erro');

  try {
    const arquivos = await readdir(pasta).catch(() => []);
    // Nome de arquivo de sessão inclui o identificador do destinatário. Casa por número e também
    // por @lid, porque a mesma pessoa aparece nas duas formas neste ambiente.
    const lids = [...contatosVistos.entries()]
      .filter(([, info]) => (info?.numero || '').replace(/\D/g, '') === alvo)
      .map(([jid]) => jid.split('@')[0]);
    const pedacos = [alvo, ...lids];

    const alvos = arquivos.filter((nome) =>
      nome.startsWith('session-') && pedacos.some((p) => p && nome.includes(p))
    );

    for (const nome of alvos) {
      await unlink(path.join(pasta, nome)).catch(() => {});
    }

    console.log(`[SESSÃO] ${alvos.length} arquivo(s) de sessão apagado(s) para ${alvo}${lids.length ? ` (lids: ${lids.join(', ')})` : ''}. Credenciais intactas.`);
    if (alvos.length === 0) {
      console.log(`[SESSÃO] Nenhum arquivo casou. Existentes: ${arquivos.filter((n) => n.startsWith('session-')).join(', ') || 'nenhum'}`);
    }
    res.redirect(`/painel?sessao=${alvos.length}`);
  } catch (err) {
    console.error('[SESSÃO] Falhou:', err.message);
    res.redirect('/painel?sessao=erro');
  }
});

app.post('/painel/testar-entrega', async (req, res) => {
  if (!sock || !NUMERO_ALERTA) return res.redirect('/painel?entrega=erro');

  try {
    let jid = `${NUMERO_ALERTA}@s.whatsapp.net`;
    try {
      const achado = await sock.onWhatsApp(NUMERO_ALERTA);
      if (achado?.[0]?.jid) jid = achado[0].jid;
    } catch (err) {
      console.log('[TESTE ENTREGA] onWhatsApp falhou, usando JID montado na mão:', err.message);
    }

    const enviada = await sock.sendMessage(jid, {
      text: `🔧 Teste de entrega — ${new Date().toLocaleString('pt-BR', { timeZone: FUSO_HORARIO })}.\n\n`
        + `Se você está lendo isto, o texto do bot chega normalmente no seu aparelho.\n`
        + `Se apareceu "Aguardando mensagem", responda esta conversa com qualquer coisa: a troca no privado refaz a sessão e destrava os avisos no grupo.`
    });
    guardarMensagemEnviada(enviada);
    console.log(`[TESTE ENTREGA] Mensagem enviada pra ${jid}.`);
    res.redirect('/painel?entrega=1');
  } catch (err) {
    console.error('[TESTE ENTREGA] Falhou:', err.message);
    res.redirect('/painel?entrega=erro');
  }
});

app.post('/painel/debate-manual', async (req, res) => {
  const cfg = configDebate.get();
  const tema = String(req.body.tema || '').trim();
  const horas = Number(req.body.horas) || cfg.duracaoDebateHoras || 1;

  if (!tema || !cfg.grupoId) {
    console.error('[DEBATE MANUAL] Faltou tema ou grupo configurado — nada foi feito.');
    return res.redirect('/painel?debateManual=erro');
  }

  if (sock) {
    // A enquete tranca o grupo em só-admin. Se ela não chegou a fechar, quem destranca é aqui.
    try {
      await sock.groupSettingUpdate(cfg.grupoId, 'not_announcement');
    } catch (err) {
      console.error('[DEBATE MANUAL] Erro ao destrancar o grupo:', err.message);
    }
  }

  estadoDebate.set({
    fase: 'debate',
    grupoId: cfg.grupoId,
    tema,
    terminaEm: new Date(Date.now() + horas * 3600_000).toISOString(),
    // Zera o resto da enquete: os votos não servem mais e ficariam sujando a próxima apuração.
    pollMessageKey: null,
    votosAcumulados: [],
    votantesConhecidos: [],
    pollEncKeyB64: null,
    pollOpcoesEnviadas: [],
    pollCreatorCandidatos: [],
    pollCreatorConfirmado: null
  });

  console.log(`[DEBATE MANUAL] Debate iniciado pelo painel: "${tema}" por ${horas}h em ${cfg.grupoId}.`);

  if (sock) {
    try {
      // A contagem de votos é digitada pelo admin porque ela existe na tela do WhatsApp e não
      // existe em lugar nenhum que o código alcance quando a apuração falha. Fica opcional: sem
      // número, o anúncio simplesmente não menciona votação.
      const votos = parseInt(req.body.votos, 10);
      const abertura = Number.isFinite(votos) && votos > 0
        ? `✅ ${votos} ${votos === 1 ? 'pessoa votou' : 'pessoas votaram'} — o tema mais votado foi *${tema}*.`
        : `💬 O debate de hoje é sobre *${tema}*.`;

      // Menção geral só se o admin pedir na marca. E quando pede, GRAVA `ultimaMencaoEm` — assim
      // esta menção entra no mesmo contador que o ciclo automático consulta, em vez de virar uma
      // porta lateral que fura o intervalo configurado no painel.
      let jidsParaMencionar = [];
      if (req.body.mencionar) {
        try {
          const metadata = await sock.groupMetadata(cfg.grupoId);
          jidsParaMencionar = metadata.participants.map((p) => p.id);
        } catch (err) {
          console.error('[DEBATE MANUAL] Não consegui buscar participantes pra mencionar — anunciando sem menção:', err.message);
        }
      }
      const blocoMencoes = jidsParaMencionar.length > 0
        ? `\n\n${jidsParaMencionar.map((jid) => `@${jid.split('@')[0]}`).join(' ')}`
        : '';

      await enviarComDigitando(
        cfg.grupoId,
        `${abertura} O debate começa agora e vai durar ${horas}h — vamos manter o papo no tema!${blocoMencoes}`,
        jidsParaMencionar
      );

      if (jidsParaMencionar.length > 0) {
        estadoDebate.set({ ultimaMencaoEm: new Date().toISOString() });
        console.log(`[DEBATE MANUAL] ${jidsParaMencionar.length} participante(s) mencionado(s). ultimaMencaoEm atualizado.`);
      }
    } catch (err) {
      console.error('[DEBATE MANUAL] Erro ao anunciar no grupo:', err.message);
    }
  }

  res.redirect('/painel?debateManual=1');
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
    ultimaMencaoEm: null,
    mencionouNesteCiclo: false,
    // NÃO limpa `ultimoCicloIniciadoEm` — pelo contrário, marca hoje como já usado.
    //
    // Antes o reset apagava essa marca, e o efeito era o oposto do esperado: cancelar o ciclo
    // rearmava a enquete pro mesmo dia, bastando o horário configurado ainda estar à frente.
    // Aconteceu de verdade — três enquetes num dia. Cancelar tem que CANCELAR.
    // Pra rodar de novo hoje existe o botão "Rodar enquete agora", que é explícito.
    ultimoCicloIniciadoEm: new Date().toISOString()
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
  const { grupo_id, mensagem, participant } = req.body;
  if (!sock) return res.status(503).json({ erro: 'WhatsApp ainda não conectado' });
  if (!mensagem) return res.status(400).json({ erro: 'campo "mensagem" vazio' });

  // Segunda barreira: se o n8n disser de quem é o aviso, respeita a lista de protegidos aqui
  // também. Opcional de propósito — sem o campo, o comportamento continua igual ao de antes.
  if (participant && await participantEstaNaLista(participant, persistProtegidos.mapa)) {
    console.log(`[PROTEGIDO] Aviso para ${participant} bloqueado no /avisar.`);
    return res.json({ ok: true, ignorado: 'participante protegido' });
  }

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
  const { contagem, expirou, contagemAnterior } = anotarViolacao(chave);
  if (expirou) {
    console.log(`Ficha de ${participant} zerada antes desta violação: ${contagemAnterior} anterior(es) expiraram após ${HORAS_RESET_VIOLACOES}h sem infração.`);
  }

  const cache = buscarMensagemRecente(grupo_id, participant, req.body.message_id);
  const textoDaVez = req.body.texto || cache?.texto || '';
  const nomeDaVez = remetente || contatosVistos.get(participant)?.nome || null;

  let removido = false;

  let falhaRemocao = null;

  if (contagem >= REMOVE_THRESHOLD) {
    const resultado = await removerParticipante(grupo_id, participant);

    if (resultado.ok) {
      zerarViolacoes(chave);
      removido = true;
      const motivo = regra ? ` Regra violada: ${regra}.` : '';
      await enviarComDigitando(grupo_id, `⚠️ ${remetente || participant} foi removido do grupo automaticamente após atingir ${REMOVE_THRESHOLD} violações.${motivo}`);
    } else if (resultado.jaSaiu) {
      // Saiu por conta própria antes da punição: zera a ficha e não anuncia nada.
      zerarViolacoes(chave);
      console.log(`[REMOÇÃO] ${remetente || participant} já não estava no grupo.`);
    } else {
      // NÃO anuncia. Anunciar remoção que não aconteceu é pior que não anunciar:
      // o admin acha que foi resolvido e a pessoa continua no grupo.
      falhaRemocao = resultado.tentativas;
      console.error(`🔴 [REMOÇÃO FALHOU] ${remetente || participant} continua no grupo. Tentativas: ${JSON.stringify(resultado.tentativas)}`);
      console.error('🔴 Causa mais comum: o bot não é admin do grupo, ou perdeu o admin.');
      // Mantém a contagem no limite, pra tentar de novo na próxima violação.
    }
  }

  registrarEventoModeracao({
    acao: removido ? 'removido' : falhaRemocao ? 'remocao_falhou' : 'violacao',
    grupoId: grupo_id,
    participant,
    remetente: nomeDaVez,
    regra: regra ?? null,
    texto: textoDaVez,
    tipo: cache?.tipo || null,
    messageId: req.body.message_id || cache?.messageId || null,
    contagem: removido ? REMOVE_THRESHOLD : contagem
  });

  res.json({ ok: true, contagem, removido, falha_remocao: falhaRemocao });
});

app.listen(PORT, () => {
  console.log(`Servidor HTTP rodando na porta ${PORT}`);
});
