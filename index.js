require('dotenv').config();
const fs = require('fs');
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
const STATUS_CHANNEL_ID = process.env.STATUS_CHANNEL_ID || null;

const DATA_DIR = path.join(__dirname, 'data');

function loadJson(fileName, fallback) {
    const full = path.join(DATA_DIR, fileName);
    try {
        return JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (err) {
        console.error(`Failed to load ${fileName}:`, err.message);
        return fallback;
    }
}

function loadRuntimeData() {
    const products = loadJson('products.json', []);
    const firmwareSupportStatus = loadJson('firmware_status.json', []);
    const settings = loadJson('settings.json', {});
    return { products, firmwareSupportStatus, settings };
}

let { products, firmwareSupportStatus, settings } = loadRuntimeData();

function refreshDataFromDisk() {
    ({ products, firmwareSupportStatus, settings } = loadRuntimeData());
    return { products, firmwareSupportStatus, settings };
}

// Daily @everyone status: off unless explicitly enabled via env or settings.json
function isDailyStatusEnabled() {
    if (process.env.STATUS_ENABLED != null && process.env.STATUS_ENABLED !== '') {
        return !['0', 'false', 'off', 'no'].includes(
            String(process.env.STATUS_ENABLED).trim().toLowerCase()
        );
    }
    if (typeof settings.daily_status_enabled === 'boolean') {
        return settings.daily_status_enabled;
    }
    // Default: disabled
    return false;
}

const STATUS_TIMEZONE =
    process.env.STATUS_TIMEZONE || settings.status_timezone || 'UTC';
const STATUS_POST_TIMES = (
    process.env.STATUS_POST_TIMES ||
    (Array.isArray(settings.status_post_times)
        ? settings.status_post_times.join(',')
        : '12:00')
)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
const STATUS_DM_DISCOUNT =
    process.env.STATUS_DM_DISCOUNT || settings.status_dm_discount || '10%';
const STATUS_MESSAGE_TTL_MINUTES = Math.max(
    0,
    parseInt(
        process.env.STATUS_MESSAGE_TTL_MINUTES ||
            String(settings.status_message_ttl_minutes ?? 10),
        10
    ) || 0
);
const STATUS_MESSAGE_TTL_MS = STATUS_MESSAGE_TTL_MINUTES * 60 * 1000;

const BRAND_NAME = settings.brand_name || 'RED DMA';
const BRAND_TAGLINE = settings.brand_tagline || 'Premium DMA Firmware';
const WEBSITE = settings.website || 'https://reddma.xyz';
const TICKET_WELCOME_TEXT =
    settings.ticket_welcome_text ||
    'Welcome! Your order has been created. A staff member will assist you shortly.';
const ORDER_INSTRUCTIONS =
    settings.order_instructions ||
    'A staff member will contact you with the next steps for this order.';

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

    CREATE TABLE IF NOT EXISTS daily_status_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        post_date TEXT NOT NULL,
        slot TEXT NOT NULL,
        posted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        delete_at INTEGER
    );
