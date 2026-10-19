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
// Guild text channel: the purchase panel is posted here, and each ticket is a thread under it.
const TICKET_PANEL_CHANNEL_ID = process.env.TICKET_PANEL_CHANNEL_ID || null;
// Deprecated. Older builds created sibling text channels in this category. Ignored.
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID || null;
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID || null;
const STATUS_CHANNEL_ID = process.env.STATUS_CHANNEL_ID || null;
const TICKET_PANEL_MARKER = 'ticket-panel:v1';
const MAX_STAFF_THREAD_ADDS = 100;

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

    CREATE TABLE IF NOT EXISTS bot_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
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

function isTicketChannelName(name) {
    if (!name) return false;
    return (
        name.startsWith('purchase-') ||
        name.startsWith('ticket-') ||
        /support|purchase/i.test(name)
    );
}

function rememberPanelMessage(channelId, messageId) {
    db.prepare(
        'INSERT INTO bot_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(`ticket_panel:${channelId}`, messageId);
}

function recallPanelMessage(channelId) {
    return (
        db.prepare('SELECT value FROM bot_kv WHERE key = ?').get(`ticket_panel:${channelId}`)
            ?.value || null
    );
}

function latestTicketRow(channelId) {
    return db
        .prepare('SELECT * FROM tickets WHERE ticket_id = ? ORDER BY id DESC LIMIT 1')
        .get(channelId);
}

// Threads this bot created under the panel stay tickets even if the name was edited
// or SQLite was wiped on redeploy.
function isBotOwnedTicketThread(channel) {
    return Boolean(
        channel?.isThread?.() &&
            client.user &&
            channel.ownerId === client.user.id &&
            TICKET_PANEL_CHANNEL_ID &&
            channel.parentId === TICKET_PANEL_CHANNEL_ID
    );
}

function isTrackedTicketName(name) {
    if (!name) return false;
    return name.startsWith('purchase-') || name.startsWith('ticket-');
}

function isActiveTicketChannel(channel) {
    if (!channel?.guild) return false;
    if (TICKET_PANEL_CHANNEL_ID && channel.id === TICKET_PANEL_CHANNEL_ID) return false;

    const row = latestTicketRow(channel.id);
    if (row) return row.status === 'open';

    // No DB row (common after a Railway redeploy): only real ticket names, not every
    // channel whose name happens to contain "support" or "purchase".
    if (channel.isThread?.()) {
        if (isBotOwnedTicketThread(channel)) return true;
        if (!isTrackedTicketName(channel.name)) return false;
        if (TICKET_PANEL_CHANNEL_ID && channel.parentId !== TICKET_PANEL_CHANNEL_ID) return false;
        return true;
    }

    return channel.type === ChannelType.GuildText && isTrackedTicketName(channel.name);
}

async function sendTicketWelcome(ticketChannel, user, product) {
    const image = getProductImageAttachment();
    const orderEmbed = buildOrderEmbed(product);
    const isPrivate = ticketChannel.type === ChannelType.PrivateThread;
    const guildId = ticketChannel.guild?.id;
    const staffRoleId = STAFF_ROLE_ID && STAFF_ROLE_ID !== guildId ? STAFF_ROLE_ID : null;
    const staffPing = staffRoleId ? ` <@&${staffRoleId}>` : '';
    const visibilityNote = isPrivate
        ? '在本工单内直接 @ 成员，对方会被加入这个私密帖。'
        : '⚠️ 此工单是公开帖（私密帖未能创建）。能看到本频道的成员都能阅读对话。在帖内 @ 成员仍会把对方加入该帖。';

    const closeBtn = new ButtonBuilder()
        .setCustomId('close_ticket')
        .setLabel('Close Ticket / 关闭工单')
        .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(closeBtn);

    await ticketChannel.send({
        content: `<@${user.id}>${staffPing} ${TICKET_WELCOME_TEXT}\n${visibilityNote}`,
        embeds: [orderEmbed],
        files: [image],
        components: [row],
        allowedMentions: {
            parse: [],
            users: [user.id],
            roles: staffRoleId ? [staffRoleId] : [],
        },
    });

    // Thread tickets never hit the legacy first-message price list. Send it once on open.
    try {
        await sendProductPriceList(ticketChannel);
    } catch (err) {
        console.error('Failed to send product price list in new ticket:', err);
    }
}

function buildProductPriceListEmbed() {
    let productList = '';
    products.forEach((p) => {
        productList += `**${p.name}** — ${p.price}\n${p.desc}\n\n`;
    });

    return new EmbedBuilder()
        .setTitle(`${BRAND_NAME} Product Price List`)
        .setDescription(productList || 'No products configured.')
        .setImage(PRODUCT_IMAGE_URL)
        .setColor('#ef4444')
        .setFooter({ text: 'Staff will assist you with the next steps.' });
}

async function sendProductPriceList(channel) {
    refreshDataFromDisk();
    await channel.send({
        embeds: [buildProductPriceListEmbed()],
        files: [getProductImageAttachment()],
    });
    console.log(`Sent product price list in ${channel.name || channel.id}`);
}

async function fetchTicketChannel(guild, channelId) {
    if (!channelId) return null;
    const cached = guild.channels.cache.get(channelId);
    if (cached) return cached;
    return guild.channels.fetch(channelId).catch(() => null);
}

async function reviveThread(channel) {
    if (!channel?.isThread?.()) return;
    if (!channel.archived && !channel.locked) return;
    try {
        await channel.edit({
            archived: false,
            locked: false,
            reason: 'Reopen active purchase ticket',
        });
    } catch (err) {
        console.warn(`Could not reopen ticket thread ${channel.id}:`, err?.message || err);
    }
}

// A guild text channel cannot parent another guild text channel. Tickets are threads.
async function resolveTicketPanelChannel(guild) {
    if (!TICKET_PANEL_CHANNEL_ID) {
        const error = new Error(
            '未配置 TICKET_PANEL_CHANNEL_ID。请把它设为购票文字频道 ID，工单会在该频道下创建帖子。'
        );
        error.code = 'TICKET_PANEL_UNCONFIGURED';
        throw error;
    }

    const channel =
        guild.channels.cache.get(TICKET_PANEL_CHANNEL_ID) ||
        (await guild.channels.fetch(TICKET_PANEL_CHANNEL_ID).catch(() => null));

    if (!channel || channel.type !== ChannelType.GuildText) {
        const error = new Error(
            `TICKET_PANEL_CHANNEL_ID=${TICKET_PANEL_CHANNEL_ID} 不存在，或不是文字频道。工单帖只能建在文字频道下面。`
        );
        error.code = 'TICKET_PANEL_INVALID';
        throw error;
    }

    if (channel.guildId !== guild.id) {
        const error = new Error('购票面板频道不在当前服务器。');
        error.code = 'TICKET_PANEL_WRONG_GUILD';
        throw error;
    }

    return channel;
}

function isPrivateThreadUnavailable(err) {
    const code = Number(err?.code);
    // Permission, access, or invalid thread type / form body. Other errors (rate limit, 5xx)
    // should not silently open a public ticket.
    if (code === 50013 || code === 50001 || code === 50035 || code === 50024) return true;
    const msg = String(err?.rawError?.message || err?.message || err);
    return /Missing Permissions|Missing Access|CREATE_PRIVATE_THREADS|private thread|Invalid Form Body/i.test(
        msg
    );
}

async function createTicketThread(parent, name, reason) {
    try {
        return await parent.threads.create({
            name,
            type: ChannelType.PrivateThread,
            invitable: true,
            reason,
        });
    } catch (privateError) {
        if (!isPrivateThreadUnavailable(privateError)) {
            throw new Error(`无法创建私密工单帖：${privateError?.message || privateError}`);
        }
        console.warn(
            'Private threads are unavailable; falling back to a public thread:',
            privateError?.code,
            privateError?.message || privateError
        );
        try {
            return await parent.threads.create({
                name,
                type: ChannelType.PublicThread,
                reason,
            });
        } catch (publicError) {
            const error = new Error(
                '无法创建工单帖。请确认机器人在购票文字频道拥有：查看频道、发送消息、嵌入链接、附加文件、创建私密帖、创建公开帖、在帖子中发送消息、管理帖子。' +
                    ` 私密帖：${privateError?.message || privateError}；公开帖：${publicError?.message || publicError}`
            );
            error.code = 'TICKET_THREAD_FAILED';
            throw error;
        }
    }
}

async function addUserToThread(thread, userId) {
    if (!userId || userId === client.user?.id) return;
    if (thread.members.cache.has(userId)) return;
    await thread.members.add(userId);
}

async function addStaffRoleToThread(thread, guild, openerId) {
    if (!STAFF_ROLE_ID || STAFF_ROLE_ID === guild.id) return 0;
    if (thread.type !== ChannelType.PrivateThread) return 0;

    let role = guild.roles.cache.get(STAFF_ROLE_ID) || null;
    if (!role) role = await guild.roles.fetch(STAFF_ROLE_ID).catch(() => null);
    if (!role) {
        console.warn(
            `STAFF_ROLE_ID=${STAFF_ROLE_ID} was not found. Staff were not added to the private ticket.`
        );
        return 0;
    }

    if (guild.memberCount && guild.members.cache.size < guild.memberCount) {
        await guild.members.fetch().catch((err) => {
            console.warn(
                'Could not fetch guild members while adding staff to the ticket:',
                err?.message || err
            );
        });
    }

    const humans = [...role.members.values()].filter(
        (member) => member?.user && !member.user.bot && member.id !== openerId
    );
    if (!humans.length) {
        console.warn(
            `No members cached for staff role ${STAFF_ROLE_ID}. Enable the Server Members intent, or grant that role Manage Threads so staff can see private tickets.`
        );
        return 0;
    }
    if (humans.length > MAX_STAFF_THREAD_ADDS) {
        console.warn(
            `Staff role has ${humans.length} members; adding ${MAX_STAFF_THREAD_ADDS}. Give the role Manage Threads so the rest can open private tickets.`
        );
    }

    let added = 0;
    for (const member of humans.slice(0, MAX_STAFF_THREAD_ADDS)) {
        try {
            await addUserToThread(thread, member.id);
            added += 1;
        } catch (err) {
            console.warn(
                `Could not add staff member ${member.id} to ticket thread:`,
                err?.message || err
            );
        }
    }
    return added;
}

async function createTicketChannel(guild, user, product, sourceChannelId = null) {
    const openRows = db
        .prepare(
            "SELECT ticket_id FROM tickets WHERE user_id = ? AND status = 'open' ORDER BY id DESC"
        )
        .all(user.id);

    for (const row of openRows) {
        const ch = await fetchTicketChannel(guild, row.ticket_id);
        if (ch) {
            await reviveThread(ch);
            if (ch.isThread?.()) {
                const recent = await ch.messages.fetch({ limit: 1 }).catch(() => null);
                if (recent && recent.size === 0) {
                    await sendTicketWelcome(ch, user, product).catch((err) =>
                        console.error('Ticket welcome retry failed:', err)
                    );
                }
            }
            return { channel: ch, created: false };
        }
        db.prepare("UPDATE tickets SET status = 'closed' WHERE ticket_id = ?").run(row.ticket_id);
        console.log(`Closed stale ticket row for missing channel ${row.ticket_id}`);
    }

    const parent = await resolveTicketPanelChannel(guild);
    const shortProduct = sanitizeChannelName(product.name).slice(0, 24);
    const shortUser = sanitizeChannelName(user.username).slice(0, 16);
    const threadName = `purchase-${shortUser}-${shortProduct}`.slice(0, 100);

    const thread = await createTicketThread(parent, threadName, `Purchase ticket for ${user.tag}`);

    try {
        await addUserToThread(thread, user.id);
    } catch (err) {
        await thread.delete('Rolling back ticket thread; opener could not be added').catch((deleteErr) => {
            console.warn(`Could not delete orphan ticket thread ${thread.id}:`, deleteErr?.message || deleteErr);
        });
        throw new Error(
            `无法把你加入工单帖。请确认你能查看购票频道，并且拥有「在帖子中发送消息」。${err?.message || err}`
        );
    }

    const staffAdded = await addStaffRoleToThread(thread, guild, user.id).catch((err) => {
        console.warn('Adding staff to the ticket thread failed:', err?.message || err);
        return 0;
    });

    db.prepare(
        'INSERT INTO tickets (ticket_id, user_id, product_name, product_id, source_channel_id) VALUES (?, ?, ?, ?, ?)'
    ).run(thread.id, user.id, product.name, product.id, sourceChannelId);

    try {
        await sendTicketWelcome(thread, user, product);
    } catch (err) {
        console.error('Ticket welcome failed:', err);
    }

    console.log(
        `Ticket thread created #${thread.name} id=${thread.id} parent=${thread.parentId} type=${thread.type} staffAdded=${staffAdded}`
    );

    return { channel: thread, created: true };
}

function isTicketPanelMessage(message) {
    if (!message?.author || !client.user || message.author.id !== client.user.id) return false;
    return (message.embeds || []).some((embed) =>
        (embed.footer?.text || '').includes(TICKET_PANEL_MARKER)
    );
}

function buildBuyButtonRows() {
    const list = products.slice(0, 25);
    if (products.length > 25) {
        console.warn(
            `Only the first 25 products are shown on ticket buttons (${products.length} configured).`
        );
    }

    const rows = [];
    for (let i = 0; i < list.length; i += 5) {
        const row = new ActionRowBuilder();
        list.slice(i, i + 5).forEach((p) => {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`buy_${p.id}`)
                    .setLabel((`${p.name} - ${p.price}`.trim() || `Product ${p.id}`).slice(0, 80))
                    .setStyle(ButtonStyle.Success)
            );
        });
        rows.push(row);
    }
    return rows;
}

