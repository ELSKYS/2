'use strict';

/**
 * Forward a customer message in an active purchase ticket to a Grok Bot webhook.
 * No Discord client here — index.js owns the one gateway. The webhook POST is
 * fire-and-forget: HTTP 200 means the run was accepted, not that a reply exists.
 * A human staff reply records a per-ticket quiet window (default 1 hour) that
 * skips both the webhook and the local FAQ auto-reply.
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
 * staffQuiet is a recent human staff reply in this ticket: suppress both.
 */
function chooseTicketReplyMode({
    grokEnabled = false,
    autoReplyEnabled = false,
    authorIsStaff = false,
    authorIsBot = false,
    isActiveTicket = false,
    staffQuiet = false,
} = {}) {
    if (!isActiveTicket || authorIsBot) return 'ignore';
    if (authorIsStaff) return autoReplyEnabled ? 'learn' : 'ignore';
    if (staffQuiet && (grokEnabled || autoReplyEnabled)) return 'staff-quiet';
    if (grokEnabled) return 'grok';
    if (autoReplyEnabled) return 'auto-reply';
    return 'ignore';
}

const DEFAULT_STAFF_QUIET_SECONDS = 3600;

function readStaffQuietMs(env = process.env) {
    const raw = env.STAFF_QUIET_SECONDS;
    if (raw == null || String(raw).trim() === '') return DEFAULT_STAFF_QUIET_SECONDS * 1000;
    const parsed = Number(String(raw).trim());
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_STAFF_QUIET_SECONDS * 1000;
    return Math.round(parsed) * 1000;
}

/** Content is ignored: filler staff replies (hi/ok/sure) still open the window. */
function shouldNoteStaffReply({
    authorIsStaff = false,
    authorIsBot = false,
    isActiveTicket = false,
} = {}) {
    return Boolean(isActiveTicket && authorIsStaff && !authorIsBot);
}

function staffQuietSkipLine(prefix, ticketId) {
    return `${prefix} skipped ticket=${ticketId} reason=staff-quiet-1h`;
}

function warnStaffQuietStore(err) {
    const reason = String(err?.message || err || 'store failed')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180);
    console.warn(`[ticket] staff quiet store failed: ${reason}`);
}

function createStaffQuietTracker({
    quietMs = DEFAULT_STAFF_QUIET_SECONDS * 1000,
    now = () => Date.now(),
    load,
    save,
    remove,
} = {}) {
    const lastStaffReplyAt = new Map();

    function persist(fn, ...args) {
        if (typeof fn !== 'function') return undefined;
        try {
            return fn(...args);
        } catch (err) {
            warnStaffQuietStore(err);
            return undefined;
        }
    }

    return {
        noteStaffReply(ticketId, at = now()) {
            if (!quietMs || ticketId == null || ticketId === '') return;
            const stamp = Number(at);
            if (!Number.isFinite(stamp)) return;
            const id = String(ticketId);
            lastStaffReplyAt.set(id, stamp);
            persist(save, id, stamp);
        },
        isQuiet(ticketId, at = now()) {
            if (!quietMs || ticketId == null || ticketId === '') return false;
            const id = String(ticketId);
            let last = lastStaffReplyAt.get(id);
            if (last == null) {
                const loaded = persist(load, id);
                const parsed = Number(loaded);
                if (loaded != null && loaded !== '' && Number.isFinite(parsed)) {
                    last = parsed;
                    lastStaffReplyAt.set(id, parsed);
                }
            }
            if (last == null) return false;
            const stamp = Number(at);
            if (!Number.isFinite(stamp)) return false;
            if (stamp - last < quietMs) return true;
            lastStaffReplyAt.delete(id);
            persist(remove, id);
            return false;
        },
    };
}

function bindStaffQuietStore(db) {
    const select = db.prepare('SELECT value FROM bot_kv WHERE key = ?');
    const upsert = db.prepare(
        `INSERT INTO bot_kv (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );
    const removeStmt = db.prepare('DELETE FROM bot_kv WHERE key = ?');
    const sweepExpired = db.prepare(
        "DELETE FROM bot_kv WHERE key LIKE 'staff_quiet:%' AND CAST(value AS INTEGER) <= ?"
    );
    const sweepAll = db.prepare("DELETE FROM bot_kv WHERE key LIKE 'staff_quiet:%'");

    function key(ticketId) {
        return `staff_quiet:${ticketId}`;
    }

    return {
        load(ticketId) {
            const row = select.get(key(ticketId));
            if (!row) return null;
            const at = Number(row.value);
            return Number.isFinite(at) ? at : null;
        },
        save(ticketId, at) {
            upsert.run(key(ticketId), String(at));
        },
        remove(ticketId) {
            removeStmt.run(key(ticketId));
        },
        sweep(now = Date.now(), quietMs = DEFAULT_STAFF_QUIET_SECONDS * 1000) {
            if (!quietMs) {
                sweepAll.run();
                return;
            }
            sweepExpired.run(now - quietMs);
        },
    };
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
    DEFAULT_STAFF_QUIET_SECONDS,
    readStaffQuietMs,
    shouldNoteStaffReply,
    staffQuietSkipLine,
    createStaffQuietTracker,
    bindStaffQuietStore,
    planCustomerForward,
    safeFailureReason,
    postGrokWebhook,
};