`);

try {
    db.exec('ALTER TABLE daily_status_posts ADD COLUMN delete_at INTEGER');
} catch {
    // column already present
}

function getProductImageAttachment() {
    return new AttachmentBuilder(PRODUCT_IMAGE_PATH, { name: PRODUCT_IMAGE_NAME });
}

function sanitizeChannelName(value) {
    return (
        value
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 80) || 'product'
    );
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
        .setFooter({
            text: `${BRAND_NAME} • ${BRAND_TAGLINE} • Click below to open a purchase ticket`,
        });
}

function buildOrderEmbed(product) {
    return new EmbedBuilder()
        .setTitle(`Order: ${product.name} (${product.price})`)
        .setDescription(
            `${product.desc}\n\n${ORDER_INSTRUCTIONS}`
        )
        .setImage(PRODUCT_IMAGE_URL)
        .setColor('#ef4444');
}

function getOpenTicketForUser(userId) {
    return db
        .prepare(
            "SELECT ticket_id FROM tickets WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1"
        )
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

const DISCORD_CATEGORY_CHANNEL_LIMIT = 50;

function countChannelsInCategory(guild, categoryId) {
    if (!categoryId) return 0;
    return guild.channels.cache.filter((ch) => ch.parentId === categoryId).size;
}

function categoryHasRoom(guild, categoryId) {
    return countChannelsInCategory(guild, categoryId) < DISCORD_CATEGORY_CHANNEL_LIMIT;
}

function isTicketChannelName(name) {
    if (!name) return false;
    return (
        name.startsWith('purchase-') ||
        name.startsWith('ticket-') ||
        /support|purchase/i.test(name)
    );
}

/**
 * Free slots under the configured ticket category by deleting channels that are
 * safe to remove: DB-closed tickets, or leftover purchase-* with no open DB row.
 * Never deletes channels that are still marked open in SQLite.
 */
async function freeSpaceInTicketCategory(guild, categoryId, needSlots = 3) {
    try {
        await guild.channels.fetch();
    } catch (err) {
        console.warn('guild.channels.fetch failed:', err?.message || err);
    }

    let used = countChannelsInCategory(guild, categoryId);
    if (used < DISCORD_CATEGORY_CHANNEL_LIMIT) {
        return DISCORD_CATEGORY_CHANNEL_LIMIT - used;
    }

    const children = [...guild.channels.cache.values()]
        .filter(
            (ch) =>
                ch.parentId === categoryId &&
                ch.type === ChannelType.GuildText &&
                isTicketChannelName(ch.name)
        )
        .sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0));

    let freed = 0;
    for (const ch of children) {
        if (used - freed < DISCORD_CATEGORY_CHANNEL_LIMIT - needSlots + 1) break;

        const row = db
            .prepare('SELECT status FROM tickets WHERE ticket_id = ? ORDER BY id DESC LIMIT 1')
            .get(ch.id);

        // Safe to remove: closed in DB, or never tracked / not open (leftover after redeploy)
        const safe = !row || row.status === 'closed';
        if (!safe) continue;

        try {
            await ch.delete('Free space in ticket category (auto-cleanup)');
            freed += 1;
            console.log(`Auto-cleaned ticket channel #${ch.name} (${ch.id})`);
        } catch (err) {
            console.warn(`Failed to delete #${ch.name}:`, err?.message || err);
        }
    }

    used = countChannelsInCategory(guild, categoryId);
    console.log(
        `Ticket category ${categoryId}: after cleanup used=${used}/${DISCORD_CATEGORY_CHANNEL_LIMIT}, freed=${freed}`
    );
    return DISCORD_CATEGORY_CHANNEL_LIMIT - used;
}

/**
 * ALWAYS prefer TICKET_CATEGORY_ID when set (user-configured parent).
 * If full, try auto-cleanup first — do NOT silently open tickets under another category.
 */
async function resolveTicketCategory(guild) {
    if (TICKET_CATEGORY_ID) {
        let category =
            guild.channels.cache.get(TICKET_CATEGORY_ID) ||
            (await guild.channels.fetch(TICKET_CATEGORY_ID).catch(() => null));

        if (category?.type === ChannelType.GuildCategory) {
            if (!categoryHasRoom(guild, category.id)) {
                await freeSpaceInTicketCategory(guild, category.id, 5);
            }
            // Still return this category even if full — create will surface a clear error
            console.log(
                `Using configured ticket category ${category.id} (channels: ${countChannelsInCategory(guild, category.id)}/${DISCORD_CATEGORY_CHANNEL_LIMIT})`
            );
            return category.id;
        }
        console.error(
            `TICKET_CATEGORY_ID=${TICKET_CATEGORY_ID} is missing or not a category`
        );
    }

    // Fallback only when env not set
    const named = guild.channels.cache.find(
        (ch) =>
            ch.type === ChannelType.GuildCategory &&
            /ticket|support|purchase|order|工单/i.test(ch.name) &&
            categoryHasRoom(guild, ch.id)
    );
    return named?.id ?? null;
}

async function sendTicketWelcome(ticketChannel, user, product) {
    const image = getProductImageAttachment();
    const orderEmbed = buildOrderEmbed(product);

    const closeBtn = new ButtonBuilder()
        .setCustomId('close_ticket')
        .setLabel('Close Ticket / 关闭工单')
        .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(closeBtn);

    await ticketChannel.send({
        content: `<@${user.id}> ${TICKET_WELCOME_TEXT}`,
        embeds: [orderEmbed],
        files: [image],
        components: [row],
    });
}