function buildTicketPanelPayload() {
    const rows = buildBuyButtonRows();
    const extra =
        products.length > 25
            ? '\nOnly the first 25 products are shown here. Use /buy for the rest.'
            : '';
    const description = products.length
        ? 'This channel is for opening a purchase ticket.\nClick a product below to start one.' +
          extra
        : 'No products are available right now.';

    const embed = new EmbedBuilder()
        .setTitle(`${BRAND_NAME} Purchase Tickets`)
        .setDescription(description)
        .setImage(PRODUCT_IMAGE_URL)
        .setColor(0xef4444)
        .setFooter({ text: `${BRAND_NAME} • ${BRAND_TAGLINE} • ${TICKET_PANEL_MARKER}` });

    return {
        content: 'Click a button below to open a purchase ticket.',
        embeds: [embed],
        components: rows,
        files: [getProductImageAttachment()],
        allowedMentions: { parse: [] },
    };
}

async function collectPanelScanMessages(channel) {
    const found = new Map();
    const add = (msg) => {
        if (msg) found.set(msg.id, msg);
    };

    const pinned = await channel.messages.fetchPinned().catch((err) => {
        console.warn('Could not fetch pinned messages:', err?.message || err);
        return null;
    });
    pinned?.forEach((msg) => add(msg));

    let before;
    for (let page = 0; page < 3; page += 1) {
        const batch = await channel.messages.fetch({ limit: 100, before }).catch((err) => {
            console.warn('Could not scan channel messages for the ticket panel:', err?.message || err);
            return null;
        });
        if (!batch || batch.size === 0) break;
        batch.forEach((msg) => add(msg));
        before = batch.last()?.id;
        if (batch.size < 100) break;
    }

    return found;
}

