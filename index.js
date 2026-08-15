require('dotenv').config();
const { 
    Client, 
    GatewayIntentBits, 
    ActionRowBuilder, 
    StringSelectMenuBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    ChannelType, 
    PermissionFlagsBits, 
    EmbedBuilder 
} = require('discord.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.once('ready', () => {
    console.log(`🤖 Bot online como ${client.user.tag}`);
});

// Comando para enviar o painel de tickets (Ex: !setup-ticket)
client.on('messageCreate', async (message) => {
    if (message.content === '!setup-ticket' && message.member.permissions.has(PermissionFlagsBits.Administrator)) {
        await message.delete().catch(() => {});

        const embed = new EmbedBuilder()
            .setTitle('🎫 Central de Atendimento')
            .setDescription('Precisa de ajuda ou quer fazer uma denúncia? Selecione a categoria abaixo para abrir um ticket de suporte.')
            .setColor('#5865F2')
            .setFooter({ text: 'Horário de atendimento: 24/7' });

        const menu = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('select_ticket')
                .setPlaceholder('Selecione o motivo do contato...')
                .addOptions([
                    {
                        label: 'Suporte Geral',
                        description: 'Dúvidas sobre o servidor ou regras.',
                        value: 'suporte',
                        emoji: '❓'
                    },
                    {
                        label: 'Denúncia',
                        description: 'Reportar violação das regras.',
                        value: 'denuncia',
                        emoji: '🚨'
                    },
                    {
                        label: 'Financeiro / VIP',
                        description: 'Questões sobre compras ou doações.',
                        value: 'financeiro',
                        emoji: '💳'
                    }
                ])
        );

        await message.channel.send({ embeds: [embed], components: [menu] });
    }
});

// Gerenciador de Interações (Menus e Botões)
client.on('interactionCreate', async (interaction) => {
    // 1. Abertura do Ticket via Menu
    if (interaction.isStringSelectMenu() && interaction.customId === 'select_ticket') {
        const tipo = interaction.values[0];
        const username = interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '');
        const channelName = `ticket-${tipo}-${username}`;

        // Verifica se já existe um ticket aberto para este usuário
        const canalExistente = interaction.guild.channels.cache.find(c => c.name === channelName);
        if (canalExistente) {
            return interaction.reply({ 
                content: `❌ Você já possui um ticket aberto em ${canalExistente}!`, 
                ephemeral: true 
            });
        }

        await interaction.deferReply({ ephemeral: true });

        // Cria o canal do ticket
        const ticketChannel = await interaction.guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: process.env.CATEGORY_ID,
            permissionOverwrites: [
                {
                    id: interaction.guild.id, // Esconde do cargo @everyone
                    deny: [PermissionFlagsBits.ViewChannel]
                },
                {
                    id: interaction.user.id, // Libera acesso ao autor
                    allow: [
                        PermissionFlagsBits.ViewChannel, 
                        PermissionFlagsBits.SendMessages, 
                        PermissionFlagsBits.AttachFiles
                    ]
                }
            ]
        });

        // Embed enviada dentro do novo ticket
        const ticketEmbed = new EmbedBuilder()
            .setTitle(`Ticket de ${interaction.user.username}`)
            .setDescription(`**Categoria:** ${tipo.toUpperCase()}\n\nAguarde a equipe de suporte. Descreva seu problema em detalhes para agilizar o atendimento.`)
            .setColor('#22C55E')
            .setTimestamp();

        const closeButton = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('close_ticket')
                .setLabel('Fechar Ticket')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🔒')
        );

        await ticketChannel.send({ 
            content: `<@${interaction.user.id}>`, 
            embeds: [ticketEmbed], 
            components: [closeButton] 
        });

        await interaction.editReply({ 
            content: `✅ Ticket criado com sucesso em ${ticketChannel}!` 
        });
    }

    // 2. Fechamento do Ticket via Botão
    if (interaction.isButton() && interaction.customId === 'close_ticket') {
        await interaction.reply('🔒 Este ticket será excluído em **5 segundos**...');
        setTimeout(() => {
            interaction.channel.delete().catch(() => {});
        }, 5000);
    }
});

client.login(process.env.DISCORD_TOKEN);
