'use strict';

/**
 * Forward a customer message in an active purchase ticket to a Grok Bot webhook.
 * No Discord client here — index.js owns the one gateway. The webhook POST is
 * fire-and-forget: HTTP 200 means the run was accepted, not that a reply exists.
 */

const { decideReply } = require('./autoReply');

const CONTENT_MAX = 1500;
const RECENT_CONTENT_MAX = 400;
const RECENT_LIMIT = 6;

function isEnabledFlag(value) {
    return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function readGrokConfig(env = process.env) {
    return {
        enabled: isEnabledFlag(env.GROK_BOT_AI_ENABLED),
        webhookUrl: String(env.GROK_BOT_WEBHOOK_URL || '').trim(),
        webhookKey: String(env.GROK_BOT_WEBHOOK_KEY || '').trim(),
    };
}

function webhookProblem(config) {
    if (!config?.webhookUrl) return 'missing GROK_BOT_WEBHOOK_URL';
    let parsed;
    try {
        parsed = new URL(config.webhookUrl);
    } catch {
        return 'GROK_BOT_WEBHOOK_URL is not a valid URL';
    }
    if (parsed.protocol !== 'https:') return 'GROK_BOT_WEBHOOK_URL must be https';
    if (!config.webhookKey) return 'missing GROK_BOT_WEBHOOK_KEY';
    return null;
}

function truncateText(text, max) {
    const value = String(text ?? '');
    if (value.length <= max) return value;
    if (max <= 3) return value.slice(0, max);
    return `${value.slice(0, max - 3)}...`;
}

function ticketMetadata(row) {
    if (!row) return null;
    return {
        ticketId: row.ticket_id ?? row.ticketId ?? null,
        userId: row.user_id ?? row.userId ?? null,
        productName: row.product_name ?? row.productName ?? null,
        productId: row.product_id ?? row.productId ?? null,
        status: row.status ?? null,
        sourceChannelId: row.source_channel_id ?? row.sourceChannelId ?? null,
    };
}

function buildRecentMessages(messages) {
    const cleaned = [];
    for (const message of messages || []) {
        if (!message || message.authorBot || message.bot || message.system) continue;
        const hasAttachments = Boolean(message.hasAttachments);
        const content = truncateText(message.content, RECENT_CONTENT_MAX).trim();
        if (!content && !hasAttachments) continue;
        cleaned.push({
            messageId: String(message.messageId || message.id || ''),
            authorId: String(message.authorId || ''),
            authorUsername: String(message.authorUsername || ''),
            content,
            hasAttachments,
        });
    }
    return cleaned.slice(-RECENT_LIMIT);
}

function buildGrokPayload(input = {}) {
    const ticket = ticketMetadata(input.ticket);
    const productName = input.productName || ticket?.productName || null;
    const productId = input.productId ?? ticket?.productId ?? null;

    return {
        type: 'purchase_ticket_message',
        channelId: String(input.channelId || ''),
        messageId: String(input.messageId || ''),
        content: truncateText(input.content, CONTENT_MAX),
        authorUsername: String(input.authorUsername || ''),
        authorId: String(input.authorId || ''),
        guildId: input.guildId ? String(input.guildId) : null,
        productName: productName ? String(productName) : null,
        productId,
        threadName: input.threadName ? String(input.threadName).slice(0, 100) : null,
        hasAttachments: Boolean(input.hasAttachments),
        ticket,
        recentMessages: buildRecentMessages(input.recentMessages),
    };
}

/**
 * What the ticket handler should do. Staff and bots are never forwarded.
 * When Grok is on, customer messages go to Grok only (no local FAQ reply).
 */
function chooseTicketReplyMode({
    grokEnabled = false,
    autoReplyEnabled = false,
    authorIsStaff = false,
    authorIsBot = false,
    isActiveTicket = false,
} = {}) {
    if (!isActiveTicket || authorIsBot) return 'ignore';
    if (authorIsStaff) return autoReplyEnabled ? 'learn' : 'ignore';
    if (grokEnabled) return 'grok';
    if (autoReplyEnabled) return 'auto-reply';
    return 'ignore';
}

/** Same per-user-per-ticket cooldown as local auto-reply, including the FAQ-category bypass. */
function planCustomerForward(input = {}) {
    const decision = decideReply({
        content: input.content,
        productLabel: input.productLabel || '',
        productHint: input.productHint || '',
        hasAttachments: Boolean(input.hasAttachments),
        memoryRows: input.memoryRows || [],
        last: input.last || null,
        now: input.now || Date.now(),
        cooldownMs: input.cooldownMs ?? 60000,
    });
    return {
        forward: Boolean(decision.shouldReply),
        reason: decision.reason,
        category: decision.category,
    };
}

function safeFailureReason(err, config = {}) {
    if (err?.name === 'AbortError') return 'request timed out';
    let reason = String(err?.message || err || 'request failed');
    const secrets = [config.webhookUrl, config.webhookKey].filter((value) => value && String(value).length >= 4);
    secrets.sort((a, b) => String(b).length - String(a).length);
    for (const secret of secrets) {
        reason = reason.split(String(secret)).join('[redacted]');
    }
    return reason.replace(/\s+/g, ' ').trim().slice(0, 180) || 'request failed';
}

async function postGrokWebhook({ url, key, payload, fetchImpl, timeoutMs = 10000 } = {}) {
    const problem = webhookProblem({ webhookUrl: url, webhookKey: key });
    if (problem) {
        const error = new Error(problem);
        error.code = 'GROK_CONFIG';
        throw error;
    }
    const fetchFn = fetchImpl || globalThis.fetch;
    if (typeof fetchFn !== 'function') {
        throw new Error('fetch is not available');
    }
    const response = await fetchFn(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
    });
    return {
        ok: Boolean(response?.ok),
        status: Number(response?.status) || 0,
    };
}

module.exports = {
    CONTENT_MAX,
    RECENT_CONTENT_MAX,
    RECENT_LIMIT,
    readGrokConfig,
    webhookProblem,
    truncateText,
    ticketMetadata,
    buildRecentMessages,
    buildGrokPayload,
    chooseTicketReplyMode,
    planCustomerForward,
    safeFailureReason,
    postGrokWebhook,
};