async function ensureTicketPanel() {
    try {
        refreshDataFromDisk();
        if (!TICKET_PANEL_CHANNEL_ID) {
            console.error(
                'TICKET_PANEL_CHANNEL_ID is not set. Skipping the ticket panel. Set it to the guild text channel where tickets should open.'
            );
            return null;
        }

        const channel = await client.channels.fetch(TICKET_PANEL_CHANNEL_ID).catch(() => null);
        if (!channel || channel.type !== ChannelType.GuildText) {
            console.error(
                `TICKET_PANEL_CHANNEL_ID=${TICKET_PANEL_CHANNEL_ID} is missing or not a guild text channel (type=${channel?.type}). Ticket panel was not posted.`
            );
            return null;
        }

        const storedId = recallPanelMessage(channel.id);
        const scanned = await collectPanelScanMessages(channel);
        if (storedId && !scanned.has(storedId)) {
            const stored = await channel.messages.fetch(storedId).catch(() => null);
            if (stored) scanned.set(stored.id, stored);
        }

        const panels = [...scanned.values()]
            .filter((msg) => isTicketPanelMessage(msg))
            .sort((a, b) => (b.createdTimestamp || 0) - (a.createdTimestamp || 0));

        let keeper = null;
        if (storedId) keeper = panels.find((msg) => msg.id === storedId) || null;
        if (!keeper) keeper = panels.find((msg) => msg.pinned) || null;
        if (!keeper) keeper = panels[0] || null;

        const payload = buildTicketPanelPayload();
        let panelMessage = keeper;
        if (panelMessage) {
            try {
                panelMessage = await panelMessage.edit({ ...payload, attachments: [] });
            } catch (err) {
                console.warn(
                    'Could not refresh the existing ticket panel; leaving it in place:',
                    err?.message || err
                );
            }
        } else {
            panelMessage = await channel.send(payload);
        }

        for (const extra of panels) {
            if (extra.id === panelMessage.id) continue;
            await extra.delete().catch((err) => {
                console.warn(
                    `Could not delete duplicate ticket panel ${extra.id}:`,
                    err?.message || err
                );
            });
        }

        if (!panelMessage.pinned) {
            await panelMessage.pin('Keep the purchase ticket panel easy to find').catch((err) => {
                console.warn(
                    'Could not pin the ticket panel (need Manage Messages):',
                    err?.message || err
                );
            });
        }

        rememberPanelMessage(channel.id, panelMessage.id);
        console.log(
            `Ticket panel ready in #${channel.name} (${channel.id}) message=${panelMessage.id}`
        );
        return panelMessage;
    } catch (err) {
        console.error('Failed to ensure ticket panel:', err);
        return null;
    }
}

