require('dotenv').config();
const path = require('path');
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
    StringSelectMenuOptionBuilder,
    AttachmentBuilder,
    Events,
} = require('discord.js');
const Database = require('better-sqlite3');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID || null;
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID || null;

const PRODUCT_IMAGE_PATH = path.join(__dirname, 'images', 'red-dma-brand.jpg');
const PRODUCT_IMAGE_NAME = 'red-dma-brand.jpg';
const PRODUCT_IMAGE_URL = `attachment://${PRODUCT_IMAGE_NAME}`;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Channel, Partials.GuildMember],
});

const db = new Database('sales.db');

db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT,
        user_id TEXT,
        product_name TEXT,
        product_id INTEGER,
        source_channel_id TEXT,
        status TEXT DEFAULT 'open',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

const products = [
    {
        id: 0,
        name: 'Universal',
        price: '$600',
        desc: 'Supports EAC / VGK / BE etc. Lifetime + 1 Month Warranty',
        features: [
            'Universal support for major anti-cheats (EAC, VGK, BE, etc.)',
            'All Motherboards: AMD & Intel',
            'Duration: Lifetime',
            '1 Month Warranty included',
            'High stability, survived multiple ban waves',
        ],
    },
    {
        id: 1,
        name: 'Universal PRO',
        price: '$800',
        desc: 'All games supported. Lifetime + 1 Month Warranty',
        features: [
            'Full anti-cheat coverage for all games',
            'All Motherboards: AMD & Intel',
            'Duration: Lifetime',
            'Maximum stability and compatibility',
            '1 Month Warranty included',
        ],
    },
    {
        id: 2,
        name: 'Specific Firmware (BE, JAVELIN, GC, VAC etc.)',
        price: '$150 (6 Months)',
        desc: 'Supports BE, Javelin, GC, VAC etc.',
        features: [
            'All Motherboards AMD & Intel',
            'Duration: Lifetime / Duração: Vitalícia',
            'Warranty plans / Planos de Garantia available',
            '6 Months & 1 Year options',
            'Development within 1-5 Business Days',
        ],
    },
    {
        id: 3,
        name: 'Specific Firmware (1 Year)',
        price: '$250 (1 Year)',
        desc: 'Supports BE, Javelin, GC, VAC etc.',
        features: [
            'All Motherboards AMD & Intel',
            'Duration: Lifetime',
            'Extended 1 Year plan',
            'Warranty plans available',
            'Fast development and updates',
        ],
    },
    {
        id: 4,
        name: 'EAC Basic',
        price: '$169',
        desc: 'Rust / Apex / FN (No Rank/Cup). Lifetime + 1 Month Warranty',
        features: [
            'Reliable EAC bypass',
            'Supported: Rust, Apex Legends, Fortnite (No Rank/Cup)',
            'Lifetime access',
            '1 Month Warranty',
        ],
    },
    {
        id: 5,
        name: 'EAC Rank',
        price: '$369',
        desc: 'FN Ranked & Cup support. Lifetime + 1 Month Warranty',
        features: [
            'Full ranked and tournament support for Fortnite',
            'EAC bypass with high stability',
            'Lifetime + 1 Month Warranty',
            'Optimized for competitive play',
        ],
    },
    {
        id: 6,
        name: 'Faceit (No Warranty)',
        price: '$200',
        desc: 'Faceit without warranty',
        features: [
            'Faceit anti-cheat support',
            'No warranty option (lower price)',
            'Fast setup',
        ],
    },
    {
        id: 7,
        name: 'Faceit (1 Month Warranty)',
        price: '$500',
        desc: 'Faceit with 1 month warranty',
        features: [
            'Premium Faceit solution',
            '1 Month Warranty',
            'High performance and stability',
            'Recommended for serious users',
        ],
    },
    {
        id: 8,
        name: 'VGK',
        price: '$300',
        desc: 'VGK. Lifetime + 1 Month Warranty',
        features: [
            'Vanguard bypass',
            'Lifetime access',
            '1 Month Warranty',
            'Stable across updates',
        ],
    },
    {
        id: 9,
        name: 'Hidden (6 Months)',
        price: '$150',
        desc: 'FiveM & Free Fire hidden version',
        features: [
            'Hidden version for FiveM and Free Fire',
            '6 Months access',
            'Low detection risk',
        ],
    },
    {
        id: 10,
        name: 'Hidden (12 Months)',
        price: '$250',
        desc: 'FiveM & Free Fire hidden version',
        features: [
            'Hidden version for FiveM and Free Fire',
            '12 Months access',
            'Best value for long term users',
        ],
    },
    {
        id: 11,
        name: 'RDMA Day Card',
        price: '$10',
        desc: 'RDMA Day Card (Supports VGK/EAC/BE etc.)',
        features: [
            'Flexible RDMA access',
            '1 Day card',
            'Supports major anti-cheats',
            'Great for testing',
        ],
    },
    {
        id: 12,
        name: 'RDMA Week Card',
        price: '$60',
        desc: 'RDMA Week Card (Supports VGK/EAC/BE etc.)',
        features: [
            '1 Week RDMA access',
            'Full support for VGK/EAC/BE',
            'Invite friends for free days',
        ],
    },
    {
        id: 13,
        name: 'RDMA Month Card',
        price: '$200',
        desc: 'RDMA Month Card (Supports VGK/EAC/BE etc.)',
        features: [
            '1 Month full RDMA access',
            'Best for regular users',
            'New user rewards available',
        ],
    },
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

function getProductImageAttachment() {
    return new AttachmentBuilder(PRODUCT_IMAGE_PATH, { name: PRODUCT_IMAGE_NAME });
}

function sanitizeChannelName(value) {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80) || 'product';
}

