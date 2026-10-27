'use strict';

/**
 * Purchase-ticket auto-reply: FAQ rules, then learned staff replies, then a
 * short escalate. No Discord client in here — index.js owns the gateway.
 */

const fs = require('fs');
const path = require('path');

const FAQ_IDS = new Set([
    'greeting',
    'currency',
    'compatibility',
    'bios',
    'status',
    'shipping',
]);

const DEFAULT_STAFF_USERNAMES = ['rrsky3461'];
const DEFAULT_SEED_PATH = path.join(__dirname, 'data', 'auto_reply_seed.json');

const GREETING_TEXT =
    "hey — send the product, your CPU (Intel or AMD + model), and the game/anti-cheat. staff will take it from here. don't send payment accounts or face-verify codes.";
const CURRENCY_TEXT =
    'panel prices are USD. if you need BRL or another currency, tell me your country and staff will confirm the conversion.';
const BIOS_TEXT =
    'keep BIOS near default (IOMMU, Secure Boot, SVM) until staff says otherwise. screenshots are fine — hide serials.';
const STATUS_TEXT =
    'got it, staff will check that. if they asked you to reset, unplug the DMA card before you reset.';
const SHIPPING_TEXT =
    'staff will send the current kit link. which country, and do you want a hardware kit or firmware only?';
const FALLBACK_TEXT =
    "flagged for staff. one issue per ticket please, and don't send payment accounts or face-verify codes.";
const ESCALATE_TEXT =
    "that's for staff. I won't send payment accounts, face-verify steps, license keys, or undetected claims. they'll handle it in this ticket.";

const LOW_VALUE_EXACT = new Set([
    'hi',
    'hello',
    'hey',
    'yo',
    'oi',
    'ola',
    'yes',
    'no',
    'ok',
    'okk',
    'okkk',
    'kk',
    'ye',
    'yea',
    'yeah',
    'yep',
    'alr',
    'wdym',
    'what',
    'ty',
    'sure',
    'okay',
    'okey',
    'bro',
    'k',
    'att',
    'got it',
    'yes all can',
    'all can',
    'sure bro',
    'sure bro i trust u',
    'okay bro',
    'hello bro',
    'hi bro',
    'ye bro',
    'ok bro',
    'np',
    'thx',
    'thanks',
    'ty bro',
    'what？',
]);

const STAFF_FILLER = new Set([
    'yes',
    'no',
    'ok',
    'ye',
    'yea',
    'yeah',
    'yep',
    'bro',
    'u',
    'you',
    'please',
    'pls',
    'just',
    'alr',
    'okay',
    'kk',
]);

const TOKEN_STOP = new Set([
    'a',
    'an',
    'the',
    'i',
    'u',
    'you',
    'me',
    'my',
    'we',
    'our',
    'to',
    'do',
    'and',
    'or',
    'is',
    'it',
    'this',
    'that',
    'for',
    'in',
    'on',
    'of',
    'bro',
    'pls',
    'please',
    'im',
    'with',
    'can',
    'just',
    'so',
    'ok',
    'if',
    'be',
    'at',
    'from',
    'your',
]);

const GENERIC_STATUS_PROMPTS = new Set([
    'and now',
    'and after',
    'is normal',
    'is this normal',
    'this normal',
    'normal',
    'now',
    'after',
    'ok',
    'okkk',
    'att',
    'ty',
    'got it',
    'yes',
    'no',
    'hi',
    'hello',
    'hey',
]);

function readConfig(env = process.env) {
    const cooldown = resolveCooldownSeconds(env.AUTO_REPLY_COOLDOWN_SECONDS);
    const learnRaw = parseInt(env.AUTO_REPLY_LEARN_WINDOW_SECONDS || '600', 10);
    const learnSeconds = Number.isFinite(learnRaw) && learnRaw >= 30 ? learnRaw : 600;
    const staffUsernames = String(env.AUTO_REPLY_STAFF_USERNAMES || DEFAULT_STAFF_USERNAMES.join(','))
        .split(',')
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean);

    return {
        enabled: isEnabledFlag(env.AUTO_REPLY_ENABLED),
        cooldownMs: cooldown.seconds * 1000,
        cooldownSeconds: cooldown.seconds,
        cooldownClamped: cooldown.clamped,
        learnWindowMs: learnSeconds * 1000,
        staffUsernames: staffUsernames.length ? staffUsernames : DEFAULT_STAFF_USERNAMES.slice(),
        seedPath: env.AUTO_REPLY_SEED_PATH || DEFAULT_SEED_PATH,
    };
}