async function createGuildTicketChannel(guild, channelName, user, product, parentId) {
    return guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: parentId ?? undefined,
        topic: `${BRAND_NAME} purchase ticket for ${user.tag} • ${product.name}`,
        permissionOverwrites: buildTicketPermissions(guild, user.id),
        reason: `Purchase ticket for ${user.tag}`,
    });
}

async function createTicketChannel(guild, user, product, sourceChannelId = null) {
    // Close ALL stale open rows for this user whose channels are gone
    const openRows = db
        .prepare(
            "SELECT ticket_id FROM tickets WHERE user_id = ? AND status = 'open' ORDER BY id DESC"
        )
        .all(user.id);

    for (const row of openRows) {
        const ch =
            guild.channels.cache.get(row.ticket_id) ||
            (await guild.channels.fetch(row.ticket_id).catch(() => null));
        if (ch) {
            return { channel: ch, created: false };
        }
        db.prepare("UPDATE tickets SET status = 'closed' WHERE ticket_id = ?").run(
            row.ticket_id
        );
        console.log(`Closed stale ticket row for missing channel ${row.ticket_id}`);
    }

    const shortProduct = sanitizeChannelName(product.name).slice(0, 24);
    const shortUser = sanitizeChannelName(user.username).slice(0, 16);
    const channelName = `purchase-${shortUser}-${shortProduct}`.slice(0, 100);

    // Always use configured category when set — no silent overflow to other parents
    const categoryId = await resolveTicketCategory(guild);
    let ticketChannel;

    try {
        ticketChannel = await createGuildTicketChannel(
            guild,
            channelName,
            user,
            product,
            categoryId
        );
    } catch (err) {
        const msg = String(err?.message || err);
        const isCategoryFull =
            err?.code === 50035 ||
            /CHANNEL_PARENT_MAX_CHANNELS|Maximum number of channels in category/i.test(msg);

        if (isCategoryFull && categoryId) {
            console.warn(
                `Category ${categoryId} still full after resolve; forcing cleanup + retry once`
            );
            await freeSpaceInTicketCategory(guild, categoryId, 5);
            try {
                ticketChannel = await createGuildTicketChannel(
                    guild,
                    channelName,
                    user,
                    product,
                    categoryId
                );
            } catch (err2) {
                const e = new Error(
                    `工单分类已满 50 个频道（${categoryId}）。请删除旧的 purchase- 频道后再试。` +
                        ` Discord: ${err2?.message || err2}`
                );
                e.code = 'TICKET_CATEGORY_FULL';
                throw e;
            }
        } else {
            throw err;
        }
    }

    db.prepare(
        'INSERT INTO tickets (ticket_id, user_id, product_name, product_id, source_channel_id) VALUES (?, ?, ?, ?, ?)'
    ).run(ticketChannel.id, user.id, product.name, product.id, sourceChannelId);

    await sendTicketWelcome(ticketChannel, user, product);

    console.log(
        `Ticket created #${ticketChannel.name} parent=${ticketChannel.parentId} (want=${categoryId})`
    );

    return { channel: ticketChannel, created: true };
}

function buildProductCardRow(product) {
    const ticketBtn = new ButtonBuilder()
        .setCustomId(`create_ticket_${product.id}`)
        .setLabel('Open Ticket / Ver Opções')
        .setStyle(ButtonStyle.Danger);

    return new ActionRowBuilder().addComponents(ticketBtn);
}

// Legacy ticket channels: first user message gets product list (no payment info)
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
        refreshDataFromDisk();
        const fetchedMessages = await message.channel.messages.fetch({ limit: 10 });
        const userMessages = fetchedMessages.filter((m) => !m.author.bot);

        if (userMessages.size !== 1) return;

        let productList = '';
        products.forEach((p) => {
            productList += `**${p.name}** — ${p.price}\n${p.desc}\n\n`;
        });

        const priceEmbed = new EmbedBuilder()
            .setTitle(`${BRAND_NAME} Product Price List`)
            .setDescription(productList || 'No products configured.')
            .setImage(PRODUCT_IMAGE_URL)
            .setColor('#ef4444')
            .setFooter({ text: 'Staff will assist you with the next steps.' });

        const image = getProductImageAttachment();

        await message.channel.send({ embeds: [priceEmbed], files: [image] });
        console.log(`Sent product info in ticket: ${channelName}`);
    } catch (error) {
        console.error('Failed to send product info:', error);
    }
});

