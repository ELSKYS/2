'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const {
    BIOS_TEXT,
    CURRENCY_TEXT,
    ESCALATE_TEXT,
    FALLBACK_TEXT,
    GREETING_TEXT,
    SHIPPING_TEXT,
    STATUS_TEXT,
    createAutoReply,
    decideReply,
    filterSeedPairs,
    matchFaq,
    productHintFromThread,
    readConfig,
    resolveCooldownSeconds,
} = require('./autoReply');

const RAW_SEED = path.join(
    '/home/ubuntu/.cursor/projects/workspace/uploads/redbot-learn-pairs_1f20.json'
);

function decision(content, extra = {}) {
    return decideReply({
        content,
        memoryRows: extra.memoryRows || [],
        productLabel: extra.productLabel || '',
        productHint: extra.productHint || '',
        hasAttachments: extra.hasAttachments || false,
        last: extra.last || null,
        now: extra.now || 1_000_000,
        cooldownMs: extra.cooldownMs || 60_000,
    });
}

test('cooldown stays inside 45-90 seconds', () => {
    assert.deepEqual(resolveCooldownSeconds(''), { seconds: 60, clamped: false });
    assert.deepEqual(resolveCooldownSeconds('45'), { seconds: 45, clamped: false });
    assert.deepEqual(resolveCooldownSeconds('90'), { seconds: 90, clamped: false });
    assert.deepEqual(resolveCooldownSeconds('10'), { seconds: 45, clamped: true });
    assert.deepEqual(resolveCooldownSeconds('120'), { seconds: 90, clamped: true });
    assert.equal(readConfig({ AUTO_REPLY_ENABLED: 'true' }).enabled, true);
    assert.equal(readConfig({}).enabled, false);
    assert.equal(readConfig({ AUTO_REPLY_ENABLED: 'false' }).enabled, false);
});

test('FAQ covers the approved starter cases and refuses payment secrets', () => {
    assert.equal(matchFaq({ content: 'Hello' }).id, 'greeting');
    assert.equal(matchFaq({ content: 'yo' }).text, GREETING_TEXT);
    assert.match(GREETING_TEXT, /CPU/i);
    assert.match(GREETING_TEXT, /face-verify/i);

    const currency = matchFaq({ content: 'Are these amounts in dollars or in BRL?' });
    assert.equal(currency.id, 'currency');
    assert.equal(currency.text, CURRENCY_TEXT);
    assert.match(CURRENCY_TEXT, /USD/);

    const vgk = matchFaq({ content: 'does VGK work on valorant?', productLabel: 'VGK' });
    assert.equal(vgk.id, 'compatibility');
    assert.match(vgk.text, /Intel CPU/);
    assert.match(vgk.text, /VGK/);
    assert.doesNotMatch(vgk.text, /undetected/i);

    const bios = matchFaq({
        content: 'Does the fw work with IOMMU, secure boot normally enabled?',
    });
    assert.equal(bios.id, 'bios');
    assert.equal(bios.text, BIOS_TEXT);

    assert.equal(matchFaq({ content: 'and with SVM MODE also?' }).id, 'bios');
    assert.equal(matchFaq({ content: 'vgk but what about iommu?' }).id, 'bios');

    assert.equal(matchFaq({ content: 'and now?' }).text, STATUS_TEXT);
    assert.equal(matchFaq({ content: 'is normal?' }).id, 'status');
    assert.equal(matchFaq({ content: '', hasAttachments: true }).id, 'status');
    assert.match(STATUS_TEXT, /unplug/i);

    const ship = matchFaq({ content: 'Do you sell DMA kits to Brazil?' });
    assert.equal(ship.id, 'shipping');
    assert.equal(ship.text, SHIPPING_TEXT);
    assert.doesNotMatch(ship.text, /https?:/i);

    const pay = decision('send the pix account and face id steps');
    assert.equal(pay.reason, 'fallback');
    assert.equal(pay.text, ESCALATE_TEXT);
    assert.doesNotMatch(pay.text, /\b\d{8,}\b/);

    const undetected = decision('is it undetected forever?');
    assert.equal(undetected.reason, 'fallback');
    assert.equal(undetected.text, ESCALATE_TEXT);
});

