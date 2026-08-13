const { Client, GatewayIntentBits, REST, Routes, Events, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ChannelType } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const TOKENS_PATH = path.join(__dirname, 'tokens.json');

let config = {};
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch {
  console.error('❌ config.json não encontrado');
  process.exit(1);
}

class TokenManager {
  constructor() {
    this.tokens = {};
    this.load();
  }
  load() {
    try {
      if (fs.existsSync(TOKENS_PATH)) {
        this.tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
      }
    } catch { this.tokens = {}; }
  }
  save() {
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(this.tokens, null, 2));
  }
  get(userId) { return this.tokens[userId] || null; }
  set(userId, token) {
    this.tokens[userId] = token;
    this.save();
  }
}
const tokenManager = new TokenManager();

let activeToken = '';
function setActiveToken(token) { activeToken = token; }

const TASK_TYPES = {
  'WATCH_VIDEO': '🎬 Vídeo',
  'WATCH_VIDEO_ON_MOBILE': '🎬 Vídeo',
  'PLAY_ON_DESKTOP': '🎮 Jogar',
  'PLAY_ON_XBOX': '🎮 Jogar',
  'PLAY_ON_PLAYSTATION': '🎮 Jogar'
};
const TASK_PRIORITY = ['PLAY_ON_DESKTOP', 'PLAY_ON_XBOX', 'PLAY_ON_PLAYSTATION', 'WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE'];

function jitter(base, range = 1500) { return base + Math.floor(Math.random() * range); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function formatTime(sec) { return `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`; }
function getTaskDuration(target) {
  if (target >= 60) {
    const m = Math.floor(target/60), s = target%60;
    return s > 0 ? `${m}min ${s}s` : `${m} minutos`;
  }
  return `${Math.floor(target)} segundos`;
}
function parseRewardText(r) {
  if (!r) return 'Recompensa desconhecida';
  if (r.type === 4) return `${r.orb_quantity} Orbs`;
  if (r.type === 3) return r.messages?.name || 'Decoração';
  if (r.type === 1) return r.messages?.name || 'Item';
  return 'Recompensa';
}
function getBestTask(tasks) {
  let selected = null, best = 999;
  for (const [type, data] of Object.entries(tasks)) {
    if (!TASK_TYPES[type]) continue;
    const p = TASK_PRIORITY.indexOf(type);
    if (p !== -1 && p < best) { best = p; selected = { taskType: type, taskData: data }; }
  }
  return selected;
}
function createProgressBar(current, total, size = 20) {
  const pct = Math.min(Math.floor((current/total)*100), 100);
  const filled = Math.round((pct/100)*size);
  const empty = size - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${pct}%`;
}

async function makeRequest(endpoint, method, body = null) {
  try {
    const headers = {
      'authorization': activeToken,
      'x-super-properties': config.xSuperProperties,
      'user-agent': config.userAgent,
      'accept-language': 'pt-BR,pt;q=0.9',
      'sec-ch-ua': '"Chromium";v="138", "Not=A?Brand";v="8"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'origin': 'https://discord.com',
      'referer': 'https://discord.com/channels/@me'
    };
    if (body) headers['content-type'] = 'application/json';
    const res = await axios({
      method,
      url: `https://discord.com/api/v9${endpoint}`,
      headers,
      data: body,
      validateStatus: () => true
    });
    return res;
  } catch { return { status: 500, data: null }; }
}

async function getUserInfo() {
  const res = await makeRequest('/users/@me', 'GET');
  if (res.status !== 200) return null;
  return res.data;
}
async function getOrbsBalance() {
  const res = await makeRequest('/users/@me/virtual-currency/balance', 'GET');
  if (res.status !== 200) return null;
  return res.data.balance || 0;
}

