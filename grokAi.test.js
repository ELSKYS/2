'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { createAutoReply } = require('./autoReply');
const {
    CONTENT_MAX,
    RECENT_LIMIT,
    buildGrokPayload,
    chooseTicketReplyMode,
    planCustomerForward,
    postGrokWebhook,
    readGrokConfig,
    safeFailureReason,
    ticketMetadata,
    webhookProblem,
} = require('./grokAi');

test('Grok forwarding is off unless the enable flag is explicitly on', () => {
    assert.equal(readGrokConfig({}).enabled, false);
    assert.equal(readGrokConfig({ GROK_BOT_AI_ENABLED: '' }).enabled, false);
    for (const flag of ['false', '0', 'no', 'off', 'nope']) {
        assert.equal(readGrokConfig({ GROK_BOT_AI_ENABLED: flag }).enabled, false);
    }
    for (const flag of ['true', '1', 'yes', 'on', ' TRUE ', 'Yes']) {
        const config = readGrokConfig({
            GROK_BOT_AI_ENABLED: flag,
            GROK_BOT_WEBHOOK_URL: ' https://hooks.example/grok ',
            GROK_BOT_WEBHOOK_KEY: ' secret ',
        });
        assert.equal(config.enabled, true);
        assert.equal(config.webhookUrl, 'https://hooks.example/grok');
        assert.equal(config.webhookKey, 'secret');
    }
    assert.equal(webhookProblem({ webhookUrl: '', webhookKey: 'k' }), 'missing GROK_BOT_WEBHOOK_URL');
    assert.match(webhookProblem({ webhookUrl: 'http://hooks.example/grok', webhookKey: 'k' }), /https/);
    assert.equal(
        webhookProblem({ webhookUrl: 'https://hooks.example/grok', webhookKey: '' }),
        'missing GROK_BOT_WEBHOOK_KEY'
    );
    assert.equal(webhookProblem({ webhookUrl: 'https://hooks.example/grok', webhookKey: 'k' }), null);
});

test('payload includes ticket context and drops secrets, bots, and overflow', () => {
    const long = `pay? ${'x'.repeat(CONTENT_MAX)}`;
    const recent = [];
    for (let i = 0; i < RECENT_LIMIT + 2; i += 1) {
        recent.push({
            messageId: `m${i}`,
            authorId: `u${i}`,
            authorUsername: `buyer${i}`,
            content: `note ${i} ${'y'.repeat(500)}`,
        });
    }
    recent.splice(1, 0, {
        messageId: 'bot-1',
        authorId: 'bot',
        authorUsername: 'RED BOT',
        authorBot: true,
        content: 'local faq reply that must not be context',
    });

    const payload = buildGrokPayload({
        channelId: 'chan-1',
        messageId: 'msg-9',
        content: long,
        authorUsername: 'buyer',
        authorId: 'user-9',
        guildId: 'guild-1',
        threadName: 'purchase-buyer-hidden-6-months',
        hasAttachments: false,
        token: 'discord-token-should-not-leak',
        TOKEN: 'discord-token-should-not-leak',
        webhookKey: 'bearer-secret-value',
        Authorization: 'Bearer bearer-secret-value',
        ticket: {
            ticket_id: 'chan-1',
            user_id: 'user-9',
            product_name: 'Hidden (6 Months)',
            product_id: 4,
            status: 'open',
            source_channel_id: 'panel-1',
            token: 'discord-token-should-not-leak',
        },
        recentMessages: recent,
    });

    assert.equal(payload.type, 'purchase_ticket_message');
    assert.equal(payload.channelId, 'chan-1');
    assert.equal(payload.messageId, 'msg-9');
    assert.equal(payload.authorUsername, 'buyer');
    assert.equal(payload.authorId, 'user-9');
    assert.equal(payload.guildId, 'guild-1');
    assert.equal(payload.productName, 'Hidden (6 Months)');
    assert.equal(payload.productId, 4);
    assert.equal(payload.threadName, 'purchase-buyer-hidden-6-months');
    assert.equal(payload.content.length, CONTENT_MAX);
    assert.match(payload.content, /\.\.\.$/);
    assert.equal(payload.recentMessages.length, RECENT_LIMIT);
    assert.equal(payload.recentMessages[0].messageId, 'm2');
    assert.equal(payload.recentMessages.at(-1).messageId, `m${RECENT_LIMIT + 1}`);
    assert.ok(payload.recentMessages.every((message) => message.content.length <= 400));
    assert.deepEqual(payload.ticket, ticketMetadata(payload.ticket));
    assert.equal(payload.ticket.ticketId, 'chan-1');
    assert.equal(payload.ticket.sourceChannelId, 'panel-1');

    const encoded = JSON.stringify(payload);
    assert.equal(encoded.includes('discord-token-should-not-leak'), false);
    assert.equal(encoded.includes('bearer-secret-value'), false);
    assert.equal(Object.hasOwn(payload, 'token'), false);
    assert.equal(Object.hasOwn(payload, 'webhookKey'), false);
    if (process.env.TOKEN) {
        assert.equal(encoded.includes(process.env.TOKEN), false);
    }

    const noGuild = buildGrokPayload({
        channelId: 'chan-2',
        messageId: 'msg-2',
        content: 'hello',
        authorUsername: 'buyer',
        authorId: 'user-2',
    });
    assert.equal(noGuild.guildId, null);
    assert.equal(noGuild.ticket, null);
    assert.deepEqual(noGuild.recentMessages, []);
});

