import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    downloadMediaMessage,
    decryptPollVote,
    jidNormalizedUser
} from '@whiskeysockets/baileys';
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
                await execAsync(
                    `ffmpeg -y -ss ${momentos[i]} -i "${entrada}" -frames:v 1 -q:v 3 "${saidaFrame}"`,
                    { timeout: 15000 }
                );
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
}

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const API_SECRET = process.env.API_SECRET;
const AUTH_FOLDER = process.env.AUTH_FOLDER || 'auth_info_baileys';
const PORT = process.env.PORT || 3000;
const REMOVE_THRESHOLD = parseInt(process.env.REMOVE_THRESHOLD || '2', 10);
const JANELA_FREQUENCIA_MS = 60000;
const FUSO_HORARIO = 'America/Sao_Paulo';

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

function éDiaDeSemana(data = new Date()) {
    const diaSemana = new Intl.DateTimeFormat('en-US', {
        timeZone: FUSO_HORARIO,
        weekday: 'short'
    }).format(data);
    return diaSemana !== 'Sat' && diaSemana !== 'Sun';
}

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

function calcularProximoDisparo(cfg, apartirDe = new Date()) {
    for (let diasAFrente = 0; diasAFrente <= 7; diasAFrente++) {
        const candidatoBase = new Date(apartirDe.getTime() + diasAFrente * 86_400_000);
        const dataISO = dataLocalISO(candidatoBase);
        const horarioAlvo = éDiaDeSemana(candidatoBase) ? cfg.horarioSemana : cfg.horario;
        const alvo = new Date(`${dataISO}T${horarioAlvo}:00-03:00`);
        if (alvo.getTime() > apartirDe.getTime()) return alvo;
    }
    return null;
}

function diasCalendarioEntre(dataMaisRecente, dataMaisAntiga) {
    const maisRecente = Date.parse(`${dataLocalISO(dataMaisRecente)}T00:00:00Z`);
    const maisAntiga = Date.parse(`${dataLocalISO(dataMaisAntiga)}T00:00:00Z`);
    return Math.round((maisRecente - maisAntiga) / 86_400_000);
}

function normalizarIdentificador(item) {
    const limpo = item.trim();
    if (limpo.includes('@')) return limpo;
    const somenteDigitos = limpo.replace(/\D/g, '');
    return `${somenteDigitos}@s.whatsapp.net`;
}

async function semearListaDoEnvSeVazia(persistStore, envVarNome, rotulo) {
    await persistStore.carregar();
    if (persistStore.mapa.size > 0) return;
    const bruto = (process.env[envVarNome] || '')
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean);
    if (bruto.length === 0) return;
    for (const item of bruto) {
        persistStore.mapa.set(normalizarIdentificador(item), {
            adicionadoEm: new Date().toISOString(),
            origem: 'env'
        });
    }
    persistStore.agendarSalvar();
    console.log(
        `${rotulo}: ${bruto.length} número(s) migrado(s) da variável de ambiente ${envVarNome} (só acontece uma vez, próxima execução já lê do arquivo).`
    );
}

function numeroBase(jid) {
    return jid.split('@')[0].split(':')[0];
}

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

const persistBanidos = criarMapaPersistente('numeros-banidos.json');
const persistLiberados = criarMapaPersistente('numeros-liberados.json');
const persistProtegidos = criarMapaPersistente('numeros-protegidos.json');

