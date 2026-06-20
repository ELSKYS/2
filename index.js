require('dotenv').config();
const { 
    Client, 
    GatewayIntentBits, 
    Partials, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    ChannelType, 
    PermissionFlagsBits, 
    REST, 
    Routes,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder
} = require('discord.js');
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
    { 
        id: 0, 
        name: "Universal", 
        price: "$600", 
        desc: "Supports EAC / VGK / BE etc. Lifetime + 1 Month Warranty",
        imageUrl: "https://picsum.photos/id/1015/800/600",
        features: [
            "Universal support for major anti-cheats (EAC, VGK, BE, etc.)",
            "All Motherboards: AMD & Intel",
            "Duration: Lifetime",
            "1 Month Warranty included",
            "High stability, survived multiple ban waves"
        ]
    },
    { 
        id: 1, 
        name: "Universal PRO", 
        price: "$800", 
        desc: "All games supported. Lifetime + 1 Month Warranty",
        imageUrl: "https://picsum.photos/id/160/800/600",
        features: [
            "Full anti-cheat coverage for all games",
            "All Motherboards: AMD & Intel",
            "Duration: Lifetime",
            "Maximum stability and compatibility",
            "1 Month Warranty included"
        ]
    },
    { 
        id: 2, 
        name: "Specific Firmware (BE, JAVELIN, GC, VAC etc.)", 
        price: "$150 (6 Months)", 
        desc: "Supports BE, Javelin, GC, VAC etc.",
        imageUrl: "https://picsum.photos/id/201/800/600",   // Replace with your real product image URL
        features: [
            "All Motherboards AMD & Intel",
            "Duration: Lifetime / Duração: Vitalícia",
            "Warranty plans / Planos de Garantia available",
            "6 Months & 1 Year options",
            "Development within 1-5 Business Days"
        ]
    },
    { 
        id: 3, 
        name: "Specific Firmware (1 Year)", 
        price: "$250 (1 Year)", 
        desc: "Supports BE, Javelin, GC, VAC etc.",
        imageUrl: "https://picsum.photos/id/201/800/600",
        features: [
            "All Motherboards AMD & Intel",
            "Duration: Lifetime",
            "Extended 1 Year plan",
            "Warranty plans available",
            "Fast development and updates"
        ]
    },
    { 
        id: 4, 
        name: "EAC Basic", 
        price: "$169", 
        desc: "Rust / Apex / FN (No Rank/Cup). Lifetime + 1 Month Warranty",
        imageUrl: "https://picsum.photos/id/251/800/600",
        features: [
            "Reliable EAC bypass",
            "Supported: Rust, Apex Legends, Fortnite (No Rank/Cup)",
            "Lifetime access",
            "1 Month Warranty"
        ]
    },
    { 
        id: 5, 
        name: "EAC Rank", 
        price: "$369", 
        desc: "FN Ranked & Cup support. Lifetime + 1 Month Warranty",
        imageUrl: "https://picsum.photos/id/180/800/600",
        features: [
            "Full ranked and tournament support for Fortnite",
            "EAC bypass with high stability",
            "Lifetime + 1 Month Warranty",
            "Optimized for competitive play"
        ]
    },
    { 
        id: 6, 
        name: "Faceit (No Warranty)", 
        price: "$200", 
        desc: "Faceit without warranty",
        imageUrl: "https://picsum.photos/id/29/800/600",
        features: [
            "Faceit anti-cheat support",
            "No warranty option (lower price)",
            "Fast setup"
        ]
    },
    { 
        id: 7, 
        name: "Faceit (1 Month Warranty)", 
        price: "$500", 
        desc: "Faceit with 1 month warranty",
        imageUrl: "https://picsum.photos/id/29/800/600",
        features: [
            "Premium Faceit solution",
            "1 Month Warranty",
            "High performance and stability",
            "Recommended for serious users"
        ]
    },
    { 
        id: 8, 
        name: "VGK", 
        price: "$300", 
        desc: "VGK. Lifetime + 1 Month Warranty",
        imageUrl: "https://picsum.photos/id/133/800/600",
        features: [
            "Vanguard bypass",
            "Lifetime access",
            "1 Month Warranty",
            "Stable across updates"
        ]
    },
    { 
        id: 9, 
        name: "Hidden (6 Months)", 
        price: "$150", 
        desc: "FiveM & Free Fire hidden version",
        imageUrl: "https://picsum.photos/id/160/800/600",
        features: [
            "Hidden version for FiveM and Free Fire",
            "6 Months access",
            "Low detection risk"
        ]
    },
    { 
        id: 10, 
        name: "Hidden (12 Months)", 
        price: "$250", 
        desc: "FiveM & Free Fire hidden version",
        imageUrl: "https://picsum.photos/id/160/800/600",
        features: [
            "Hidden version for FiveM and Free Fire",
            "12 Months access",
            "Best value for long term users"
        ]
    },
    { 
        id: 11, 
        name: "RDMA Day Card", 
        price: "$10", 
        desc: "RDMA Day Card (Supports VGK/EAC/BE etc.)",
        imageUrl: "https://picsum.photos/id/96/800/600",
        features: [
            "Flexible RDMA access",
            "1 Day card",
            "Supports major anti-cheats",
            "Great for testing"
        ]
    },
    { 
        id: 12, 
        name: "RDMA Week Card", 
        price: "$60", 
        desc: "RDMA Week Card (Supports VGK/EAC/BE etc.)",
        imageUrl: "https://picsum.photos/id/96/800/600",
        features: [
            "1 Week RDMA access",
            "Full support for VGK/EAC/BE",
            "Invite friends for free days"
        ]
    },
    { 
        id: 13, 
        name: "RDMA Month Card", 
        price: "$200", 
        desc: "RDMA Month Card (Supports VGK/EAC/BE etc.)",
        imageUrl: "https://picsum.photos/id/96/800/600",
        features: [
            "1 Month full RDMA access",
            "Best for regular users",
            "New user rewards available"
        ]
    }
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