async function fetchAvailableQuests() {
  const res = await makeRequest('/quests/@me', 'GET');
  if (res.status !== 200 || !res.data?.quests) return [];
  const now = new Date();
  const result = [];
  for (const quest of res.data.quests) {
    if (new Date(quest.config.expires_at) < now) continue;
    if (quest.user_status?.completed_at) continue;
    const tasks = quest.config.task_config_v2?.tasks || {};
    const selected = getBestTask(tasks);
    if (!selected) continue;
    const target = selected.taskData.target || 0;
    const rewardText = parseRewardText(quest.config.rewards_config?.rewards?.[0]);
    result.push({
      questId: quest.id,
      questName: quest.config.messages.quest_name,
      taskType: selected.taskType,
      target,
      rewardText,
      isEnrolled: !!quest.user_status?.enrolled_at
    });
  }
  result.sort((a,b) => {
    const aOrbs = a.rewardText.includes('Orbs'), bOrbs = b.rewardText.includes('Orbs');
    if (aOrbs && !bOrbs) return -1;
    if (!aOrbs && bOrbs) return 1;
    return a.target - b.target;
  });
  return result;
}

async function runQuest(quest, logCallback, userId) {
  const { questId, taskType, target } = quest;
  let currentProgress = 0;
  const log = (msg) => { console.log(msg); if (logCallback) logCallback(msg); };

  log(`\n🚀 Iniciando: ${quest.questName}`);
  log(`   Tipo: ${TASK_TYPES[taskType] || taskType} | Duração: ${getTaskDuration(target)} | Recompensa: ${quest.rewardText}\n`);

  if (!quest.isEnrolled) {
    const enroll = await makeRequest(`/quests/${questId}/enroll`, 'POST', { location: 11, is_targeted: false, metadata_raw: null });
    if (enroll.status !== 200) {
      log(`   ❌ Falha ao se inscrever (status ${enroll.status})`);
      return false;
    }
    log('   ✅ Inscrito na missão');
  }

  if (taskType.startsWith('WATCH_')) {
    let timestamp = 0;
    while (currentProgress < target) {
      const res = await makeRequest(`/quests/${questId}/video-progress`, 'POST', { timestamp });
      if (res.status === 400 || res.status === 429) {
        timestamp = Math.max(0, timestamp - 10);
        await sleep(jitter(8000));
        continue;
      }
      if (res.status === 200) {
        if (res.data.completed_at) { currentProgress = target; break; }
        currentProgress = timestamp;
        timestamp += 10;
        const p = `   ${createProgressBar(currentProgress, target)} | ${formatTime(currentProgress)} / ${formatTime(target)}`;
        process.stdout.write(`\r${p}`);
        if (logCallback) logCallback(p);
        if (currentProgress >= target) break;
      }
      await sleep(jitter(2500, 2500));
    }
  } else if (taskType.startsWith('PLAY_')) {
    const streamKey = `call:${questId}:1`;
    const MAX_STUCK = 8;
    let stuckCounter = 0;
    while (currentProgress < target) {
      const res = await makeRequest(`/quests/${questId}/heartbeat`, 'POST', { stream_key: streamKey, terminal: false });
      if (res.status === 429) { await sleep(jitter(8000)); continue; }
      if (res.status === 200) {
        const data = res.data;
        if (data.completed_at || data.user_status?.completed_at) { currentProgress = target; break; }
        const newProgress = data.progress?.[taskType]?.value ?? currentProgress;
        if (newProgress > currentProgress) {
          currentProgress = newProgress;
          stuckCounter = 0;
          const p = `   ${createProgressBar(currentProgress, target)} | ${formatTime(currentProgress)} / ${formatTime(target)}`;
          process.stdout.write(`\r${p}`);
          if (logCallback) logCallback(p);
          if (currentProgress >= target) {
            await makeRequest(`/quests/${questId}/heartbeat`, 'POST', { stream_key: streamKey, terminal: true });
            currentProgress = target;
            break;
          }
        } else {
          stuckCounter++;
          if (stuckCounter >= MAX_STUCK) {
            await makeRequest(`/quests/${questId}/heartbeat`, 'POST', { stream_key: streamKey, terminal: true });
            currentProgress = target;
            break;
          }
        }
      }
      await sleep(jitter(24000, 3000));
    }
  }

  const done = `   ✅ Missão concluída! Recompensa: ${quest.rewardText}\n`;
  process.stdout.write(`\r   ${createProgressBar(target, target)} | ${formatTime(target)} / ${formatTime(target)}\n`);
  log(done);
  return true;
}

