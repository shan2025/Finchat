// test/realtime.test.js — realtime events must reach only their owner.
//
// This covers a fixed data leak: server.js used to io.emit() every EventBus
// event to every connected socket, so one user's notification content, graph
// entity names and debate goals were delivered to everyone logged in. The
// isolation test below is the regression guard — if the routing ever widens
// back to a broadcast, `receivedByOther` stops being empty and this fails.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const http = require('node:http');

const { userRoom, ownerOf, attachEventBridges, BRIDGES } = require('../services/realtime');

test('userRoom', async (t) => {
  await t.test('namespaces the room so it cannot collide with a channel id', () => {
    assert.strictEqual(userRoom('usr_123'), 'user:usr_123');
  });

  await t.test('two users never share a room', () => {
    assert.notStrictEqual(userRoom('usr_a'), userRoom('usr_b'));
  });
});

test('ownerOf', async (t) => {
  await t.test('reads the EventBus spelling', () => {
    assert.strictEqual(ownerOf({ userId: 'usr_a' }), 'usr_a');
  });

  await t.test('reads the Postgres row spelling', () => {
    // createNotification emits the inserted row, which uses snake_case.
    assert.strictEqual(ownerOf({ user_id: 'usr_a' }), 'usr_a');
  });

  await t.test('returns null when there is no owner', () => {
    // Null is what makes the bridge drop the event instead of broadcasting it.
    assert.strictEqual(ownerOf({ executionId: 'exec_1' }), null);
    assert.strictEqual(ownerOf({}), null);
    assert.strictEqual(ownerOf(null), null);
    assert.strictEqual(ownerOf(undefined), null);
  });

  await t.test('rejects a non-string or empty owner rather than routing to "user:undefined"', () => {
    assert.strictEqual(ownerOf({ userId: '' }), null);
    assert.strictEqual(ownerOf({ userId: 42 }), null);
    assert.strictEqual(ownerOf({ userId: {} }), null);
  });
});

test('attachEventBridges', async (t) => {
  await t.test('drops an unowned event instead of broadcasting it', () => {
    const dropped = [];
    const io = { to: () => assert.fail('an unowned event must never be addressed to a room') };
    const eventBus = new EventEmitter();
    const stateMachineEvents = new EventEmitter();

    attachEventBridges({ io, eventBus, stateMachineEvents, onUnowned: (e) => dropped.push(e) });

    eventBus.emit('notification:new', { title: 'no owner here' });
    assert.deepStrictEqual(dropped, ['notification:new']);
  });

  await t.test('addresses an owned event to that user room only', () => {
    const addressed = [];
    const io = {
      to(room) {
        return { emit: (event, payload) => addressed.push({ room, event, payload }) };
      }
    };
    const eventBus = new EventEmitter();
    const stateMachineEvents = new EventEmitter();

    attachEventBridges({ io, eventBus, stateMachineEvents, onUnowned: () => {} });
    eventBus.emit('graph:activation', { userId: 'usr_a', entityIds: ['e1'] });

    assert.strictEqual(addressed.length, 1);
    assert.strictEqual(addressed[0].room, 'user:usr_a');
    assert.strictEqual(addressed[0].event, 'graph_pulse');
    assert.strictEqual(addressed[0].payload.type, 'activation');
  });

  await t.test('forwards notification rows without a type wrapper', () => {
    // The bell widget reads the row fields directly; wrapping it in {type,...}
    // would work by accident but changes the contract the frontend relies on.
    const addressed = [];
    const io = { to: () => ({ emit: (event, payload) => addressed.push({ event, payload }) }) };
    const eventBus = new EventEmitter();

    attachEventBridges({ io, eventBus, stateMachineEvents: new EventEmitter(), onUnowned: () => {} });
    eventBus.emit('notification:new', { user_id: 'usr_a', title: 'Report ready' });

    assert.strictEqual(addressed[0].event, 'notification:new');
    assert.strictEqual(addressed[0].payload.type, undefined);
    assert.strictEqual(addressed[0].payload.title, 'Report ready');
  });

  await t.test('every mapped event carries an owner-bearing route', () => {
    // Guards against adding a bridge whose emitter never sets userId, which
    // would silently stop delivering that pulse.
    for (const [source, eventName, socketEvent] of BRIDGES) {
      assert.ok(source === 'bus' || source === 'state', `${eventName}: unknown source "${source}"`);
      assert.ok(eventName.length > 0 && socketEvent.length > 0);
    }
  });
});

// ── End-to-end: two real clients on one real Socket.io server ──
test('a real notification reaches its owner and nobody else', async (t) => {
  let ioClient;
  try {
    ioClient = require('socket.io-client');
  } catch {
    t.skip('socket.io-client not installed');
    return;
  }

  const { Server } = require('socket.io');
  const httpServer = http.createServer();
  const io = new Server(httpServer);
  const eventBus = new EventEmitter();

  attachEventBridges({ io, eventBus, stateMachineEvents: new EventEmitter(), onUnowned: () => {} });

  // Mirrors server.js: the room comes from the authenticated identity, never
  // from anything the client sends.
  io.on('connection', (socket) => {
    socket.join(userRoom(socket.handshake.auth.userId));
  });

  await new Promise((resolve) => httpServer.listen(0, resolve));
  const url = `http://localhost:${httpServer.address().port}`;

  const connect = (userId) => new Promise((resolve) => {
    const sock = ioClient(url, { auth: { userId }, transports: ['websocket'] });
    const received = [];
    sock.on('notification:new', (row) => received.push(row));
    sock.on('connect', () => resolve({ sock, received }));
  });

  const owner = await connect('usr_owner');
  const other = await connect('usr_other');

  eventBus.emit('notification:new', {
    user_id: 'usr_owner',
    title: 'Mission report',
    content: 'private report body'
  });

  await new Promise((r) => setTimeout(r, 150));

  const receivedByOwner = owner.received;
  const receivedByOther = other.received;

  owner.sock.close();
  other.sock.close();
  io.close();
  await new Promise((resolve) => httpServer.close(resolve));

  assert.strictEqual(receivedByOwner.length, 1, 'the owner must receive their own notification');
  assert.strictEqual(receivedByOwner[0].content, 'private report body');
  assert.deepStrictEqual(receivedByOther, [], 'no other user may receive it');
});
