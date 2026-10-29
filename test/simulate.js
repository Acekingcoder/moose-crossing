// Automated playtest: starts the server at 4x speed and plays a full 5-round game with 3 bots.
//   Ace  — perfect driver (moose only, 200 ms)
//   Ben  — good driver (moose only, 350 ms), drops connection mid-game and rejoins
//   Cee  — panicky driver (260 ms, brakes at everything, including in the reverse round)
// Run with: npm test
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3999;
const URL = `http://localhost:${PORT}`;
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1; };

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), SPEED: '0.25' },
  stdio: ['ignore', 'pipe', 'inherit'],
});

function makeBot(name, opts) {
  const bot = { name, id: `${name.toLowerCase()}-id`, socket: null, round: null, log: [], acks: [], gameOver: null, roomState: null, chats: [] };
  bot.connect = () => {
    bot.socket = io(URL, { forceNew: true, transports: ['websocket'] });
    const s = bot.socket;
    s.on('room', (r) => { bot.roomState = r; });
    s.on('chat', (m) => bot.chats.push(m));
    s.on('round_start', (d) => { bot.round = d; bot.log.push(`R${d.round}:${d.twist}`); });
    s.on('spawn', (d) => {
      const twist = bot.round?.twist;
      const shouldBrake = opts.panicky || (d.type === 'moose' && twist !== 'reverse');
      if (!shouldBrake) return;
      setTimeout(() => s.emit('brake', { round: d.round, idx: d.idx, reaction: opts.reaction }), opts.reaction);
    });
    s.on('brake_ack', (d) => bot.acks.push(d));
    s.on('game_over', (d) => { bot.gameOver = d; });
    return new Promise((res) => s.on('connect', res));
  };
  return bot;
}
const emitAck = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));

(async () => {
  await sleep(800);
  const ace = makeBot('Ace', { reaction: 200 });
  const ben = makeBot('Ben', { reaction: 350 });
  const cee = makeBot('Cee', { reaction: 260, panicky: true });
  await Promise.all([ace.connect(), ben.connect(), cee.connect()]);

  // Create + join
  const created = await emitAck(ace.socket, 'create_room', { name: 'Ace', playerId: ace.id });
  if (!created.ok || !/^[A-Z]{4}$/.test(created.code)) return fail(`create_room: ${JSON.stringify(created)}`);
  const code = created.code;
  console.log('Room created:', code);

  const bad = await emitAck(ben.socket, 'join_room', { name: 'Ben', code: 'ZZZZ', playerId: ben.id });
  if (!bad.error) fail('joining a missing room should fail');

  const tooFew = await emitAck(ace.socket, 'start_game', {});
  if (!tooFew.error) fail('starting with 1 player should fail');

  await emitAck(ben.socket, 'join_room', { name: 'Ben', code, playerId: ben.id });
  await emitAck(cee.socket, 'join_room', { name: 'Cee', code, playerId: cee.id });

  // Non-host cannot start or change settings
  const notHost = await emitAck(ben.socket, 'start_game', {});
  if (!notHost.error) fail('non-host should not be able to start');

  ace.socket.emit('settings', { rounds: 5, stake: 'Loser buys Timmies' });
  ben.socket.emit('settings', { rounds: 15 });
  ben.socket.emit('chat', { text: 'Timmies are on Cee tonight' });
  await sleep(300);
  if (ace.roomState.totalRounds !== 5) fail(`rounds should be 5, got ${ace.roomState.totalRounds}`);
  if (ace.roomState.stake !== 'Loser buys Timmies') fail('stake not set');
  if (!ace.chats.some((m) => m.text === 'Timmies are on Cee tonight')) fail('chat did not reach other players');
  if (ace.roomState.players.length !== 3) fail('expected 3 players');

  // Start
  const started = await emitAck(ace.socket, 'start_game', {});
  if (!started.ok) return fail(`start_game: ${JSON.stringify(started)}`);
  console.log('Game started');

  // Mid-game: Ben drops and comes back with the same id
  await sleep(4000);
  const benScoreBefore = ace.roomState.players.find((p) => p.name === 'Ben').score;
  ben.socket.disconnect();
  await sleep(500);
  const benAway = ace.roomState.players.find((p) => p.name === 'Ben');
  if (benAway.connected) fail('Ben should show as disconnected');
  await ben.connect();
  const rej = await emitAck(ben.socket, 'join_room', { name: 'Ben', code, playerId: ben.id });
  if (!rej.ok) fail('Ben could not rejoin');
  await sleep(300);
  const benBack = ace.roomState.players.find((p) => p.name === 'Ben');
  if (!benBack.connected) fail('Ben should be connected again');
  if (benBack.score < benScoreBefore) fail('Ben lost score on rejoin');
  if (ace.roomState.players.length !== 3) fail('rejoin should not create a duplicate player');
  console.log(`Ben rejoined with score ${benBack.score}`);

  // Wait for the game to end
  const deadline = Date.now() + 60000;
  while (!(ace.gameOver && cee.gameOver) && Date.now() < deadline) await sleep(200);
  if (!ace.gameOver) return fail('game never finished');

  const go = ace.gameOver;
  console.log('Rounds Ace saw:', ace.log.join(' '));
  console.log('Final standings:', go.standings.map((p) => `${p.name}=${p.score}`).join(', '));
  console.log('Winner:', go.winner.name, 'best', go.winner.best, 'ms', '| loser:', go.loser?.name, '| forfeit:', go.forfeit);

  const twists = ace.log.map((x) => x.split(':')[1]);
  if (twists.length !== 5) fail(`expected 5 rounds, saw ${twists.length}`);
  if (twists[0] !== 'normal' || twists[4] !== 'final') fail('round 1 should be normal and round 5 final');
  if (!twists.includes('reverse')) fail('5-round plan should include a reverse round');
  if (go.winner.name !== 'Ace') fail('the perfect driver should win');
  if (!cee.acks.some((a) => a.result === 'decoy' || a.result === 'reverse')) fail('Cee should have been penalised at least once');
  if (ace.acks.some((a) => a.result !== 'moose')) fail('Ace should only ever hit moose');
  if (!Array.isArray(go.losers) || go.losers[0]?.name !== go.standings[go.standings.length - 1].name) fail('losers should be the lowest score');
  if (go.losers.some((l) => l.score !== go.standings[go.standings.length - 1].score)) fail('every loser must have the lowest score');
  if (!ace.chats.some((m) => m.bot && /Pay up|Split it|Nobody pays/.test(m.text))) fail('Constable Moose should announce the loser outcome');
  const sorted = [...go.standings].every((p, i, arr) => i === 0 || arr[i - 1].score >= p.score);
  if (!sorted) fail('standings not sorted');
  // All players saw identical standings
  const same = JSON.stringify(cee.gameOver.standings) === JSON.stringify(go.standings);
  if (!same) fail('players saw different final standings');

  // Early brake while nothing is on the road (new game)
  ace.socket.emit('back_to_lobby');
  await sleep(200);
  if (ace.roomState.state !== 'lobby') fail('back_to_lobby did not return to lobby');
  if (ace.roomState.players.some((p) => p.score !== 0)) fail('scores should reset for a rematch');

  console.log(process.exitCode ? 'Some checks FAILED' : 'All checks passed');
  [ace, ben, cee].forEach((b) => b.socket.disconnect());
  server.kill();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); server.kill(); process.exit(1); });