test('staff, bots, and inactive tickets are never forwarded', () => {
    const base = { grokEnabled: true, autoReplyEnabled: true, isActiveTicket: true };
    assert.equal(chooseTicketReplyMode({ ...base, authorIsStaff: true }), 'learn');
    assert.equal(
        chooseTicketReplyMode({ ...base, autoReplyEnabled: false, authorIsStaff: true }),
        'ignore'
    );
    assert.equal(chooseTicketReplyMode({ ...base, authorIsBot: true }), 'ignore');
    assert.equal(chooseTicketReplyMode({ ...base, isActiveTicket: false }), 'ignore');
    assert.equal(chooseTicketReplyMode({ ...base }), 'grok');
    assert.equal(
        chooseTicketReplyMode({ grokEnabled: false, autoReplyEnabled: true, isActiveTicket: true }),
        'auto-reply'
    );
    assert.equal(chooseTicketReplyMode({ isActiveTicket: true }), 'ignore');
});

test('forward plan reuses the per-user ticket cooldown and FAQ bypass', () => {
    const now = 8_000_000;
    const last = { at: now - 10_000, category: 'greeting' };
    const blocked = planCustomerForward({ content: 'hello again', last, now });
    assert.equal(blocked.forward, false);
    assert.equal(blocked.reason, 'cooldown');

    const bios = planCustomerForward({ content: 'is secure boot ok?', last, now });
    assert.equal(bios.forward, true);
    assert.equal(bios.category, 'bios');

    const empty = planCustomerForward({ content: '   ', now });
    assert.equal(empty.forward, false);
    assert.equal(empty.reason, 'skip');

    const db = new Database(':memory:');
    const bot = createAutoReply(db, { AUTO_REPLY_ENABLED: 'false' });
    const first = bot.decide({
        ticketId: 'thread-1',
        userId: 'customer',
        content: 'hello',
        now,
    });
    assert.equal(first.shouldReply, true);
    bot.markSent('thread-1', 'customer', first.category, now);
    const second = bot.decide({
        ticketId: 'thread-1',
        userId: 'customer',
        content: 'hello there',
        now: now + 5_000,
    });
    assert.equal(second.shouldReply, false);
    assert.equal(second.reason, 'cooldown');
    const otherUser = bot.decide({
        ticketId: 'thread-1',
        userId: 'someone-else',
        content: 'hello',
        now: now + 5_000,
    });
    assert.equal(otherUser.shouldReply, true);
    db.close();
});