test('a new FAQ category can reply inside the cooldown', () => {
    const now = 5_000_000;
    const blocked = decision('hello', {
        now,
        last: { at: now - 10_000, category: 'greeting' },
    });
    assert.equal(blocked.shouldReply, false);
    assert.equal(blocked.reason, 'cooldown');

    const allowed = decision('secure boot on?', {
        now,
        last: { at: now - 10_000, category: 'greeting' },
    });
    assert.equal(allowed.shouldReply, true);
    assert.equal(allowed.reason, 'faq');
    assert.equal(allowed.category, 'bios');

    const memoryBlocked = decision('something else about the install log', {
        now,
        last: { at: now - 10_000, category: 'greeting' },
        memoryRows: [
            {
                id: 1,
                customer_text: 'something else about the install log',
                staff_text: 'open the tool on the second pc',
                product_hint: 'hidden 6 months',
            },
        ],
    });
    assert.equal(memoryBlocked.reason, 'cooldown');
});

test('memory answers a close question and never repeats unsafe staff text', () => {
    const rows = [
        {
            id: 1,
            customer_text: 'i restart and make this or',
            staff_text: 'yes restart pc',
            product_hint: 'hidden 6 months',
        },
        {
            id: 2,
            customer_text: 'i restart and make this or',
            staff_text: 'send pix 123456789012 wallet',
            product_hint: 'hidden 6 months',
        },
        {
            id: 3,
            customer_text: 'ta dando failed on the read',
            staff_text: 'use dma card other port',
            product_hint: 'hidden 6 months',
        },
        {
            id: 4,
            customer_text: 'ta dando failed on the read',
            staff_text: 'use dma card other port',
            product_hint: 'vgk',
        },
    ];

    const hit = decision('i restart and make this or', {
        memoryRows: rows,
        productHint: 'Hidden (6 Months)',
    });
    assert.equal(hit.reason, 'memory');
    assert.equal(hit.text, 'yes restart pc');

    const port = decision('ta dando failed on the read', {
        memoryRows: rows,
        productHint: 'hidden 6 months',
    });
    assert.equal(port.reason, 'memory');
    assert.equal(port.text, 'use dma card other port');

    const unknown = decision('the activator window is stuck on the second pc', { memoryRows: rows });
    assert.equal(unknown.reason, 'fallback');
    assert.equal(unknown.text, FALLBACK_TEXT);
});

test('seed filter keeps rrsky3461 answers and drops inverted or unsafe pairs', () => {
    const pairs = [
        {
            thread: 'purchase-trigger0ms-hidden-6-months',
            customer: 'trigger0ms',
            customer_msg: 'i restart and make this or',
            staff: 'rrsky3461',
            staff_msg: 'yes restart pc',
        },
        {
            thread: 'purchase-trigger0ms-hidden-6-months',
            customer: 'trigger0ms',
            customer_msg: 'help me man',
            staff: 'rrsky3461',
            staff_msg: 'yes restart pc',
        },
        {
            thread: 'purchase-trigger0ms-hidden-6-months',
            customer: 'rrsky3461',
            customer_msg: 'yes restart pc',
            staff: 'trigger0ms',
            staff_msg: 'and now?',
        },
        {
            thread: 'purchase-trigger0ms-hidden-6-months',
            customer: 'trigger0ms',
            customer_msg: 'and now?',
            staff: 'rrsky3461',
            staff_msg: 'do speed test',
        },
        {
            thread: 'purchase-eventvwr-gg-hidden-6-months',
            customer: 'eventvwr.gg',
            customer_msg: 'Ta dando failed',
            staff: 'rrsky3461',
            staff_msg: 'use dma card other port',
        },
        {
            thread: 'purchase-eventvwr-gg-hidden-6-months',
            customer: 'eventvwr.gg',
            customer_msg: '0x005cec0172fef05c',
            staff: 'rrsky3461',
            staff_msg: 'ok',
        },
        {
            thread: 'purchase-eventvwr-gg-hidden-6-months',
            customer: 'eventvwr.gg',
            customer_msg: 'waiting for facial',
            staff: 'rrsky3461',
            staff_msg: 'okay bro',
        },
        {
            thread: 'purchase-karapaufps-specific-firmware-be-jav',
            customer: 'karapaufps',
            customer_msg: 'Yes, which link?',
            staff: 'rrsky3461',
            staff_msg: 'https://m.tb.cn/h.jVk5hAa?tk=ffLxTCsXfFq',
        },
        {
            thread: 'purchase-eventvwr-gg-hidden-6-months',
            customer: 'eventvwr.gg',
            customer_msg: 'and with SVM MODE also?',
            staff: 'rrsky3461',
            staff_msg: 'You can keep bios as the default mode.',
        },
    ];

    const kept = filterSeedPairs(pairs);
    const staffTexts = kept.map((pair) => pair.staff_text).sort();
    assert.deepEqual(staffTexts, [
        'You can keep bios as the default mode.',
        'use dma card other port',
        'yes restart pc',
    ]);
    assert.equal(kept.find((pair) => pair.staff_text === 'yes restart pc').customer_text, 'i restart and make this or');
    assert.equal(
        productHintFromThread('purchase-eventvwr-gg-hidden-6-months', 'eventvwr.gg'),
        'hidden 6 months'
    );
    for (const pair of kept) {
        assert.equal(pair.staff, 'rrsky3461');
        assert.notEqual(pair.customer, 'rrsky3461');
        assert.doesNotMatch(pair.staff_text, /https?:|0x[0-9a-f]{8,}|facial|undetected/i);
    }
});