function buildProductEmbed(product) {
    const featureList = (product.features || [product.desc])
        .map((f) => `• ${f}`)
        .join('\n');

    return new EmbedBuilder()
        .setTitle(product.name)
        .setDescription(`${featureList}\n\n**Price:** ${product.price}`)
        .setImage(PRODUCT_IMAGE_URL)
        .setColor(0xef4444)
        .setFooter({ text: 'RED DMA • Premium DMA Firmware • Click below to open a purchase ticket' });
}

function buildPaymentEmbed() {
    return new EmbedBuilder()
        .setTitle('💰 Payment Addresses')
        .setDescription(paymentInfo)
        .setColor('#ef4444')
        .setFooter({ text: 'After payment, please upload your transaction screenshot.' });
}

function buildOrderEmbed(product) {
    return new EmbedBuilder()
        .setTitle(`Order: ${product.name} (${product.price})`)
        .setDescription(`${product.desc}\n\nPlease pay using the addresses below and upload your payment screenshot.`)
        .setImage(PRODUCT_IMAGE_URL)
        .setColor('#ef4444');
}

function getOpenTicketForUser(userId) {
    return db
        .prepare("SELECT ticket_id FROM tickets WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1")
        .get(userId);
}

function buildTicketPermissions(guild, userId) {
    const overwrites = [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
            id: userId,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.AttachFiles,
            ],
        },
        {
            id: client.user.id,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.ReadMessageHistory,
            ],
        },
    ];

    if (STAFF_ROLE_ID) {
        overwrites.push({
            id: STAFF_ROLE_ID,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageMessages,
            ],
        });
    }

    return overwrites;
}

async function resolveTicketCategory(guild) {
    if (TICKET_CATEGORY_ID) {
        const category = guild.channels.cache.get(TICKET_CATEGORY_ID);
        if (category?.type === ChannelType.GuildCategory) return category.id;
    }

    const namedCategory = guild.channels.cache.find(
        (ch) =>
            ch.type === ChannelType.GuildCategory &&
            /ticket|support|purchase|order|工单/i.test(ch.name)
    );

    return namedCategory?.id ?? null;
}

async function sendTicketWelcome(ticketChannel, user, product) {
    const image = getProductImageAttachment();
    const orderEmbed = buildOrderEmbed(product);
    const paymentEmbed = buildPaymentEmbed();

    const closeBtn = new ButtonBuilder()
        .setCustomId('close_ticket')
        .setLabel('Close Ticket / 关闭工单')
        .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(closeBtn);

    await ticketChannel.send({
        content: `<@${user.id}> Welcome! Your order has been created.`,
        embeds: [orderEmbed, paymentEmbed],
        files: [image],
        components: [row],
    });
}

async function createTicketChannel(guild, user, product, sourceChannelId = null) {
    const existing = getOpenTicketForUser(user.id);
    if (existing) {
        const existingChannel = guild.channels.cache.get(existing.ticket_id);
        if (existingChannel) {
            return { channel: existingChannel, created: false };
        }
    }

    const categoryId = await resolveTicketCategory(guild);
    const shortProduct = sanitizeChannelName(product.name).slice(0, 24);
    const shortUser = sanitizeChannelName(user.username).slice(0, 16);
    const channelName = `purchase-${shortUser}-${shortProduct}`.slice(0, 100);

    const ticketChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: categoryId ?? undefined,
        topic: `RED DMA purchase ticket for ${user.tag} • ${product.name}`,
        permissionOverwrites: buildTicketPermissions(guild, user.id),
    });

    db.prepare(
        'INSERT INTO tickets (ticket_id, user_id, product_name, product_id, source_channel_id) VALUES (?, ?, ?, ?, ?)'
    ).run(ticketChannel.id, user.id, product.name, product.id, sourceChannelId);

    await sendTicketWelcome(ticketChannel, user, product);

    return { channel: ticketChannel, created: true };
}