async function garantizarProtegidosDoDono() {
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

const processedMessageIds = new Set();
const recentMessageTimestamps = new Map();

function contarMensagensRecentes(chave) {
    const agora = Date.now();
    const lista = (recentMessageTimestamps.get(chave) || []).filter((t) => agora - t < JANELA_FREQUENCIA_MS);
    lista.push(agora);
    recentMessageTimestamps.set(chave, lista);
    return lista.length;
}

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

const persistViolacoes = criarMapaPersistente('violations.json');
const violationCounts = persistViolacoes.mapa;

const persistContatos = criarMapaPersistente('contatos.json');
const contatosVistos = persistContatos.mapa;

function registrarContatoVisto(participant, nome, grupoId, numero) {
    contatosVistos.set(participant, { nome, grupoId, numero, ultimaVez: new Date().toISOString() });
    persistContatos.agendarSalvar();
}

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

async function getMessage(key) {
    const registro = persistMensagensEnviadas.mapa.get(`${key.remoteJid}:${key.id}`);
    return registro || undefined;
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
        const mensagemEnviada = await sock.sendMessage(
            jid,
            mentions.length > 0 ? { text: texto, mentions } : { text: texto }
        );
        await sock.sendPresenceUpdate('paused', jid);
        return mensagemEnviada;
    } catch (err) {
        console.error('Erro ao enviar mensagem com efeito de digitação:', err.message);
        throw err;
    }
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

        const blocoMencoes =
            jidsParaMencionar.length > 0
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
        persistMensagensEnviadas.mapa.set(
            `${pollMsg.key.remoteJid}:${pollMsg.key.id}`,
            pollMsg.message
        );
        persistMensagensEnviadas.agendarSalvar();

        try {
            await sock.groupSettingUpdate(cfg.grupoId, 'announcement');
        } catch (err) {
            console.error('Erro ao ativar modo só-admin:', err.message);
        }
        try {
            await sock.groupJoinApprovalMode(cfg.grupoId, 'on');
        } catch (err) {
            console.error('Erro ao ligar aprovação de entrada:', err.message);
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
            ultimoCicloIniciadoEm: new Date().toISOString(),
            ultimaMencaoEm: deveMencionar ? new Date().toISOString() : estadoAtual.ultimaMencaoEm,
            proximoDisparoEm: null
        });

        console.log(`Ciclo de debate iniciado: "${topico.tema}" em ${cfg.grupoId}`);
    } catch (err) {
        console.error('Erro ao iniciar ciclo de debate:', err.message);
    }
}

function descobrirOpcaoDoVoto(votoEntry, ctx) {
    const { pollEncKey, pollMsgId, opcoesHash, botLidNormalizado, botPn } = ctx;
    const candidatosCriador = [botLidNormalizado, botPn].filter(Boolean);

    for (const pollCreatorJid of candidatosCriador) {
        try {
            const voteMsg = decryptPollVote(votoEntry.vote, {
                pollCreatorJid,
                pollMsgId,
                pollEncKey,
                voterJid: votoEntry.voterJid
            });
            const hashesEscolhidos = (voteMsg.selectedOptions || []).map((b) =>
                Buffer.from(b).toString('hex')
            );
            for (const [opcaoTexto, hashOpcao] of opcoesHash) {
                if (hashesEscolhidos.includes(hashOpcao)) return { opcao: opcaoTexto, decriptou: true };
            }
            return { opcao: null, decriptou: true };
        } catch {
            // tenta a próxima combinação de JID
        }
    }
    return { opcao: null, decriptou: false };
}