function ticketOpenReply(channel, created) {
    return created
        ? `✅ 已创建工单帖：${channel}`
        : `ℹ️ 你已有一个未关闭的工单：${channel}`;
}

function buildProductCardRow(product) {
    const ticketBtn = new ButtonBuilder()
        .setCustomId(`create_ticket_${product.id}`)
        .setLabel('Open Ticket / Ver Opções')
        .setStyle(ButtonStyle.Danger);

    return new ActionRowBuilder().addComponents(ticketBtn);
}

function explicitMentionIds(content) {
    const ids = [];
    const re = /<@!?(\d{15,20})>/g;
    let match = re.exec(content || '');
    while (match) {
        if (!ids.includes(match[1])) ids.push(match[1]);
        match = re.exec(content || '');
    }
    return ids;
}

// Real @mentions only. Reply pings are not in the message body, so they are not invites.
function explicitlyMentionedUsers(message) {
    const ids = new Set(explicitMentionIds(message.content));
    if (!ids.size) return [];
    return [...message.mentions.users.values()].filter((user) => ids.has(user.id));
}

async function inviteMentionedUsers(message) {
    const channel = message.channel;
    if (!isActiveTicketChannel(channel)) return;

    const mentioned = explicitlyMentionedUsers(message).filter(
        (user) =>
            user &&
            !user.bot &&
            user.id !== message.author.id &&
            user.id !== client.user?.id
    );
    if (!mentioned.length) return;

    if (channel.isThread?.() && (channel.archived || channel.locked)) {
        await reviveThread(channel);
    }

    for (const user of mentioned) {
        try {
            if (channel.isThread?.()) {
                if (channel.members.cache.has(user.id)) continue;
                const existing = await channel.members.fetch(user.id).catch(() => null);
                if (existing) continue;
                await channel.members.add(user.id);
            } else {
                const overwrite = channel.permissionOverwrites?.cache?.get(user.id);
                const already =
                    overwrite?.allow?.has(PermissionFlagsBits.ViewChannel) &&
                    overwrite?.allow?.has(PermissionFlagsBits.SendMessages);
                if (already) continue;
                await channel.permissionOverwrites.edit(
                    user.id,
                    {
                        ViewChannel: true,
                        SendMessages: true,
                        ReadMessageHistory: true,
                        AttachFiles: true,
                    },
                    { reason: 'Mentioned inside an open purchase ticket' }
                );
            }

            await channel.send({
                content: `已将 <@${user.id}> 加入本工单。`,
                allowedMentions: { parse: [], users: [user.id] },
            });
        } catch (err) {
            console.warn(
                `Failed to add ${user.tag || user.id} to ticket ${channel.id}:`,
                err?.message || err
            );
            const reason = String(err?.message || err).slice(0, 180);
            await channel
                .send({
                    content: `无法将 <@${user.id}> 加入本工单：${reason}`,
                    allowedMentions: { parse: [] },
                })
                .catch(() => {});
        }
    }
}

