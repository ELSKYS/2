require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits } = require('discord.js');
const Database = require('better-sqlite3');

const TOKEN = process.env.TOKEN;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Channel]
});

const db = new Database('sales.db');

db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT,
        user_id TEXT,
        product_name TEXT,
        status TEXT DEFAULT 'open',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

const products = [
    { id: 0, name: "Universal", price: "$600", desc: "支持 EAC / VGK / BE 等，稳定性极高" },
    { id: 1, name: "Universal PRO", price: "$800", desc: "全游戏支持，推荐选择" },
    { id: 2, name: "EAC Basic", price: "$169", desc: "Rust / Apex / Fortnite 基础版" },
    { id: 3, name: "EAC Rank", price: "$369", desc: "支持排位和杯赛" },
];

// 全局错误捕获
process.on('unhandledRejection', error => {
    console.error('未处理的 Promise 拒绝:', error);
});
process.on('uncaughtException', error => {
    console.error('未捕获的异常:', error);
});

client.once('ready', () => {
    console.log(`✅ 机器人已成功上线：${client.user.tag}`);
});

client.on('messageCreate', message => {
    if (message.author.bot) return;
    const content = message.content.toLowerCase();
    if (content.includes('价格')) message.reply('产品价格请使用 `/products` 查看。');
});

client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand() && interaction.commandName === 'products') {
        const embed = new EmbedBuilder()
            .setTitle('RED DMA 商品列表')
            .setDescription('点击下方按钮创建购买工单')
            .setColor('#ef4444');

        const row = new ActionRowBuilder();
        products.forEach(p => {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`buy_${p.id}`)
                    .setLabel(`${p.name} - ${p.price}`)
                    .setStyle(ButtonStyle.Success)
            );
        });
        await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }

    if (interaction.isButton() && interaction.customId.startsWith('buy_')) {
        const productId = parseInt(interaction.customId.split('_')[1]);
        const product = products.find(p => p.id === productId);
        if (!product) return;

        const ticketChannel = await interaction.guild.channels.create({
            name: `ticket-${interaction.user.username}`,
            type: ChannelType.GuildText,
            permissionOverwrites: [
                { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
            ]
        });

        db.prepare('INSERT INTO tickets (ticket_id, user_id, product_name) VALUES (?, ?, ?)').run(
            ticketChannel.id, interaction.user.id, product.name
        );

        const embed = new EmbedBuilder()
            .setTitle(`订单：${product.name} (${product.price})`)
            .setDescription('请按照支付方式付款，并上传截图。')
            .setColor('#ef4444');

        await ticketChannel.send({ content: `<@${interaction.user.id}> 欢迎！`, embeds: [embed] });
        await interaction.reply({ content: `工单已创建：${ticketChannel}`, ephemeral: true });
    }
});

client.login(TOKEN).catch(err => {
    console.error('登录失败:', err);
});