async function resolverEnquete() {
    const estado = estadoDebate.get();
    const cfg = configDebate.get();
    let debateComeca = false;
    let temaVencedor = null;

    try {
        const mensagemCriacao = await getMessage(estado.pollMessageKey);
        const totalVotantes = new Set(estado.votantesConhecidos).size;
        console.log(
            `DIAGNÓSTICO ENQUETE: votantesConhecidos=${totalVotantes}, votosAcumulados.length=${estado.votosAcumulados.length}, mensagemCriacao encontrada=${!!mensagemCriacao}`
        );

        const pollEncKey = mensagemCriacao?.messageContextInfo?.messageSecret;
        if (mensagemCriacao && pollEncKey && sock?.user) {
            try {
                const botPn = jidNormalizedUser(sock.user.id);
                const botLid = sock.user.lid ? jidNormalizedUser(sock.user.lid) : null;
                const opcoesHash = estado.opcoes.map((opcao) => [
                    opcao,
                    crypto.createHash('sha256').update(opcao, 'utf-8').digest('hex')
                ]);

                const contagem = new Map();
                let decriptados = 0;

                for (const votoEntry of estado.votosAcumulados) {
                    const resultado = descobrirOpcaoDoVoto(votoEntry, {
                        pollEncKey,
                        pollMsgId: estado.pollMessageKey.id,
                        opcoesHash,
                        botLidNormalizado: botLid,
                        botPn
                    });
                    if (resultado.decriptou) decriptados++;
                    if (resultado.opcao)
                        contagem.set(resultado.opcao, (contagem.get(resultado.opcao) || 0) + 1);
                }
                console.log(
                    `DIAGNÓSTICO ENQUETE: ${decriptados}/${estado.votosAcumulados.length} voto(s) decriptado(s). Contagem por opção:`,
                    JSON.stringify([...contagem])
                );

                if (contagem.size > 0) {
                    let maiorVoto = -1;
                    let opcoesVencedoras = [];

                    for (const [opcao, qtdVotos] of contagem.entries()) {
                        if (qtdVotos > maiorVoto) {
                            maiorVoto = qtdVotos;
                            opcoesVencedoras = [opcao];
                        } else if (qtdVotos === maiorVoto) {
                            opcoesVencedoras.push(opcao);
                        }
                    }

                    if (opcoesVencedoras.length > 0) {
                        const indiceAleatorio = Math.floor(Math.random() * opcoesVencedoras.length);
                        temaVencedor = opcoesVencedoras[indiceAleatorio];
                        console.log(
                            `DIAGNÓSTICO ENQUETE: Opção vencedora apurada: *${temaVencedor}* (Entre as mais votadas: ${opcoesVencedoras.join(', ')})`
                        );
                    }
                }
            } catch (errDecrypt) {
                console.error('DIAGNÓSTICO ENQUETE: erro tentando decriptar votos —', errDecrypt.message);
            }
        } else if (!pollEncKey) {
            console.error(
                'DIAGNÓSTICO ENQUETE: mensagemCriacao sem messageSecret — impossível decriptar na mão.'
            );
        }

        if (!temaVencedor) {
            if (estado.opcoes && estado.opcoes.length > 0) {
                temaVencedor = estado.opcoes[0];
                console.log(
                    `DIAGNÓSTICO ENQUETE: Fallback ativado. Usando a primeira opção da lista cadastrada: *${temaVencedor}*`
                );
            } else {
                temaVencedor = estado.tema || 'Tema Geral';
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
                    console.error('Erro ao buscar participantes pra mencionar:', err.message);
                }
                const blocoMencoes =
                    jidsParaMencionar.length > 0
                        ? `\n\n${jidsParaMencionar.map((jid) => `@${jid.split('@')[0]}`).join(' ')}`
                        : '';

                mensagemAnuncio = await enviarComDigitando(
                    estado.grupoId,
                    `✅ ${totalVotantes} pessoas votaram — o tema mais votado foi *${temaVencedor}*. O debate começa agora e vai durar ${cfg.duracaoDebateHoras}h!${blocoMencoes}`,
                    jidsParaMencionar
                );
            } catch (err) {
                console.error('Erro ao anunciar início do debate:', err.message);
            }
            if (mensagemAnuncio) {
                try {
                    await sock.sendMessage(estado.grupoId, {
                        pin: { type: 1, time: 86400, key: mensagemAnuncio.key }
                    });
                } catch (err) {
                    console.error('Erro ao fixar mensagem do debate:', err.message);
                }
            }
        } else {
            try {
                await enviarComDigitando(
                    estado.grupoId,
                    `📉 Só ${totalVotantes} voto(s) na enquete sobre *${estado.tema}* — não vai ter debate hoje.`
                );
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
        if (debateComeca) {
            estadoDebate.set({
                fase: 'debate',
                tema: temaVencedor,
                terminaEm: new Date(Date.now() + cfg.duracaoDebateHoras * 3600_000).toISOString(),
                pollMessageKey: null,
                votosAcumulados: [],
                votantesConhecidos: []
            });
        } else {
            estadoDebate.set({
                fase: 'normal',
                tema: null,
                opcoes: [],
                terminaEm: null,
                pollMessageKey: null,
                votosAcumulados: [],
                votantesConhecidos: []
            });
            atualizarProximoDisparo();
        }
    }
}

async function encerrarDebate() {
    const estado = estadoDebate.get();
    try {
        await sock.groupJoinApprovalMode(estado.grupoId, 'off');
        await enviarComDigitando(
            estado.grupoId,
            `🏁 O debate sobre *${estado.tema}* foi encerrado. Valeu a quem participou!`
        );
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
    'contatos.json',
    'violations.json',
    'config-debate.json',
    'estado-debate.json',
    'topicos-enquete.json',
    'mensagens-enviadas.json',
    'numeros-banidos.json',
    'numeros-liberados.json'
]);

async function limparCredenciaisAntigasDoBaileys() {
    try {
        const arquivos = await readdir(AUTH_FOLDER);
        const paraApagar = arquivos.filter((nome) => !ARQUIVOS_PROPRIOS_NO_AUTH_FOLDER.has(nome));
        await Promise.all(paraApagar.map((nome) => unlink(path.join(AUTH_FOLDER, nome)).catch(() => {})));
        console.log('Sessão antiga do Baileys limpa — dados do bot preservados.');
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
        garantizarProtegidosDoDono()
    ]);
    if (estadoDebate.get().fase === 'normal' && !estadoDebate.get().proximoDisparoEm) {
        atualizarProximoDisparo();
    }
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Usando WhatsApp Web v${version.join('.')}`);

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
            console.log('\n=== Escaneie este QR code no WhatsApp ===\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            isConnected = false;
            const statusCode =
                lastDisconnect?.error instanceof Boom
                    ? lastDisconnect.error.output?.statusCode
                    : undefined;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 5000);
            } else {
                await limparCredenciaisAntigasDoBaileys();
                setTimeout(connectToWhatsApp, 3000);
            }
        } else if (connection === 'open') {
            currentQR = null;
            isConnected = true;
            console.log('Conectado ao WhatsApp com sucesso.');
            if (!tickerDebateIniciado) {
                tickerDebateIniciado = true;
                setInterval(
                    () =>
                        verificarCicloDebate().catch((err) =>
                            console.error('Erro no verificarCicloDebate:', err.message)
                        ),
                    60_000
                );
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            await processarMensagem(msg).catch((err) =>
                console.error('Erro processando mensagem:', err.message)
            );
        }
    });

    sock.ev.on('group-participants.update', async (evento) => {
        if (evento.action !== 'add' || persistBanidos.mapa.size === 0) return;
        for (const participantJid of evento.participants) {
            if (await participantEstaNaLista(participantJid, persistProtegidos.mapa)) continue;
            if (await participantEstaNaLista(participantJid, persistBanidos.mapa)) {
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
        if (estado.fase !== 'enquete' || !estado.pollMessageKey) return;

        for (const { key, update } of updates) {
            if (!update.pollUpdates) continue;
            if (
                key.id !== estado.pollMessageKey.id ||
                key.remoteJid !== estado.pollMessageKey.remoteJid
            )
                continue;

            const estadoAgora = estadoDebate.get();
            const conjuntoVotantes = new Set(estadoAgora.votantesConhecidos);
            for (const u of update.pollUpdates) {
                const votanteJid = u.pollUpdateMessageKey?.participant;
                if (votanteJid) conjuntoVotantes.add(votanteJid);
            }
            estadoDebate.set({
                votosAcumulados: [...estadoAgora.votosAcumulados, ...update.pollUpdates],
                votantesConhecidos: [...conjuntoVotantes]
            });
        }
    });

    async function processarMensagem(msg) {
        if (!msg?.message) return;

        const msgId = msg.key.id;
        if (processedMessageIds.has(msgId)) return;
        processedMessageIds.add(msgId);
        if (processedMessageIds.size > 500) {
            processedMessageIds.delete(processedMessageIds.values().next().value);
        }

        if (msg.key.fromMe) return;

        const grupoId = msg.key.remoteJid;
        if (!grupoId || !grupoId.endsWith('@g.us')) return;

        const tipoConteudo = Object.keys(msg.message)[0];

        if (tipoConteudo === 'pollUpdateMessage') {
            const estado = estadoDebate.get();
            const votoMsg = msg.message.pollUpdateMessage;
            const éDaEnqueteAtual =
                estado.fase === 'enquete' &&
                estado.pollMessageKey &&
                votoMsg?.pollCreationMessageKey?.id === estado.pollMessageKey.id;
            if (éDaEnqueteAtual) {
                try {
                    const votanteJid = msg.key.participant || msg.participant || null;
                    const estadoAgora = estadoDebate.get();
                    const jaContabilizado =
                        votanteJid && estadoAgora.votantesConhecidos.includes(votanteJid);
                    estadoDebate.set({
                        votosAcumulados: [
                            ...estadoAgora.votosAcumulados,
                            {
                                pollUpdateMessageKey: msg.key,
                                vote: votoMsg.vote,
                                senderTimestampMs: votoMsg.senderTimestampMs,
                                voterJid: votanteJid
                            }
                        ],
                        votantesConhecidos:
                            votanteJid && !jaContabilizado
                                ? [...estadoAgora.votantesConhecidos, votanteJid]
                                : estadoAgora.votantesConhecidos
                    });
                } catch (err) {
                    console.error('Erro ao acumular voto de enquete via upsert:', err.message);
                }
            }
            return;
        }

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
                console.error('Erro ao processar áudio:', err.message);
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
                console.error('Erro ao processar vídeo:', err.message);
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

        if (!N8N_WEBHOOK_URL) return;

        try {
            const resp = await fetch(N8N_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        } catch (err) {
            console.error('Erro ao encaminhar pro n8n:', err.message);
        }
    }
}

connectToWhatsApp();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

function escapeHtml(valor) {
    return String(valor ?? '').replace(/[&<>"']/g, (c) =>
        ({ '&': '&', '<': '<', '>': '>', '"': '"', "'": ''' }[c])
    );
}

function checkAuth(req, res, next) {
    if (!API_SECRET) return next();
    if (req.headers['x-api-secret'] !== API_SECRET) {
        return res.status(401).json({ erro: 'não autorizado' });
    }
    next();
}

app.get('/health', (req, res) => {
    res.json({ ok: true, conectado: !!sock?.user });
});

app.get('/qr', async (req, res) => {
    const pagina = (miolo) =>
        `<html><head><meta http-equiv="refresh" content="15"></head><body style="font-family: sans-serif; text-align: center; padding: 40px;">${miolo}</body></html>`;
    if (isConnected) return res.send(pagina('✅ WhatsApp já conectado'));
    if (!currentQR) return res.send(pagina('Aguardando QR code...'));
    try {
        const dataUrl = await QRCode.toDataURL(currentQR, { width: 320 });
        res.send(
            pagina(
                `<h2>Escaneie no WhatsApp</h2><img src="${dataUrl}" width="320" height="320" alt="QR" />`
            )
        );
    } catch (err) {
        res.status(500).send('Erro: ' + err.message);
    }
});

app.get('/contatos', (req, res) => {
    const contatos = [...contatosVistos.entries()].sort(
        (a, b) => new Date(b[1].ultimaVez) - new Date(a[1].ultimaVez)
    );
    const linhasContatos = contatos
        .map(([id, info]) => {
            const estaBanido = persistBanidos.mapa.has(id);
            const estaLiberado = persistLiberados.mapa.has(id);
            let acoes = '';
            if (estaBanido)
                acoes += '<span class="selo selo--vermelho">🚫 Banido</span>';
            else
                acoes +=
                    `<form method="POST" action="/contatos/banir" class="form-inline"><input type="hidden" name="identificador" value="${id}"><button class="botao-mini" type="submit">🚫</button></form>`;
            if (estaLiberado)
                acoes += '<span class="selo selo--dourado">📣 Liberado</span>';
            else
                acoes +=
                    `<form method="POST" action="/contatos/liberar" class="form-inline"><input type="hidden" name="identificador" value="${id}"><button class="botao-mini" type="submit">📣</button></form>`;
            return `<tr data-busca="${escapeHtml(info.nome.toLowerCase())}"><td>${escapeHtml(info.nome)}</td><td><code>${id}</code></td><td>${info.numero || '—'}</td><td>${info.grupoId}</td><td>${new Date(info.ultimaVez).toLocaleString('pt-BR')}</td><td>${acoes}</td></tr>`;
        })
        .join('');

    res.send(`<html><body><table>${linhasContatos}</table></body></html>`);
});

app.post('/contatos/banir', (req, res) => {
    const identificador = normalizarIdentificador(req.body.identificador || '');
    if (!identificador || identificador === '@s.whatsapp.net')
        return res.status(400).send('inválido');
    if (persistProtegidos.mapa.has(identificador)) return res.redirect('/contatos');
    persistBanidos.mapa.set(identificador, {
        adicionadoEm: new Date().toISOString(),
        origem: 'painel'
    });
    persistBanidos.agendarSalvar();
    res.redirect('/contatos');
});

app.post('/contatos/banir/remover', (req, res) => {
    persistBanidos.mapa.delete(req.body.identificador || '');
    persistBanidos.agendarSalvar();
    res.redirect('/contatos');
});

app.post('/contatos/liberar', async (req, res) => {
    const identificador = normalizarIdentificador(req.body.identificador || '');
    persistLiberados.mapa.set(identificador, {
        adicionadoEm: new Date().toISOString(),
        origem: 'painel'
    });
    persistLiberados.agendarSalvar();
    if (persistBanidos.mapa.has(identificador)) {
        persistBanidos.mapa.delete(identificador);
        persistBanidos.agendarSalvar();
    }
    res.redirect('/contatos');
});

app.post('/contatos/liberar/remover', (req, res) => {
    persistLiberados.mapa.delete(req.body.identificador || '');
    persistLiberados.agendarSalvar();
    res.redirect('/contatos');
});

app.post('/contatos/proteger', (req, res) => {
    const identificador = normalizarIdentificador(req.body.identificador || '');
    persistProtegidos.mapa.set(identificador, {
        adicionadoEm: new Date().toISOString(),
        origem: 'painel'
    });
    persistProtegidos.agendarSalvar();
    res.redirect('/contatos');
});

app.post('/contatos/proteger/remover', (req, res) => {
    persistProtegidos.mapa.delete(req.body.identificador || '');
    persistProtegidos.agendarSalvar();
    res.redirect('/contatos');
});

app.get('/painel', (req, res) => {
    res.send(`<h1>Painel de Controle</h1>`);
});

app.post('/painel', (req, res) => {
    const {
        grupoId,
        intervaloDiasMencao,
        horario,
        horarioSemana,
        duracaoEnqueteHoras,
        duracaoDebateHoras,
        minVotosDebate
    } = req.body;
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

app.post('/painel/topico', (req, res) => {
    const { tema, opcoes } = req.body;
    const listaOpcoes = (opcoes || '')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean);
    const id = `t${Date.now()}`;
    topicosEnquete.set(id, {
        tema: tema.trim(),
        opcoes: listaOpcoes,
        usado: false,
        criadoEm: new Date().toISOString()
    });
    persistTopicos.agendarSalvar();
    res.redirect('/painel');
});

app.post('/painel/resetar', async (req, res) => {
    const estado = estadoDebate.get();
    if (estado.grupoId && sock) {
        try {
            await sock.groupSettingUpdate(estado.grupoId, 'not_announcement');
        } catch {}
        try {
            await sock.groupJoinApprovalMode(estado.grupoId, 'off');
        } catch {}
    }
    estadoDebate.set({
        fase: 'normal',
        tema: null,
        opcoes: [],
        terminaEm: null,
        pollMessageKey: null,
        votosAcumulados: [],
        votantesConhecidos: []
    });
    atualizarProximoDisparo();
    res.redirect('/painel');
});

app.post('/apagar', checkAuth, async (req, res) => {
    const { grupo_id, message_id, participant } = req.body;
    if (await participantEstaNaLista(participant, persistProtegidos.mapa))
        return res.json({ ok: true, ignorado: true });
    try {
        await sock.sendMessage(grupo_id, {
            delete: { remoteJid: grupo_id, id: message_id, participant, fromMe: false }
        });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ erro: err.message });
    }
});

app.post('/avisar', checkAuth, async (req, res) => {
    const { grupo_id, mensagem } = req.body;
    try {
        await enviarComDigitando(grupo_id, mensagem);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ erro: err.message });
    }
});

app.post('/registrar-violacao', checkAuth, async (req, res) => {
    const { grupo_id, participant, remetente } = req.body;
    if (await participantEstaNaLista(participant, persistProtegidos.mapa))
        return res.json({ ok: true, contagem: 0 });

    const chave = `${grupo_id}:${participant}`;
    const contagem = (violationCounts.get(chave) || 0) + 1;
    violationCounts.set(chave, contagem);
    persistViolacoes.agendarSalvar();

    if (contagem >= REMOVE_THRESHOLD) {
        try {
            await sock.groupParticipantsUpdate(grupo_id, [participant], 'remove');
            violationCounts.set(chave, 0);
            persistViolacoes.agendarSalvar();
            await enviarComDigitando(
                grupo_id,
                `⚠️ ${remetente || participant} removido após atingir limite de violações.`
            );
        } catch (err) {
            return res.status(500).json({ erro: err.message });
        }
    }
    res.json({ ok: true, contagem });
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