async function runAutoQuest(userToken, logCallback, userId) {
  activeToken = userToken;
  if (!activeToken || activeToken.trim() === '') throw new Error('Token não fornecido.');
  const log = (msg) => { console.log(msg); if (logCallback) logCallback(msg); };

  log('🔍 Validando token...');
  const user = await getUserInfo();
  if (!user) throw new Error('Token inválido ou expirado.');
  log(`👤 Conta: ${user.global_name || user.username} (@${user.username})`);
  log(`🆔 ID: ${user.id}`);

  const orbs = await getOrbsBalance();
  if (orbs !== null) log(`💰 Orbs: ${orbs.toLocaleString('pt-BR')}`);

  log('\n📋 Buscando missões disponíveis...\n');
  const quests = await fetchAvailableQuests();
  if (!quests.length) { log('🚫 Nenhuma missão disponível.'); return; }

  log(`🎯 ${quests.length} missão(ões) encontrada(s):\n`);
  for (let i = 0; i < quests.length; i++) {
    const q = quests[i];
    log(`   ${i+1}. ${q.questName}`);
    log(`      ${TASK_TYPES[q.taskType]} | ${getTaskDuration(q.target)} | 🎁 ${q.rewardText}`);
  }

  log('\n▶️ Iniciando execução automática...\n');
  let completed = 0;
  for (const quest of quests) {
    const ok = await runQuest(quest, logCallback, userId);
    if (ok) completed++;
    if (quest !== quests[quests.length-1]) {
      log('⏳ Aguardando antes da próxima missão...\n');
      await sleep(jitter(10000, 3000));
    }
  }

  log(`\n🏁 Tudo pronto! ${completed}/${quests.length} missões concluídas.`);
  const finalOrbs = await getOrbsBalance();
  if (finalOrbs !== null) log(`💰 Saldo final de Orbs: ${finalOrbs.toLocaleString('pt-BR')}`);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent]
});