function buildProductCardRow(product) {
    const ticketBtn = new ButtonBuilder()
        .setCustomId(`create_ticket_${product.id}`)
        .setLabel('Open Ticket / Ver Opções')
        .setStyle(ButtonStyle.Danger);

    return new ActionRowBuilder().addComponents(ticketBtn);
}

// Legacy ticket channels still supported
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const channelName = message.channel.name;
    const isTicketChannel =
        channelName.startsWith('purchase-') ||
        channelName.startsWith('ticket-') ||
        channelName.includes('Support / Questions') ||
        channelName.includes('Purchase');

    if (!isTicketChannel) return;

    try {
        const fetchedMessages = await message.channel.messages.fetch({ limit: 10 });
        const userMessages = fetchedMessages.filter((m) => !m.author.bot);

        if (userMessages.size !== 1) return;

        let productList = '';
        products.forEach((p) => {
            productList += `**${p.name}** — ${p.price}\n${p.desc}\n\n`;
        });

        const priceEmbed = new EmbedBuilder()
            .setTitle('RED DMA Product Price List')
            .setDescription(productList)
            .setImage(PRODUCT_IMAGE_URL)
            .setColor('#ef4444');

        const paymentEmbed = buildPaymentEmbed();
        const image = getProductImageAttachment();

        await message.channel.send({ embeds: [priceEmbed, paymentEmbed], files: [image] });
        console.log(`Sent product info in ticket: ${channelName}`);
    } catch (error) {
        console.error('Failed to send product info:', error);
    }
});

client.on('guildMemberAdd', async (member) => {
    try {
        const image = getProductImageAttachment();
        const welcomeEmbed = new EmbedBuilder()
            .setTitle('Welcome to RED DMA!')
            .setDescription(
                'Thank you for joining **RED DMA • Premium DMA Firmware**.\n\n' +
                    'Please take a moment to read and follow the **server rules**.\n\n' +
                    'You can also visit our website:\n' +
                    '**https://reddma.xyz**\n\n' +
                    'Use `/product` to browse products, or `/buy` to create a purchase ticket.'
            )
            .setImage(PRODUCT_IMAGE_URL)
            .setColor('#ef4444')
            .setTimestamp();

        await member.send({ embeds: [welcomeEmbed], files: [image] });
    } catch (error) {
        console.log(`Could not send DM to ${member.user.tag}`);
    }
});

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
                },
            ],
        },
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

client.once(Events.ClientReady, async () => {
    console.log(`✅ Bot is online: ${client.user.tag}`);
    await registerCommands();
});