test('historical seed file only contains verified rrsky3461 pairs', () => {
    const committed = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'data', 'auto_reply_seed.json'), 'utf8')
    );
    assert.deepEqual(filterSeedPairs(committed), committed);
    assert.ok(committed.length >= 3);
    const texts = committed.map((pair) => pair.staff_text).sort();
    assert.deepEqual(texts, [
        'You can keep bios as the default mode.',
        'use dma card other port',
        'yes restart pc',
    ]);
    for (const pair of committed) {
        assert.equal(pair.staff, 'rrsky3461');
        assert.notEqual(pair.customer, 'rrsky3461');
        assert.doesNotMatch(pair.staff_text, /https?:|0x[0-9a-f]{8,}|facial|undetected/i);
    }

    if (fs.existsSync(RAW_SEED)) {
        const raw = JSON.parse(fs.readFileSync(RAW_SEED, 'utf8'));
        assert.deepEqual(filterSeedPairs(raw.pairs), committed);
    }

    const kept = committed;

    const db = new Database(':memory:');
    const bot = createAutoReply(db, {
        AUTO_REPLY_ENABLED: 'true',
        AUTO_REPLY_SEED_PATH: path.join(__dirname, 'data', 'auto_reply_seed.json'),
    });
    const seeded = bot.seedFromFile();
    assert.equal(seeded.inserted, kept.length);
    const again = bot.seedFromFile();
    assert.equal(again.inserted, 0);
    assert.equal(again.skipped, kept.length);

    const learned = bot.remember({
        ticketId: 'thread-1',
        productHint: 'Hidden (6 Months)',
        customerText: 'the tool says failed when i read',
        staffText: 'try the other dma port',
        staffUser: 'rrsky3461',
        source: 'live',
    });
    assert.equal(learned, true);
    assert.equal(
        bot.remember({
            ticketId: 'thread-1',
            productHint: 'Hidden (6 Months)',
            customerText: 'send license key please',
            staffText: 'ABCD-1111-forever',
            staffUser: 'rrsky3461',
        }),
        false
    );

    const reply = bot.decide({
        ticketId: 'thread-1',
        userId: 'customer',
        content: 'i restart and make this or',
        productHint: 'hidden 6 months',
    });
    assert.equal(reply.reason, 'memory');
    assert.equal(reply.text, 'yes restart pc');
    db.close();
});

test('messageCreate runs auto-reply on threads after mention invites', () => {
    const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
    const inviteAt = source.indexOf('await inviteMentionedUsers(message);');
    const replyAt = source.indexOf('await handlePurchaseTicketAutoReply(message);');
    const returnAt = source.indexOf('if (message.channel?.isThread?.()) {');
    assert.ok(inviteAt > 0 && replyAt > inviteAt);
    assert.ok(returnAt > 0 && returnAt < replyAt);
    assert.match(source, /isActiveTicketChannel\(channel\)/);
    assert.doesNotMatch(source, /new Client\([\s\S]*new Client\(/);
});