function isEnabledFlag(value) {
    return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function resolveCooldownSeconds(raw) {
    const parsed = raw == null || String(raw).trim() === '' ? 60 : Number(raw);
    const seconds = Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 60;
    const clamped = Math.min(90, Math.max(45, seconds));
    return { seconds: clamped, clamped: clamped !== seconds };
}

function normalizeText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/<@!?\d+>/g, ' ')
        .replace(/<@&\d+>/g, ' ')
        .replace(/<a?:[^:>]+:\d+>/g, ' ')
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/[’‘]/g, "'")
        .replace(/[^a-z0-9'\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function sanitizeChannelSlug(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

function normalizeProductHint(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Thread names are purchase-{username-slug}-{product-slug}. Username slug is capped at 16.
function productHintFromThread(threadName, customerUsername) {
    const thread = String(threadName || '').toLowerCase();
    const user = sanitizeChannelSlug(customerUsername).slice(0, 16);
    const prefix = user ? `purchase-${user}-` : '';
    let rest = prefix && thread.startsWith(prefix) ? thread.slice(prefix.length) : thread;
    rest = rest.replace(/^purchase-/, '').replace(/^ticket-/, '');
    return normalizeProductHint(rest.replace(/-/g, ' '));
}

function isMentionOrEmojiOnly(text) {
    const stripped = String(text || '')
        .replace(/<@!?\d+>/g, ' ')
        .replace(/<@&\d+>/g, ' ')
        .replace(/<a?:[^:>]+:\d+>/g, ' ')
        .replace(/\s+/g, '')
        .trim();
    return !stripped;
}

function hasUrl(text) {
    return /https?:\/\/|discord\.gg\/|discord\.com\/channels|m\.tb\.cn/i.test(String(text || ''));
}

function isUnsafeText(text) {
    const raw = String(text || '');
    const norm = normalizeText(raw);
    if (/undetected\s+forever/.test(norm)) return true;
    if (/\b(face id|facial|face verif|faceverify)\b/.test(norm)) return true;
    if (/\b(pix|binance|wallet|usdt|btc|iban|crypto)\b/.test(norm)) return true;
    if (/\b(license|licence)\s*key\b/.test(norm)) return true;
    if (/\bactivation\s*key\b/.test(norm)) return true;
    if (/\baccount\b/.test(norm) && /\b(pay|payment|bank|transfer|number)\b/.test(norm)) return true;
    if (/0x[0-9a-f]{8,}/i.test(raw)) return true;
    if (/\b\d{12,}\b/.test(raw)) return true;
    return false;
}

function isEscalation(text) {
    const norm = normalizeText(text);
    if (!norm) return false;
    if (isUnsafeText(text)) return true;
    if (/\b(pay|payment|paying|paid)\b/.test(norm)) return true;
    if (/\bundetected\b/.test(norm)) return true;
    if (/\b(license|licence)\b/.test(norm) && /\b(key|code|send)\b/.test(norm)) return true;
    return false;
}

function hasInstructionKeyword(norm) {
    return /\b(restart|reboot|port|bios|iommu|unplug|speed|default|cpu|dma|flash|svm|secure|boot|intel|driver|slot)\b/.test(
        norm
    );
}

function isLowValueStaffReply(text) {
    const norm = normalizeText(text);
    if (!norm) return true;
    if (LOW_VALUE_EXACT.has(norm)) return true;
    const meaningful = norm.split(' ').filter((token) => !STAFF_FILLER.has(token) && token.length > 1);
    if (meaningful.join(' ').length < 8 && !hasInstructionKeyword(norm)) return true;
    return false;
}

function isGenericStatusPrompt(text) {
    return GENERIC_STATUS_PROMPTS.has(normalizeText(text));
}

function contentTokens(text) {
    return normalizeText(text)
        .split(' ')
        .filter((token) => token.length > 1 && !TOKEN_STOP.has(token) && !/^\d+$/.test(token));
}

function sharedTokenCount(left, right) {
    const rightSet = new Set(contentTokens(right));
    let count = 0;
    for (const token of new Set(contentTokens(left))) {
        if (rightSet.has(token)) count += 1;
    }
    return count;
}

function pairIsMemorable(customerText, staffText) {
    if (isMentionOrEmojiOnly(customerText)) return false;
    if (normalizeText(customerText).length < 4) return false;
    if (isUnsafeText(customerText) || isUnsafeText(staffText)) return false;
    if (hasUrl(staffText)) return false;
    if (isLowValueStaffReply(staffText)) return false;
    return true;
}

function isListedStaffName(username, staffUsernames = DEFAULT_STAFF_USERNAMES) {
    const name = String(username || '').trim().toLowerCase();
    if (!name) return false;
    return staffUsernames.some((staff) => staff === name);
}

function compatibilityText(productLabel) {
    const label = String(productLabel || '').replace(/\s+/g, ' ').trim();
    const which = label ? `this ticket is for ${label}. ` : '';
    return `${which}depends on the product. VGK/Valorant builds usually need an Intel CPU. what's your CPU? I won't guess past that.`;
}

function isBiosQuestion(norm) {
    return /\b(bios|iommu|secure boot|svm|vt d|vt x|virtualization)\b/.test(norm);
}

function isCurrencyQuestion(norm) {
    if (/\b(usd|brl|dollars|dollar|reais)\b/.test(norm)) return true;
    if (/\bin real\b/.test(norm)) return true;
    if (/\bcurrency\b/.test(norm)) return true;
    return false;
}

function isCompatibilityQuestion(norm) {
    return /\b(vgk|vanguard|valo|valorant|battleye|battle eye|eac|easy anti cheat)\b/.test(norm);
}

function isShippingQuestion(norm) {
    return (
        /\b(shipping|ship|ships|deliver|delivery|hardware)\b/.test(norm) ||
        /\b(dma\s+)?kits?\b/.test(norm) ||
        /\b(brazil|brasil)\b/.test(norm)
    );
}

function isStatusQuestion(norm, hasAttachments) {
    if (/^(and now|and after|is normal|is this normal|this normal)\b/.test(norm)) return true;
    if (norm === 'normal') return true;
    if (!hasAttachments) return false;
    if (!norm) return true;
    const words = norm.split(' ');
    if (words.length <= 4 && /\b(normal|now|after|this|screenshot|pic|photo|image)\b/.test(norm)) {
        return true;
    }
    return false;
}

function isGreeting(norm) {
    if (!norm) return false;
    const words = norm.split(' ');
    if (words.length > 6) return false;
    if (!/^(hi|hello|hey|yo|oi|ola|sup|hola)\b/.test(norm) && !/^(good morning|good evening|good afternoon)\b/.test(norm)) {
        return false;
    }
    if (words.length > 3 && /\b(need|want|buy|how|what|why|when|where|help|problem|issue|price|pay)\b/.test(norm)) {
        return false;
    }
    return true;
}

function matchFaq({ content, hasAttachments = false, productLabel = '' }) {
    const raw = String(content || '');
    const norm = normalizeText(raw);
    if (!norm && !hasAttachments) return null;

    if (isEscalation(raw)) {
        return { id: 'fallback', priority: true, text: ESCALATE_TEXT };
    }
    if (isBiosQuestion(norm)) return { id: 'bios', text: BIOS_TEXT };
    if (isCurrencyQuestion(norm)) return { id: 'currency', text: CURRENCY_TEXT };
    if (isCompatibilityQuestion(norm)) return { id: 'compatibility', text: compatibilityText(productLabel) };
    if (isShippingQuestion(norm)) return { id: 'shipping', text: SHIPPING_TEXT };
    if (isStatusQuestion(norm, hasAttachments)) return { id: 'status', text: STATUS_TEXT };
    if (isGreeting(norm)) return { id: 'greeting', text: GREETING_TEXT };
    return null;
}

function hintsRelated(left, right) {
    if (!left || !right) return false;
    if (left === right) return true;
    const rightSet = new Set(right.split(' ').filter((token) => token.length >= 4));
    return left.split(' ').some((token) => token.length >= 4 && rightSet.has(token));
}

function memoryScore(query, row, productHint) {
    if (!row || isUnsafeText(row.staff_text) || hasUrl(row.staff_text) || isLowValueStaffReply(row.staff_text)) {
        return 0;
    }
    const queryTokens = contentTokens(query);
    const customerTokens = contentTokens(row.customer_text);
    if (!queryTokens.length || !customerTokens.length) return 0;

    const customerSet = new Set(customerTokens);
    const querySet = new Set(queryTokens);
    let inter = 0;
    for (const token of querySet) {
        if (customerSet.has(token)) inter += 1;
    }
    if (!inter) return 0;

    const overlap = inter / Math.min(querySet.size, customerSet.size);
    const identical = normalizeText(query) === normalizeText(row.customer_text);
    const queryCovered = [...querySet].every((token) => customerSet.has(token));
    const strong =
        inter >= 2 || identical || (queryCovered && querySet.size >= 2 && overlap >= 0.67);
    if (!strong) return 0;

    let score = overlap;
    if (productHint && hintsRelated(productHint, row.product_hint || '')) score += 0.2;
    return score;
}

function sanitizeReply(text) {
    const cleaned = String(text || '')
        .replace(/<@!?\d+>/g, '')
        .replace(/<@&\d+>/g, '')
        .replace(/@everyone|@here/gi, '')
        .trim();
    if (!cleaned) return '';
    if (cleaned.length <= 450) return cleaned;
    return `${cleaned.slice(0, 447)}...`;
}

function pickMemory(query, rows, productHint) {
    let best = null;
    let bestScore = 0;
    for (const row of rows || []) {
        const score = memoryScore(query, row, productHint);
        if (score < 0.67) continue;
        if (
            !best ||
            score > bestScore ||
            (score === bestScore && (row.id || 0) > (best.id || 0))
        ) {
            best = row;
            bestScore = score;
        }
    }
    if (!best) return null;
    const text = sanitizeReply(best.staff_text);
    if (!text || isUnsafeText(text) || hasUrl(text)) return null;
    return { text, score: bestScore, id: best.id };
}

function decideReply({
    content,
    productLabel = '',
    productHint = '',
    hasAttachments = false,
    memoryRows = [],
    last = null,
    now = Date.now(),
    cooldownMs = 60000,
}) {
    const hint = normalizeProductHint(productHint);
    const faq = matchFaq({ content, hasAttachments, productLabel });
    const category = faq && !faq.priority ? faq.id : faq?.priority ? 'fallback' : null;

    if (last && now - last.at < cooldownMs) {
        const bypass = FAQ_IDS.has(category) && category !== last.category;
        if (!bypass) {
            return { shouldReply: false, reason: 'cooldown', category: category || last.category || null, text: '' };
        }
    }

    if (!normalizeText(content) && !hasAttachments) {
        return { shouldReply: false, reason: 'skip', category: null, text: '' };
    }

    if (faq?.priority) {
        return { shouldReply: true, reason: 'fallback', category: 'fallback', text: faq.text };
    }
    if (faq) {
        return { shouldReply: true, reason: 'faq', category: faq.id, text: faq.text };
    }

    const memory = pickMemory(content, memoryRows, hint);
    if (memory) {
        return { shouldReply: true, reason: 'memory', category: 'memory', text: memory.text };
    }

    return { shouldReply: true, reason: 'fallback', category: 'fallback', text: FALLBACK_TEXT };
}

function chooseBurst(burst) {
    if (burst.length === 1) return burst[0];
    let best = null;
    let bestScore = 0;
    for (const pair of burst) {
        const score = sharedTokenCount(pair.customer_text, pair.staff_text);
        if (score > bestScore) {
            best = pair;
            bestScore = score;
        }
    }
    // The same staff line sprayed across unrelated customer lines is extraction noise.
    return bestScore > 0 ? best : null;
}

function filterSeedPairs(pairs, staffUsernames = DEFAULT_STAFF_USERNAMES) {
    const staffSet = new Set(
        (staffUsernames.length ? staffUsernames : DEFAULT_STAFF_USERNAMES).map((name) => name.toLowerCase())
    );
    const groups = new Map();

    for (const pair of pairs || []) {
        const staff = String(pair.staff || '').trim().toLowerCase();
        const customer = String(pair.customer || '').trim().toLowerCase();
        const customerText = String(pair.customer_msg || pair.customer_text || '').trim();
        const staffText = String(pair.staff_msg || pair.staff_text || '').trim();
        const thread = String(pair.thread || '');

        // Inverted extracts put rrsky3461 in `customer` and the buyer in `staff`.
        const usable =
            staffSet.has(staff) &&
            !staffSet.has(customer) &&
            pairIsMemorable(customerText, staffText) &&
            !isGenericStatusPrompt(customerText);
        if (!usable) continue;

        const next = {
            thread,
            customer,
            customer_text: customerText,
            staff,
            staff_text: staffText,
            product_hint: normalizeProductHint(pair.product_hint) || productHintFromThread(thread, customer),
        };
        const key = `${thread}|${normalizeText(staffText)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(next);
    }

    const kept = [];
    for (const group of groups.values()) {
        const chosen = chooseBurst(group);
        if (chosen) kept.push(chosen);
    }

    const seen = new Set();
    const unique = [];
    for (const pair of kept) {
        const key = `${normalizeText(pair.customer_text)}|${normalizeText(pair.staff_text)}|${pair.product_hint}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(pair);
    }
    return unique;
}

function ensureSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS auto_reply_memory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticket_id TEXT,
            product_hint TEXT NOT NULL DEFAULT '',
            customer_text TEXT NOT NULL,
            staff_text TEXT NOT NULL,
            customer_norm TEXT NOT NULL,
            staff_norm TEXT NOT NULL,
            staff_user TEXT,
            source TEXT NOT NULL DEFAULT 'live',
            created_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_reply_memory_pair
            ON auto_reply_memory(customer_norm, staff_norm, product_hint);
    `);
}

function insertMemory(db, entry) {
    const customerText = String(entry.customerText || '').trim();
    const staffText = String(entry.staffText || '').trim();
    if (!pairIsMemorable(customerText, staffText)) return false;

    const productHint = normalizeProductHint(entry.productHint || '');
    const result = db
        .prepare(
            `INSERT OR IGNORE INTO auto_reply_memory (
                ticket_id, product_hint, customer_text, staff_text, customer_norm, staff_norm, staff_user, source, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            entry.ticketId || null,
            productHint,
            customerText,
            sanitizeReply(staffText),
            normalizeText(customerText),
            normalizeText(staffText),
            entry.staffUser || null,
            entry.source || 'live',
            entry.createdAt || Date.now()
        );
    return result.changes > 0;
}

function loadRecentMemory(db, limit = 400) {
    return db
        .prepare(
            `SELECT id, ticket_id, product_hint, customer_text, staff_text, staff_user, source, created_at
             FROM auto_reply_memory
             ORDER BY id DESC
             LIMIT ?`
        )
        .all(limit);
}

function createAutoReply(db, env = process.env) {
    ensureSchema(db);
    const config = readConfig(env);
    const cooldowns = new Map();

    function seedPairs(pairs, source = 'seed') {
        let inserted = 0;
        let skipped = 0;
        for (const pair of filterSeedPairs(pairs, config.staffUsernames)) {
            const ok = insertMemory(db, {
                ticketId: pair.thread || null,
                productHint: pair.product_hint,
                customerText: pair.customer_text,
                staffText: pair.staff_text,
                staffUser: pair.staff,
                source,
            });
            if (ok) inserted += 1;
            else skipped += 1;
        }
        return { inserted, skipped };
    }

    function seedFromFile(filePath = config.seedPath) {
        if (!config.enabled) return { inserted: 0, skipped: 0, loaded: false };
        if (!filePath || !fs.existsSync(filePath)) {
            return { inserted: 0, skipped: 0, loaded: false };
        }
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (err) {
            console.error('[auto-reply] seed file unreadable:', err.message);
            return { inserted: 0, skipped: 0, loaded: false };
        }
        const pairs = Array.isArray(parsed) ? parsed : parsed.pairs || [];
        const result = seedPairs(pairs);
        return { ...result, loaded: true };
    }

    return {
        config,
        seedPairs,
        seedFromFile,
        remember(entry) {
            if (!config.enabled) return false;
            return insertMemory(db, entry);
        },
        recentMemory() {
            return loadRecentMemory(db);
        },
        decide(input) {
            const key = `${input.ticketId}:${input.userId}`;
            const decision = decideReply({
                content: input.content,
                productLabel: input.productLabel,
                productHint: input.productHint,
                hasAttachments: input.hasAttachments,
                memoryRows: input.memoryRows || loadRecentMemory(db),
                last: cooldowns.get(key) || null,
                now: input.now || Date.now(),
                cooldownMs: config.cooldownMs,
            });
            return decision;
        },
        markSent(ticketId, userId, category, now = Date.now()) {
            cooldowns.set(`${ticketId}:${userId}`, { at: now, category });
        },
        clearSent(ticketId, userId) {
            cooldowns.delete(`${ticketId}:${userId}`);
        },
        isListedStaff(username) {
            return isListedStaffName(username, config.staffUsernames);
        },
    };
}

module.exports = {
    FAQ_IDS,
    DEFAULT_SEED_PATH,
    GREETING_TEXT,
    CURRENCY_TEXT,
    BIOS_TEXT,
    STATUS_TEXT,
    SHIPPING_TEXT,
    FALLBACK_TEXT,
    ESCALATE_TEXT,
    readConfig,
    resolveCooldownSeconds,
    normalizeText,
    normalizeProductHint,
    productHintFromThread,
    isUnsafeText,
    isLowValueStaffReply,
    isListedStaffName,
    pairIsMemorable,
    matchFaq,
    memoryScore,
    pickMemory,
    decideReply,
    filterSeedPairs,
    ensureSchema,
    insertMemory,
    loadRecentMemory,
    createAutoReply,
};