test('webhook POST is HTTPS JSON with a bearer token and does not send on bad config', async () => {
    let calls = 0;
    const payload = buildGrokPayload({
        channelId: 'chan-1',
        messageId: 'msg-1',
        content: 'do you ship kits to Brazil?',
        authorUsername: 'buyer',
        authorId: 'user-1',
        guildId: 'guild-1',
    });
    const result = await postGrokWebhook({
        url: 'https://hooks.example/grok',
        key: 'test-key',
        payload,
        fetchImpl: async (url, options) => {
            calls += 1;
            assert.equal(url, 'https://hooks.example/grok');
            assert.equal(options.method, 'POST');
            assert.equal(options.headers.Authorization, 'Bearer test-key');
            assert.equal(options.headers['Content-Type'], 'application/json');
            assert.deepEqual(JSON.parse(options.body), payload);
            assert.equal(options.body.includes('test-key'), false);
            return { ok: true, status: 200 };
        },
    });
    assert.equal(calls, 1);
    assert.deepEqual(result, { ok: true, status: 200 });

    const rejected = await postGrokWebhook({
        url: 'https://hooks.example/grok',
        key: 'test-key',
        payload,
        fetchImpl: async () => ({ ok: false, status: 503 }),
    });
    assert.deepEqual(rejected, { ok: false, status: 503 });

    let blocked = 0;
    await assert.rejects(
        () =>
            postGrokWebhook({
                url: 'http://hooks.example/grok',
                key: 'test-key',
                payload,
                fetchImpl: () => {
                    blocked += 1;
                    return { ok: true, status: 200 };
                },
            }),
        /https/
    );
    await assert.rejects(
        () =>
            postGrokWebhook({
                url: 'https://hooks.example/grok',
                key: '',
                payload,
                fetchImpl: () => {
                    blocked += 1;
                    return { ok: true, status: 200 };
                },
            }),
        /GROK_BOT_WEBHOOK_KEY/
    );
    assert.equal(blocked, 0);

    const reason = safeFailureReason(
        new Error('connect ECONNREFUSED https://hooks.example/abc?sig=secret-key-value'),
        {
            webhookUrl: 'https://hooks.example/abc?sig=secret-key-value',
            webhookKey: 'secret-key-value',
        }
    );
    assert.equal(reason.includes('secret-key-value'), false);
    assert.equal(reason.includes('hooks.example'), false);
    assert.equal(safeFailureReason({ name: 'AbortError', message: 'timeout' }), 'request timed out');
});

test('the thread handler forwards after mention invites and keeps one gateway', () => {
    const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
    assert.equal((source.match(/new Client\(/g) || []).length, 1);
    assert.equal((source.match(/\.login\(/g) || []).length, 1);

    const inviteAt = source.indexOf('await inviteMentionedUsers(message);');
    const handlerAt = source.indexOf('await handlePurchaseTicketAutoReply(message);');
    assert.ok(inviteAt > 0 && handlerAt > inviteAt);

    const fnStart = source.indexOf('function forwardTicketToGrok');
    const fnEnd = source.indexOf("client.on('messageCreate'");
    const fn = source.slice(fnStart, fnEnd);
    assert.match(fn, /isActiveTicketChannel\(channel\)/);
    assert.match(fn, /messageAuthorIsStaff\(message\)/);
    assert.match(fn, /chooseTicketReplyMode\(/);
    const forwardFn = fn.slice(0, fn.indexOf('async function deliverGrokForward'));
    assert.match(forwardFn, /autoReply\.decide\(/);
    assert.match(forwardFn, /autoReply\.markSent\(/);

    const learnAt = fn.indexOf("mode === 'learn'");
    const grokAt = fn.indexOf("mode === 'grok'");
    const replyAt = fn.indexOf('message.reply(');
    assert.ok(learnAt > 0 && grokAt > learnAt && replyAt > grokAt);
    assert.match(fn.slice(grokAt, replyAt), /return;/);
    assert.match(source, /\[grok-ai\] forwarded ticket=/);
});