function getZonedDateTimeParts(date = new Date()) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: STATUS_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });

    const parts = Object.fromEntries(
        formatter
            .formatToParts(date)
            .filter((p) => p.type !== 'literal')
            .map((p) => [p.type, p.value])
    );

    const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
    const hour = parts.hour.padStart(2, '0');
    const minute = parts.minute.padStart(2, '0');
    const timeKey = `${hour}:${minute}`;
    const display = new Intl.DateTimeFormat('en-US', {
        timeZone: STATUS_TIMEZONE,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        timeZoneName: 'short',
    }).format(date);

    return { dateKey, timeKey, display };
}

function buildFirmwareStatusLines() {
    return firmwareSupportStatus
        .map((item) => `√ **${item.name}** — ${item.note}`)
        .join('\n');
}

function buildDailyStatusEmbed() {
    const { display } = getZonedDateTimeParts();

    return new EmbedBuilder()
        .setTitle('📊 Daily Firmware Status Report')
        .setDescription(
            '**All firmware systems operational today:**\n\n' +
                buildFirmwareStatusLines() +
                '\n\n' +
                '━━━━━━━━━━━━━━━━━━━━\n' +
                `💬 **DM us to purchase** — Private message orders get **${STATUS_DM_DISCOUNT}** discount!\n` +
                'Use `/product` or `/buy` in server, or message us directly for the best price.'
        )
        .addFields({
            name: '🕐 Live Time',
            value: display,
            inline: false,
        })
        .setColor(0x22c55e)
        .setFooter({
            text:
                `${BRAND_NAME} • Auto ${STATUS_POST_TIMES.length}x daily (${STATUS_POST_TIMES.join(', ')} ${STATUS_TIMEZONE})` +
                (STATUS_MESSAGE_TTL_MINUTES > 0
                    ? ` • @everyone removed after ${STATUS_MESSAGE_TTL_MINUTES}m`
                    : ' • Previous day posts cleaned automatically'),
        })
        .setTimestamp();
}

async function deleteStatusMessageByIds(channelId, messageId) {
    try {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel || channel.type !== ChannelType.GuildText) {
            db.prepare('DELETE FROM daily_status_posts WHERE message_id = ?').run(messageId);
            return false;
        }
        try {
            const msg = await channel.messages.fetch(messageId);
            await msg.delete();
            console.log(`Deleted status shout message ${messageId} in #${channel.name}`);
        } catch {
            // already deleted
        }
        db.prepare('DELETE FROM daily_status_posts WHERE message_id = ?').run(messageId);
        return true;
    } catch (error) {
        console.error('Failed to delete status message:', error);
        return false;
    }
}

function scheduleStatusMessageDeletion(channelId, messageId, deleteAtMs) {
    if (!deleteAtMs) return;

    const delay = Math.max(0, deleteAtMs - Date.now());
    setTimeout(() => {
        deleteStatusMessageByIds(channelId, messageId).catch((err) =>
            console.error('Scheduled status delete failed:', err)
        );
    }, delay);

    console.log(
        `Status message ${messageId} scheduled for delete in ${Math.round(delay / 1000)}s`
    );
}

async function processExpiredStatusPosts() {
    const now = Date.now();
    const due = db
        .prepare(
            'SELECT channel_id, message_id, delete_at FROM daily_status_posts WHERE delete_at IS NOT NULL AND delete_at <= ?'
        )
        .all(now);

    for (const row of due) {
        await deleteStatusMessageByIds(row.channel_id, row.message_id);
    }
}

async function deletePreviousDayStatusPosts(channel) {
    const { dateKey: today } = getZonedDateTimeParts();
    const oldPosts = db
        .prepare(
            'SELECT message_id FROM daily_status_posts WHERE channel_id = ? AND post_date < ?'
        )
        .all(channel.id, today);

    for (const row of oldPosts) {
        try {
            const msg = await channel.messages.fetch(row.message_id);
            await msg.delete();
        } catch {
            // already gone
        }
    }

    db.prepare(
        'DELETE FROM daily_status_posts WHERE channel_id = ? AND post_date < ?'
    ).run(channel.id, today);
}