client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isChatInputCommand() && interaction.commandName === 'buy') {
            const embed = new EmbedBuilder()
                .setTitle('RED DMA Product List')
                .setDescription('Click the buttons below to create a purchase ticket.')
                .setImage(PRODUCT_IMAGE_URL)
                .setColor('#ef4444');

            const rows = [];
            for (let i = 0; i < products.length; i += 5) {
                const row = new ActionRowBuilder();
                const chunk = products.slice(i, i + 5);
                chunk.forEach((p) => {
                    row.addComponents(
                        new ButtonBuilder()
                            .setCustomId(`buy_${p.id}`)
                            .setLabel(`${p.name} - ${p.price}`.slice(0, 80))
                            .setStyle(ButtonStyle.Success)
                    );
                });
                rows.push(row);
            }

            const image = getProductImageAttachment();
            await interaction.reply({ embeds: [embed], components: rows, files: [image], ephemeral: true });
            return;
        }

        if (interaction.isChatInputCommand() && interaction.commandName === 'product') {
            const select = new StringSelectMenuBuilder()
                .setCustomId('select_product_intro')
                .setPlaceholder('Select a product to view detailed introduction')
                .addOptions(
                    products.map((p) =>
                        new StringSelectMenuOptionBuilder()
                            .setLabel(`${p.name} — ${p.price}`.slice(0, 100))
                            .setValue(p.id.toString())
                            .setDescription(p.desc.length > 90 ? `${p.desc.substring(0, 87)}...` : p.desc)
                    )
                );

            const row = new ActionRowBuilder().addComponents(select);

            await interaction.reply({
                content: '📋 **Select a product** to see introduction and open a ticket:',
                components: [row],
                ephemeral: true,
            });
            return;
        }

        if (interaction.isStringSelectMenu() && interaction.customId === 'select_product_intro') {
            const productId = parseInt(interaction.values[0], 10);
            const product = products.find((p) => p.id === productId);
            if (!product) {
                await interaction.reply({ content: 'Product not found.', ephemeral: true });
                return;
            }

            const embed = buildProductEmbed(product);
            const row = buildProductCardRow(product);
            const image = getProductImageAttachment();

            // Update the ephemeral selector, then post the card as a follow-up
            // so it stays directly under the /product command instead of drifting in chat.
            await interaction.update({
                content: `✅ Selected **${product.name}**. Product card posted below this command.`,
                components: [],
            });

            await interaction.followUp({
                embeds: [embed],
                components: [row],
                files: [image],
                ephemeral: false,
            });
            return;
        }

        if (interaction.isButton() && interaction.customId.startsWith('buy_')) {
            const productId = parseInt(interaction.customId.split('_')[1], 10);
            const product = products.find((p) => p.id === productId);
            if (!product) return;

            await interaction.deferReply({ ephemeral: true });

            const { channel: ticketChannel, created } = await createTicketChannel(
                interaction.guild,
                interaction.user,
                product,
                interaction.channelId
            );

            const message = created
                ? `✅ Ticket created: ${ticketChannel}`
                : `ℹ️ You already have an open ticket: ${ticketChannel}`;

            await interaction.editReply({ content: message });
            return;
        }

        if (interaction.isButton() && interaction.customId.startsWith('create_ticket_')) {
            const productId = parseInt(interaction.customId.split('_')[2], 10);
            const product = products.find((p) => p.id === productId);
            if (!product) return;

            await interaction.deferReply({ ephemeral: true });

            const { channel: ticketChannel, created } = await createTicketChannel(
                interaction.guild,
                interaction.user,
                product,
                interaction.channelId
            );

            const message = created
                ? `✅ Ticket created: ${ticketChannel}`
                : `ℹ️ You already have an open ticket: ${ticketChannel}`;

            await interaction.editReply({ content: message });
            return;
        }

        if (interaction.isButton() && interaction.customId === 'close_ticket') {
            const openTicket = db
                .prepare("SELECT * FROM tickets WHERE ticket_id = ? AND status = 'open'")
                .get(interaction.channelId);

            if (!openTicket) {
                await interaction.reply({ content: 'This ticket is already closed.', ephemeral: true });
                return;
            }

            const isOwner = openTicket.user_id === interaction.user.id;
            const isStaff =
                interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
                (STAFF_ROLE_ID && interaction.member.roles.cache.has(STAFF_ROLE_ID));

            if (!isOwner && !isStaff) {
                await interaction.reply({ content: 'Only the ticket owner or staff can close this ticket.', ephemeral: true });
                return;
            }

            db.prepare("UPDATE tickets SET status = 'closed' WHERE ticket_id = ?").run(interaction.channelId);

            await interaction.reply({ content: '🔒 Ticket will be closed in 5 seconds...', ephemeral: false });

            setTimeout(async () => {
                try {
                    await interaction.channel.delete('Ticket closed');
                } catch (error) {
                    console.error('Failed to delete ticket channel:', error);
                }
            }, 5000);
            return;
        }

        if (interaction.isChatInputCommand() && interaction.commandName === 'announce') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                await interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
                return;
            }

            const message = interaction.options.getString('message');
            const imageAttachment = interaction.options.getAttachment('image');
            const files = [];
            const announceEmbed = new EmbedBuilder()
                .setDescription(message)
                .setColor('#ef4444')
                .setTimestamp();

            if (imageAttachment) {
                announceEmbed.setImage(imageAttachment.url);
            } else {
                announceEmbed.setImage(PRODUCT_IMAGE_URL);
                files.push(getProductImageAttachment());
            }

            await interaction.reply({ content: 'Announcement sent successfully.', ephemeral: true });
            await interaction.channel.send({
                embeds: [announceEmbed],
                files: files.length ? files : undefined,
            });
        }
    } catch (error) {
        console.error('Interaction error:', error);
        const payload = { content: '❌ Something went wrong. Please try again.', ephemeral: true };
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(payload).catch(() => {});
        } else {
            await interaction.reply(payload).catch(() => {});
        }
    }
});

client.login(TOKEN).catch((err) => console.error('Login failed:', err));