// ==================== 用户在工单发第一条消息时自动发送产品价格 + 地址 ====================
client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const channelName = message.channel.name;

    // 判断是否是工单频道
    const isTicketChannel = 
        channelName.includes('Support / Questions') || 
        channelName.includes('Purchase');

    if (!isTicketChannel) return;

    try {
        // 真实获取频道里的消息（更准确）
        const fetchedMessages = await message.channel.messages.fetch({ limit: 10 });
        const userMessages = fetchedMessages.filter(m => !m.author.bot);

        // 只在用户发的第一条消息时触发
        if (userMessages.size === 1) {
            let productList = '';
            products.forEach(p => {
                productList += `**${p.name}** — ${p.price}\n${p.desc}\n\n`;
            });

            const priceEmbed = new EmbedBuilder()
                .setTitle('RED DMA Product Price List')
                .setDescription(productList)
                .setColor('#ef4444');

            const paymentEmbed = new EmbedBuilder()
                .setTitle('💰 Payment Addresses')
                .setDescription(paymentInfo)
                .setColor('#ef4444')
                .setFooter({ text: 'After payment, please upload your transaction screenshot.' });

            await message.channel.send({ embeds: [priceEmbed, paymentEmbed] });
            console.log(`Sent product info in ticket: ${channelName}`);
        }
    } catch (error) {
        console.error('Failed to send product info:', error);
    }
});
// ==================== 新成员欢迎私信 ====================
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
    } catch (error) {
        console.log(`Could not send DM to ${member.user.tag}`);
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
            name: 'product',
            description: 'View detailed product introduction with images (select and open ticket)',
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

    // NEW: /product command - detailed product intro with image + open ticket
    if (interaction.isChatInputCommand() && interaction.commandName === 'product') {
        const select = new StringSelectMenuBuilder()
            .setCustomId('select_product_intro')
            .setPlaceholder('Select a product to view detailed introduction and images')
            .addOptions(
                products.map(p => 
                    new StringSelectMenuOptionBuilder()
                        .setLabel(`${p.name} — ${p.price}`)
                        .setValue(p.id.toString())
                        .setDescription(p.desc.length > 90 ? p.desc.substring(0, 87) + '...' : p.desc)
                )
            );

        const row = new ActionRowBuilder().addComponents(select);

        await interaction.reply({
            content: '📋 **Select a product** to see high-quality images, detailed features and open a ticket:',
            components: [row],
            ephemeral: true
        });
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

    // NEW: Handle product intro select menu
    if (interaction.isStringSelectMenu() && interaction.customId === 'select_product_intro') {
        const productId = parseInt(interaction.values[0]);
        const product = products.find(p => p.id === productId);
        if (!product) return;

        const featureList = (product.features || [product.desc])
            .map(f => `• ${f}`)
            .join('\n');

        const embed = new EmbedBuilder()
            .setTitle(product.name)
            .setDescription(`${featureList}\n\n**Price:** ${product.price}`)
            .setImage(product.imageUrl || 'https://picsum.photos/800/600')
            .setColor(0xef4444)
            .setFooter({ text: 'Click the button below to open a purchase ticket in this chat' });

        const ticketBtn = new ButtonBuilder()
            .setCustomId(`create_ticket_${product.id}`)
            .setLabel('Open Ticket / Ver Opções')
            .setStyle(ButtonStyle.Danger);

        const row = new ActionRowBuilder().addComponents(ticketBtn);

        // Send the rich product card publicly in the current channel
        await interaction.channel.send({
            embeds: [embed],
            components: [row]
        });

        await interaction.reply({
            content: '✅ Product introduction sent above!',
            ephemeral: true
        });
    }

    // NEW: Handle "create_ticket_xxx" button from product intro cards
    if (interaction.isButton() && interaction.customId.startsWith('create_ticket_')) {
        const productId = parseInt(interaction.customId.split('_')[2]);
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