async function postDailyStatus(slot, { force = false } = {}) {
    if (!STATUS_CHANNEL_ID) {
        console.log('STATUS_CHANNEL_ID not configured, skipping daily status post');
        return null;
    }

    refreshDataFromDisk();

    const channel = await client.channels.fetch(STATUS_CHANNEL_ID).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) {
        console.error('STATUS_CHANNEL_ID is invalid or not a text channel');
        return null;
    }

    const { dateKey: today } = getZonedDateTimeParts();

    if (!force) {
        const alreadyPosted = db
            .prepare(
                'SELECT id FROM daily_status_posts WHERE channel_id = ? AND post_date = ? AND slot = ?'
            )
            .get(channel.id, today, slot);
        if (alreadyPosted) return null;
    }

    await deletePreviousDayStatusPosts(channel);

    const embed = buildDailyStatusEmbed();
    const message = await channel.send({
        content: '@everyone **Daily Firmware Status Update**',
        embeds: [embed],
        allowedMentions: { parse: ['everyone'] },
    });

    const deleteAt =
        STATUS_MESSAGE_TTL_MS > 0 ? Date.now() + STATUS_MESSAGE_TTL_MS : null;

    db.prepare(
        'INSERT INTO daily_status_posts (channel_id, message_id, post_date, slot, delete_at) VALUES (?, ?, ?, ?, ?)'
    ).run(channel.id, message.id, today, slot, deleteAt);

    if (deleteAt) {
        scheduleStatusMessageDeletion(channel.id, message.id, deleteAt);
    }

    console.log(
        `Posted daily status (${slot}) to #${channel.name}` +
            (deleteAt ? ` (auto-delete in ${STATUS_MESSAGE_TTL_MINUTES}m)` : '')
    );
    return message;
}

let lastSchedulerTick = '';

function startDailyStatusScheduler() {
    refreshDataFromDisk();
    if (!isDailyStatusEnabled()) {
        console.log(
            'Daily @everyone status scheduler is OFF (settings.daily_status_enabled=false or STATUS_ENABLED=false)'
        );
        return;
    }
    if (!STATUS_CHANNEL_ID) {
        console.log('Daily status scheduler disabled (set STATUS_CHANNEL_ID in .env)');
        return;
    }

    console.log(
        `Daily status scheduler active — timezone: ${STATUS_TIMEZONE}, times: ${STATUS_POST_TIMES.join(', ')}` +
            (STATUS_MESSAGE_TTL_MINUTES > 0
                ? `, auto-delete after ${STATUS_MESSAGE_TTL_MINUTES}m`
                : ', auto-delete disabled')
    );

    processExpiredStatusPosts().catch((err) => console.error(err));
    const pending = db
        .prepare(
            'SELECT channel_id, message_id, delete_at FROM daily_status_posts WHERE delete_at IS NOT NULL AND delete_at > ?'
        )
        .all(Date.now());
    for (const row of pending) {
        scheduleStatusMessageDeletion(row.channel_id, row.message_id, row.delete_at);
    }

    const tick = async () => {
        try {
            await processExpiredStatusPosts();
        } catch (err) {
            console.error('Expired status cleanup failed:', err);
        }

        const { dateKey, timeKey } = getZonedDateTimeParts();
        const tickKey = `${dateKey}|${timeKey}`;
        if (tickKey === lastSchedulerTick) return;
        lastSchedulerTick = tickKey;

        if (STATUS_POST_TIMES.includes(timeKey)) {
            await postDailyStatus(timeKey);
        }
    };

    tick();
    setInterval(tick, 30 * 1000);
}

