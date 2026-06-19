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
    { id: 0, name: "Universal", price: "$600", desc: "支持 EAC / VGK / BE 等，终身 + 1个月保修" },
    { id: 1, name: "Universal PRO", price: "$800", desc: "全游戏支持，终身 + 1个月保修" },
    { id: 2, name: "Specific Anti-Cheat (6个月保)", price: "$150", desc: "支持 BE, Javelin, GC, VAC 等" },
    { id: 3, name: "Specific Anti-Cheat (1年保)", price: "$250", desc: "支持 BE, Javelin, GC, VAC 等" },
    { id: 4, name: "EAC Basic", price: "$169", desc: "Rust / Apex / FN（无排位杯赛），终身 + 1个月保修" },
    { id: 5, name: "EAC Rank", price: "$369", desc: "FN 排位和杯赛支持，终身 + 1个月保修" },
    { id: 6, name: "Faceit (无保修)", price: "$200", desc: "Faceit 无保修版本" },
    { id: 7, name: "Faceit (1个月保修)", price: "$500", desc: "Faceit 带1个月保修" },
    { id: 8, name: "VGK", price: "$300", desc: "VGK，终身 + 1个月保修" },
    { id: 9, name: "Hidden (6个月保)", price: "$150", desc: "FiveM & Free Fire 隐藏版" },
    { id: 10, name: "Hidden (12个月保)", price: "$250", desc: "FiveM & Free Fire 隐藏版" },
    { id: 11, name: "RDMA Day Card", price: "$10", desc: "RDMA 日卡（支持 VGK/EAC/BE 等）" },
    { id: 12, name: "RDMA Week Card", price: "$60", desc: "RDMA 周卡（支持 VGK/EAC/BE 等）" },
    { id: 13, name: "RDMA Month Card", price: "$200", desc: "RDMA 月卡（支持 VGK/EAC/BE 等）" },
];

// 收款地址
const paymentInfo = `
**LTC（莱特币）**
\`\`\`
ltc1q7u7zsh0qgzl28nwknwg3hs84fz9mrmee7puk076n0alnuxr4qe2smlddnd
\`\`\`

**BTC（比特币）**
\`\`\`
3LHYderrTnSYK34ME6cHneR6cBQUU7PEYE
\`\`\`

**SOL（Solana）**
\`\`\`
7a4Xt6piGZqyeQFPdTo7JgxFyRp98aajwEcLgcjTkAB4
\`\`\`
`;

client.once('clientReady', () => {
    console.log(`✅ 机器人已成功上线：${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand() && interaction.commandName === 'products') {
        const embed = new EmbedBuilder()
            .setTitle('RED DMA 完整产品列表')
            .setDescription('点击下方按钮创建购买工单')
            .setColor('#ef4444');

        // 自动分成多行，每行最多 5 个按钮
        const rows = [];
        for (let i = 0; i < products.length; i += 5) {
            const row = new ActionRowBuilder();
            const chunk = products.slice(i, i + 5);
            chunk.forEach(p => {
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`buy_${p.id}`)
                        .setLabel(`${p.name} - ${p.price}`)
                        .setStyle(ButtonStyle.Success)
                );
            });
            rows.push(row);
        }

        await interaction.reply({ embeds: [embed], components: rows, ephemeral: true });
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

        // 发送订单信息
        const orderEmbed = new EmbedBuilder()
            .setTitle(`订单：${product.name} (${product.price})`)
            .setDescription(`${product.desc}\n\n请按照下方地址付款，付款后上传截图。`)
            .setColor('#ef4444');

        await ticketChannel.send({ content: `<@${interaction.user.id}> 欢迎！您的订单已创建。`, embeds: [orderEmbed] });

        // 发送收款地址
        const paymentEmbed = new EmbedBuilder()
            .setTitle('💰 收款地址（请复制后付款）')
            .setDescription(paymentInfo)
            .setColor('#ef4444')
            .setFooter({ text: '付款后请上传交易截图，我们会尽快处理' });

        await ticketChannel.send({ embeds: [paymentEmbed] });

        await interaction.reply({ content: `工单已创建：${ticketChannel}`, ephemeral: true });
    }
});

client.login(TOKEN).catch(err => console.error('登录失败:', err));
