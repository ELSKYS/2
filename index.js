require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits, REST, Routes } = require('discord.js');
const Database = require('better-sqlite3');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Channel, Partials.GuildMember]
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
    { id: 0, name: "Universal", price: "$600", desc: "Supports EAC / VGK / BE etc. Lifetime + 1 Month Warranty" },
    { id: 1, name: "Universal PRO", price: "$800", desc: "All games supported. Lifetime + 1 Month Warranty" },
    { id: 2, name: "Specific Anti-Cheat (6 Months)", price: "$150", desc: "Supports BE, Javelin, GC, VAC etc." },
    { id: 3, name: "Specific Anti-Cheat (1 Year)", price: "$250", desc: "Supports BE, Javelin, GC, VAC etc." },
    { id: 4, name: "EAC Basic", price: "$169", desc: "Rust / Apex / FN (No Rank/Cup). Lifetime + 1 Month Warranty" },
    { id: 5, name: "EAC Rank", price: "$369", desc: "FN Ranked & Cup support. Lifetime + 1 Month Warranty" },
    { id: 6, name: "Faceit (No Warranty)", price: "$200", desc: "Faceit without warranty" },
    { id: 7, name: "Faceit (1 Month Warranty)", price: "$500", desc: "Faceit with 1 month warranty" },
    { id: 8, name: "VGK", price: "$300", desc: "VGK. Lifetime + 1 Month Warranty" },
    { id: 9, name: "Hidden (6 Months)", price: "$150", desc: "FiveM & Free Fire hidden version" },
    { id: 10, name: "Hidden (12 Months)", price: "$250", desc: "FiveM & Free Fire hidden version" },
    { id: 11, name: "RDMA Day Card", price: "$10", desc: "RDMA Day Card (Supports VGK/EAC/BE etc.)" },
    { id: 12, name: "RDMA Week Card", price: "$60", desc: "RDMA Week Card (Supports VGK/EAC/BE etc.)" },
    { id: 13, name: "RDMA Month Card", price: "$200", desc: "RDMA Month Card (Supports VGK/EAC/BE etc.)" },
];

const paymentInfo = `
**LTC (Litecoin)**
\`\`\`
ltc1q7u7zsh0qgzl28nwknwg3hs84fz9mrmee7puk076n0alnuxr4qe2smlddnd
\`\`\`

**BTC (Bitcoin)**
\`\`\`
3LHYderrTnSYK34ME6cHneR6cBQUU7PEYE
\`\`\`

**SOL (Solana)**
\`\`\`
7a4Xt6piGZqyeQFPdTo7JgxFyRp98aajwEcLgcjTkAB4
\`\`\`
`;

// ==================== 新成员加入自动私信 ====================
client.on('guildMemberAdd', async member => {
    try {
        const welcomeEmbed = new EmbedBuilder()
            .setTitle('Welcome to RED DMA!')
            .setDescription(
                `Thank you for joining **RED DMA • Premium DMA Firmware**.\n\n` +
                `Please take a moment to read and follow the **server rules**.\n\n` +
                `You can also visit our website:\n` +
                `**https://reddma.xyz**\n\n` +
                `If you have any questions, feel free to open a ticket.`
            )
            .setColor('#ef4444')
            .setTimestamp();

        await member.send({ embeds: [welcomeEmbed] });
        console.log(`Sent welcome DM to ${member.user.tag}`);
    } catch (error) {
        console.log(`Could not send DM to ${member.user.tag} (DMs might be closed)`);
    }
});

// ==================== 注册命令 ====================
async function registerCommands() {
    const commands = [
        {
            name: 'buy',
            description: 'View RED DMA products and create a purchase ticket',
        },
        {
            name: 'announce',
            description: 'Send an announcement (Admin only)',
            options: [
                {
                    name: 'message',
                    description: 'The announcement message',
                    type: 3,
                    required: true,
                },
                {
                    name: 'image',
                    description: 'Optional image to attach',
                    type: 11,
                    required: false,
                }
            ]
        }
    ];

    const rest = new REST({ version: '10' }).setToken(TOKEN);

    try {
        console.log('Registering slash commands...');
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('✅ Slash commands registered successfully!');
    } catch (error) {
        console.error('Failed to register commands:', error);
    }
}

client.once('clientReady', async () => {
    console.log(`✅ Bot is online: ${client.user.tag}`);
    await registerCommands();
});

client.on('interactionCreate', async interaction => {
    // /buy 命令
    if (interaction.isChatInputCommand() && interaction.commandName === 'buy') {
        const embed = new EmbedBuilder()
            .setTitle('RED DMA Product List')
            .setDescription('Click the buttons below to create a purchase ticket.')
            .setColor('#ef4444');

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

    // 购买按钮逻辑
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

        const orderEmbed = new EmbedBuilder()
            .setTitle(`Order: ${product.name} (${product.price})`)
            .setDescription(`${product.desc}\n\nPlease pay using the addresses below and upload your payment screenshot.`)
            .setColor('#ef4444');

        await ticketChannel.send({ content: `<@${interaction.user.id}> Welcome! Your order has been created.`, embeds: [orderEmbed] });

        const paymentEmbed = new EmbedBuilder()
            .setTitle('💰 Payment Addresses')
            .setDescription(paymentInfo)
            .setColor('#ef4444')
            .setFooter({ text: 'After payment, please upload the transaction screenshot.' });

        await ticketChannel.send({ embeds: [paymentEmbed] });

        await interaction.reply({ content: `Ticket created: ${ticketChannel}`, ephemeral: true });
    }

    // /announce 命令
    if (interaction.isChatInputCommand() && interaction.commandName === 'announce') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
        }

        const message = interaction.options.getString('message');
        const image = interaction.options.getAttachment('image');

        const announceEmbed = new EmbedBuilder()
            .setDescription(message)
            .setColor('#ef4444')
            .setTimestamp();

        if (image) {
            announceEmbed.setImage(image.url);
        }

        await interaction.channel.send({ embeds: [announceEmbed] });
        await interaction.reply({ content: 'Announcement sent successfully.', ephemeral: true });
    }
});

client.login(TOKEN).catch(err => console.error('Login failed:', err));