client.on('guildMemberAdd', async (member) => {
    try {
        const image = getProductImageAttachment();
        const welcomeEmbed = new EmbedBuilder()
            .setTitle(`Welcome to ${BRAND_NAME}!`)
            .setDescription(
                `Thank you for joining **${BRAND_NAME} • ${BRAND_TAGLINE}**.\n\n` +
                    'Please take a moment to read and follow the **server rules**.\n\n' +
                    (WEBSITE ? `You can also visit our website:\n**${WEBSITE}**\n\n` : '') +
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
            description: `View ${BRAND_NAME} products and create a purchase ticket`,
        },
        {
            name: 'product',
            description: 'View detailed product introduction with images (select and open ticket)',
        },
        {
            name: 'status-now',
            description: 'Manually post daily firmware status now (Admin only)',
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
        {
            name: 'reload-data',
            description: 'Reload products/settings from disk (Admin only)',
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
    console.log(`Loaded ${products.length} products from data/products.json`);
    console.log(`TICKET_CATEGORY_ID=${TICKET_CATEGORY_ID || '(not set)'}`);

    // Warm channel cache so category child counts are accurate
    for (const [, guild] of client.guilds.cache) {
        try {
            await guild.channels.fetch();
            if (TICKET_CATEGORY_ID) {
                const n = countChannelsInCategory(guild, TICKET_CATEGORY_ID);
                console.log(
                    `Guild ${guild.name}: ticket category ${TICKET_CATEGORY_ID} has ${n}/${DISCORD_CATEGORY_CHANNEL_LIMIT} channels`
                );
            }
        } catch (err) {
            console.warn(`Failed to fetch channels for ${guild.name}:`, err?.message || err);
        }
    }

    await registerCommands();
    startDailyStatusScheduler();
});

client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isChatInputCommand() && interaction.commandName === 'buy') {
            refreshDataFromDisk();
            const embed = new EmbedBuilder()
                .setTitle(`${BRAND_NAME} Product List`)
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
            await interaction.reply({
                embeds: [embed],
                components: rows,
                files: [image],
                ephemeral: true,
            });
            return;
        }

        if (interaction.isChatInputCommand() && interaction.commandName === 'product') {
            refreshDataFromDisk();
            if (!products.length) {
                await interaction.reply({
                    content: 'No products configured. Use the desktop manager to add products.',
                    ephemeral: true,
                });
                return;
            }

            const select = new StringSelectMenuBuilder()
                .setCustomId('select_product_intro')
                .setPlaceholder('Select a product to view detailed introduction')
                .addOptions(
                    products.map((p) =>
                        new StringSelectMenuOptionBuilder()
                            .setLabel(`${p.name} — ${p.price}`.slice(0, 100))
                            .setValue(p.id.toString())
                            .setDescription(
                                p.desc.length > 90 ? `${p.desc.substring(0, 87)}...` : p.desc
                            )
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
            refreshDataFromDisk();
            const productId = parseInt(interaction.values[0], 10);
            const product = products.find((p) => p.id === productId);
            if (!product) {
                await interaction.reply({ content: 'Product not found.', ephemeral: true });
                return;
            }

            const embed = buildProductEmbed(product);
            const row = buildProductCardRow(product);
            const image = getProductImageAttachment();

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
            refreshDataFromDisk();
            const productId = parseInt(interaction.customId.split('_')[1], 10);
            const product = products.find((p) => p.id === productId);
            if (!product) return;

            await interaction.deferReply({ ephemeral: true });

            try {
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
            } catch (err) {
                console.error('buy_ create ticket failed:', err);
                await interaction.editReply({
                    content: `❌ 开票失败：${err?.message || err}`,
                });
            }
            return;
        }

        if (interaction.isButton() && interaction.customId.startsWith('create_ticket_')) {
            refreshDataFromDisk();
            const productId = parseInt(interaction.customId.split('_')[2], 10);
            const product = products.find((p) => p.id === productId);
            if (!product) return;

            await interaction.deferReply({ ephemeral: true });

            try {
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
            } catch (err) {
                console.error('create_ticket_ failed:', err);
                await interaction.editReply({
                    content: `❌ 开票失败：${err?.message || err}`,
                });
            }
            return;
        }

        if (interaction.isButton() && interaction.customId === 'close_ticket') {
            const channel = interaction.channel;
            const channelId = interaction.channelId;
            const channelName = channel?.name || '';

            // DB is wiped on Railway redeploy — do NOT require an open row to close
            const openTicket = db
                .prepare(
                    "SELECT * FROM tickets WHERE ticket_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1"
                )
                .get(channelId);
            const anyTicketRow = db
                .prepare(
                    'SELECT * FROM tickets WHERE ticket_id = ? ORDER BY id DESC LIMIT 1'
                )
                .get(channelId);

            const looksLikeTicket =
                isTicketChannelName(channelName) ||
                Boolean(openTicket) ||
                Boolean(anyTicketRow) ||
                (channel?.topic || '').includes('purchase ticket');

            if (!looksLikeTicket) {
                await interaction.reply({
                    content: '这里不是工单频道，无法关闭。',
                    ephemeral: true,
                });
                return;
            }

            const member = interaction.member;
            const isOwner =
                (openTicket && openTicket.user_id === interaction.user.id) ||
                (anyTicketRow && anyTicketRow.user_id === interaction.user.id);
            const isStaff =
                member.permissions.has(PermissionFlagsBits.Administrator) ||
                member.permissions.has(PermissionFlagsBits.ManageChannels) ||
                member.permissions.has(PermissionFlagsBits.ManageGuild) ||
                (STAFF_ROLE_ID && member.roles.cache.has(STAFF_ROLE_ID));

            // If no DB owner record (after redeploy), allow anyone who can see the private
            // ticket channel AND is staff; also allow the mention target in topic is hard —
            // allow ManageChannels OR anyone with View in channel who is not denied: prefer staff.
            // Fallback: allow any guild member who can access this private channel (they were invited).
            const canClose =
                isOwner ||
                isStaff ||
                !openTicket; // after redeploy no row: let ticket participants close

            if (!canClose) {
                await interaction.reply({
                    content: 'Only the ticket owner or staff can close this ticket.',
                    ephemeral: true,
                });
                return;
            }

            try {
                db.prepare(
                    "UPDATE tickets SET status = 'closed' WHERE ticket_id = ?"
                ).run(channelId);
            } catch (err) {
                console.warn('DB close update failed (ok if redeploy wiped DB):', err?.message);
            }

            await interaction.reply({
                content: '🔒 Ticket will be closed in 5 seconds...',
                ephemeral: false,
            });

            setTimeout(async () => {
                try {
                    const ch =
                        interaction.guild.channels.cache.get(channelId) ||
                        (await interaction.guild.channels.fetch(channelId).catch(() => null));
                    if (ch) {
                        await ch.delete('Ticket closed');
                        console.log(`Deleted ticket channel ${channelId} (#${channelName})`);
                    }
                } catch (error) {
                    console.error('Failed to delete ticket channel:', error);
                    try {
                        await interaction.followUp({
                            content:
                                '❌ 无法删除频道。请确认机器人有「管理频道」权限，或由管理员手动删除。',
                            ephemeral: true,
                        });
                    } catch {
                        // ignore
                    }
                }
            }, 5000);
            return;
        }

        if (interaction.isChatInputCommand() && interaction.commandName === 'status-now') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                await interaction.reply({
                    content: 'You do not have permission to use this command.',
                    ephemeral: true,
                });
                return;
            }

            refreshDataFromDisk();
            if (!isDailyStatusEnabled()) {
                await interaction.reply({
                    content:
                        '每日状态推送已关闭（daily_status_enabled=false）。如需临时推送，请先在设置里打开后再试。',
                    ephemeral: true,
                });
                return;
            }

            await interaction.deferReply({ ephemeral: true });

            const { timeKey } = getZonedDateTimeParts();
            const message = await postDailyStatus(`manual-${timeKey}`, { force: true });

            if (!message) {
                await interaction.editReply({
                    content:
                        '❌ Failed to post. Check STATUS_CHANNEL_ID in .env and bot permissions.',
                });
                return;
            }

            await interaction.editReply({ content: `✅ Status posted in ${message.channel}` });
            return;
        }

        if (interaction.isChatInputCommand() && interaction.commandName === 'reload-data') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                await interaction.reply({
                    content: 'You do not have permission to use this command.',
                    ephemeral: true,
                });
                return;
            }
            const data = refreshDataFromDisk();
            await interaction.reply({
                content: `✅ Reloaded data: **${data.products.length}** products, **${data.firmwareSupportStatus.length}** firmware rows.`,
                ephemeral: true,
            });
            return;
        }

        if (interaction.isChatInputCommand() && interaction.commandName === 'announce') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                await interaction.reply({
                    content: 'You do not have permission to use this command.',
                    ephemeral: true,
                });
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

if (!TOKEN || !CLIENT_ID) {
    console.error('TOKEN and CLIENT_ID are required. Set them in .env or Railway variables.');
    process.exit(1);
}

client.login(TOKEN).catch((err) => console.error('Login failed:', err));