// Legacy text-channel tickets: the first user message gets the price list.
// Thread tickets already receive it from sendTicketWelcome, so this returns early for them.
client.on('messageCreate', async (message) => {
    if (!message.author || message.author.bot || message.author.id === client.user?.id) return;
    if (message.system) return;

    try {
        await inviteMentionedUsers(message);
    } catch (error) {
        console.error('Mention invite failed:', error);
    }

    if (message.channel?.isThread?.()) return;
    if (TICKET_PANEL_CHANNEL_ID && message.channel?.id === TICKET_PANEL_CHANNEL_ID) return;

    const channelName = message.channel?.name || '';
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

        await sendProductPriceList(message.channel);
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
    console.log(`TICKET_PANEL_CHANNEL_ID=${TICKET_PANEL_CHANNEL_ID || '(not set)'}`);
    if (TICKET_CATEGORY_ID) {
        console.log(
            `TICKET_CATEGORY_ID=${TICKET_CATEGORY_ID} is deprecated and ignored. Tickets are threads under TICKET_PANEL_CHANNEL_ID.`
        );
    }

    for (const [, guild] of client.guilds.cache) {
        try {
            await guild.channels.fetch();
        } catch (err) {
            console.warn(`Failed to fetch channels for ${guild.name}:`, err?.message || err);
        }
    }

    await ensureTicketPanel();
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

            const rows = buildBuyButtonRows();

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
            if (!product) {
                await interaction.reply({ content: '找不到该产品。', ephemeral: true });
                return;
            }
            if (!interaction.guild) {
                await interaction.reply({ content: '请在服务器里使用购票按钮。', ephemeral: true });
                return;
            }

            await interaction.deferReply({ ephemeral: true });

            try {
                const { channel: ticketChannel, created } = await createTicketChannel(
                    interaction.guild,
                    interaction.user,
                    product,
                    interaction.channelId
                );

                await interaction.editReply({ content: ticketOpenReply(ticketChannel, created) });
            } catch (err) {
                console.error('buy_ create ticket failed:', err);
                await interaction.editReply({
                    content: `❌ 开票失败：${String(err?.message || err).slice(0, 1500)}`,
                });
            }
            return;
        }

        if (interaction.isButton() && interaction.customId.startsWith('create_ticket_')) {
            refreshDataFromDisk();
            const productId = parseInt(interaction.customId.split('_')[2], 10);
            const product = products.find((p) => p.id === productId);
            if (!product) {
                await interaction.reply({ content: '找不到该产品。', ephemeral: true });
                return;
            }
            if (!interaction.guild) {
                await interaction.reply({ content: '请在服务器里使用购票按钮。', ephemeral: true });
                return;
            }

            await interaction.deferReply({ ephemeral: true });

            try {
                const { channel: ticketChannel, created } = await createTicketChannel(
                    interaction.guild,
                    interaction.user,
                    product,
                    interaction.channelId
                );

                await interaction.editReply({ content: ticketOpenReply(ticketChannel, created) });
            } catch (err) {
                console.error('create_ticket_ failed:', err);
                await interaction.editReply({
                    content: `❌ 开票失败：${String(err?.message || err).slice(0, 1500)}`,
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
                (channel?.topic || '').includes('purchase ticket') ||
                isBotOwnedTicketThread(channel);

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
                    if (!ch) return;
                    try {
                        await ch.delete('Ticket closed');
                        console.log(`Deleted ticket ${channelId} (#${channelName})`);
                    } catch (deleteErr) {
                        if (!ch.isThread?.()) throw deleteErr;
                        try {
                            await ch.edit({
                                archived: true,
                                locked: true,
                                reason: 'Ticket closed',
                            });
                            console.warn(
                                `Could not delete ticket thread ${channelId}; archived it instead:`,
                                deleteErr?.message || deleteErr
                            );
                        } catch (archiveErr) {
                            console.warn(
                                'Archive fallback failed:',
                                archiveErr?.message || archiveErr
                            );
                            throw deleteErr;
                        }
                    }
                } catch (error) {
                    console.error('Failed to delete ticket channel:', error);
                    try {
                        await interaction.followUp({
                            content:
                                '❌ 无法关闭工单。请确认机器人拥有「管理帖子」或「管理频道」权限，或让管理员手动删除/归档。',
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
            const panel = await ensureTicketPanel();
            await interaction.reply({
                content:
                    `✅ Reloaded data: **${data.products.length}** products, **${data.firmwareSupportStatus.length}** firmware rows.` +
                    (panel
                        ? `\n购票面板已更新：${panel.url}`
                        : '\n购票面板未更新，请检查 TICKET_PANEL_CHANNEL_ID 和机器人权限。'),
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