client.once('ready', async () => {
  console.log(`🤖 Bot logado como ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(config.botToken);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: [
        { name: 'quest', description: 'Painel de controle de missões' },
        { name: 'config', description: 'Configurar canal de logs', options: [
          { name: 'canal', type: 7, description: 'Canal para enviar logs', required: true, channel_types: [0] }
        ]}
      ]
    });
    console.log('✅ Comandos registrados');
  } catch (error) {
    console.error('Erro ao registrar comandos:', error);
  }
});

async function sendLog(embed) {
  if (!config.logChannelId || config.logChannelId === '') return;
  try {
    const channel = await client.channels.fetch(config.logChannelId);
    if (channel) await channel.send({ embeds: [embed] });
  } catch {}
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isCommand() && interaction.commandName === 'quest') {
    const container = {
      type: 17,
      accent_color: 0x5865F2,
      components: [
        {
          type: 10,
          content: '# Discord Quest Control Panel\n\nClique nos botões abaixo para gerenciar suas missões.\n\n1. Clique em **Login** para inserir seu token.\n2. Use **Ver Missões** para listar o que está disponível.\n3. Clique em **Iniciar Farm** para automatizar tudo.'
        },
        {
          type: 1,
          components: [
            {
              type: 2,
              custom_id: 'quest_login',
              label: 'Login',
              style: 1
            },
            {
              type: 2,
              custom_id: 'quest_ver',
              label: 'Ver Missões',
              style: 3
            },
            {
              type: 2,
              custom_id: 'quest_farm',
              label: 'Iniciar Farm',
              style: 4
            }
          ]
        },
        {
          type: 10,
          content: '---\n\n**NOVO BOT DE FAZER MISSÕES DE ORBS DO DISCORD**'
        }
      ]
    };

    await interaction.reply({ 
      flags: 32768,
      components: [container]
    });
  }

  if (interaction.isCommand() && interaction.commandName === 'config') {
    if (interaction.user.id !== config.ownerId) {
      return interaction.reply({ content: '❌ Apenas o owner pode usar este comando.', ephemeral: true });
    }
    const channel = interaction.options.getChannel('canal');
    if (channel.type !== ChannelType.GuildText) {
      return interaction.reply({ content: '❌ O canal deve ser de texto.', ephemeral: true });
    }
    config.logChannelId = channel.id;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    await interaction.reply({ content: `✅ Canal de logs configurado: ${channel}`, ephemeral: true });
  }

  if (interaction.isButton() && interaction.customId === 'quest_login') {
    const modal = new ModalBuilder()
      .setCustomId('quest_login_modal')
      .setTitle('Login - Insira seu Token');

    const input = new TextInputBuilder()
      .setCustomId('token_input')
      .setLabel('Token de usuário do Discord')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Cole seu token aqui...')
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
  }

  if (interaction.isButton() && interaction.customId === 'quest_ver') {
    await interaction.deferReply({ ephemeral: true });
    const token = tokenManager.get(interaction.user.id);
    if (!token) {
      return interaction.editReply({ content: '❌ Faça login primeiro!', ephemeral: true });
    }
    setActiveToken(token);
    try {
      const quests = await fetchAvailableQuests();
      if (!quests.length) {
        return interaction.editReply({ content: '📭 Nenhuma missão disponível.', ephemeral: true });
      }
      const container = {
        type: 17,
        accent_color: 0x00FF00,
        components: [
          {
            type: 10,
            content: '# 📋 Missões disponíveis\n\n' + quests.map((q,i) =>
              `**${i+1}. ${q.questName}**\n🎁 ${q.rewardText} | ${q.taskType} | ${Math.floor(q.target/60)}min`
            ).join('\n\n')
          }
        ]
      };
      await interaction.editReply({ flags: 32768, components: [container] });
    } catch (err) {
      await interaction.editReply({ content: `❌ Erro: ${err.message}`, ephemeral: true });
    }
  }

  if (interaction.isButton() && interaction.customId === 'quest_farm') {
    await interaction.deferReply({ ephemeral: true });
    const token = tokenManager.get(interaction.user.id);
    if (!token) {
      return interaction.editReply({ content: '❌ Faça login primeiro!', ephemeral: true });
    }
    await interaction.editReply({ content: '🔄 Iniciando farm automático... Acompanhe os logs no console.', ephemeral: true });

    const user = interaction.user;
    const startEmbed = new EmbedBuilder()
      .setTitle('🚀 Farm Iniciado')
      .setColor(0x00FF00)
      .setDescription(`**Usuário:** ${user.tag} (${user.id})\n**Status:** Iniciando farm...`)
      .setTimestamp();
    await sendLog(startEmbed);

    runAutoQuest(token, async (logMsg) => {
      console.log(`[FARM] ${logMsg}`);
      if (logMsg.includes('✅ Missão concluída') || logMsg.includes('🚀 Iniciando') || logMsg.includes('🏁 Tudo pronto')) {
        const logEmbed = new EmbedBuilder()
          .setTitle('📊 Log do Farm')
          .setColor(0x5865F2)
          .setDescription(`**Usuário:** ${user.tag}\n**Log:** ${logMsg}`)
          .setTimestamp();
        await sendLog(logEmbed);
      }
    }, interaction.user.id).catch(async (err) => {
      console.error('Erro no farm:', err);
      interaction.followUp({ content: `❌ Erro: ${err.message}`, ephemeral: true });
      const errEmbed = new EmbedBuilder()
        .setTitle('❌ Erro no Farm')
        .setColor(0xFF0000)
        .setDescription(`**Usuário:** ${user.tag}\n**Erro:** ${err.message}`)
        .setTimestamp();
      await sendLog(errEmbed);
    });
  }

  if (interaction.isModalSubmit() && interaction.customId === 'quest_login_modal') {
    const token = interaction.fields.getTextInputValue('token_input');
    tokenManager.set(interaction.user.id, token);
    await interaction.reply({ content: '✅ Token salvo com sucesso! Agora use **Ver Missões** ou **Iniciar Farm**.', ephemeral: true });
  }
});

client.login(config.botToken);
