// Moose Crossing — real-time multiplayer reaction game
// The server owns the game: rooms, rounds, what appears on the road, and scoring.
// Every player's screen is driven by events from here, so all screens stay in sync.

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.send('ok'));

const PORT = process.env.PORT || 3000;
// SPEED < 1 makes every timer shorter (used by the automated test only).
const SPEED = Number(process.env.SPEED) > 0 ? Number(process.env.SPEED) : 1;
const ms = (n) => Math.round(n * SPEED);

// ---------- Game constants ----------
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;
const ROUND_OPTIONS = [5, 10, 15];
const COLORS = ['#FFC247', '#7FD3FF', '#FF8A3D', '#B9F18C', '#F7A8FF', '#FF7A93', '#A9B8FF', '#5FE3C0'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DECOYS = ['beaver', 'goose', 'hockey'];

const PLACE_POINTS = [100, 60, 30];
const OTHER_POINTS = 10;
const DECOY_PENALTY = 50;
const EARLY_PENALTY = 25;
const REVERSE_PENALTY = 50;
const REVERSE_BONUS = 50;

const GET_READY = 1800;
const MOOSE_WINDOW = 2600;
const DOUBLE_GAP = 1900;
const DECOY_SHOW = 1100;
const RESULTS_PAUSE = 5000;
const MIN_REACTION = 100;

const FORFEITS = [
  'Say "Sorry, eh" in your best Canadian accent, 3 times.',
  'Do your loudest moose call. Right now. Out loud.',
  'Speak only in a Canadian accent until the next game ends.',
  'Walk across the room like a moose. Antlers included.',
  'Let the winner pick your profile picture for 24 hours.',
  'Sing any song like a very sad moose for 10 seconds.',
];

// ---------- Helpers ----------
const rooms = new Map();
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function cleanText(s, max) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}
function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => pick(CODE_CHARS.split(''))).join('');
  } while (rooms.has(code));
  return code;
}
function makePlan(total) {
  // Round 1 is a clean warm-up, the last round is the double-points final,
  // and the middle mixes normal rounds with fog, double moose and reverse rounds.
  const middle = total - 2;
  const specials = ['reverse', 'fog', 'double'];
  const normals = Math.ceil(middle * 0.55);
  const pool = [];
  for (let i = 0; i < middle; i++) pool.push(i < normals ? 'normal' : specials[(i - normals) % 3]);
  shuffle(pool);
  return ['normal', ...pool, 'final'];
}

function schedule(room, delay, fn) {
  const t = setTimeout(() => {
    room.timers = room.timers.filter((x) => x !== t);
    fn();
  }, delay);
  room.timers.push(t);
}
function clearTimers(room) {
  room.timers.forEach(clearTimeout);
  room.timers = [];
}

function connectedPlayers(room) {
  return [...room.players.values()].filter((p) => p.connected);
}
function standings(room) {
  return [...room.players.values()]
    .sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt)
    .map((p) => ({ id: p.id, name: p.name, color: p.color, score: p.score, connected: p.connected }));
}
function publicState(room) {
  return {
    code: room.code,
    state: room.state,
    hostId: room.hostId,
    stake: room.stake,
    totalRounds: room.totalRounds,
    round: room.round,
    players: [...room.players.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({ id: p.id, name: p.name, color: p.color, score: p.score, connected: p.connected })),
  };
}
function broadcastRoom(room) {
  io.to(room.code).emit('room', publicState(room));
}

// ---------- Chat + Constable Moose ----------
function pushChat(room, msg) {
  room.chat.push(msg);
  if (room.chat.length > 60) room.chat.shift();
  io.to(room.code).emit('chat', msg);
}
function botSay(room, text) {
  pushChat(room, { bot: true, name: 'Constable Moose', text, ts: Date.now() });
}

const TWIST_LINES = {
  normal: (n) => pick([`Round ${n}. Eyes on the road, drivers.`, `Round ${n}. Hands on the wheel, eh.`, `Round ${n}. Something's moving in those trees…`]),
  fog: (n) => `Round ${n}: FOG ROLLING IN. You'll barely see it. Squint, bud.`,
  double: (n) => `Round ${n}: DOUBLE MOOSE! Two moose, two brakes. Stay sharp.`,
  reverse: (n) => `Round ${n}: REVERSE ROUND! Do NOT brake. Not even for the moose. Trust me.`,
  final: () => `FINAL ROUND! Double points. Anyone can still win this.`,
};
const DECOY_LINES = {
  beaver: (n) => pick([`${n} braked for a beaver. Minus 50, bud.`, `${n} stopped for a beaver. It's not even a big one.`]),
  goose: (n) => pick([`${n} stopped for a goose. The goose is laughing at you.`, `${n} braked for a goose. Classic.`]),
  hockey: (n) => pick([`${n} braked for a hockey player. He wasn't even on skates.`, `${n} stopped for a hockey player. Wrong rink, eh.`]),
};

// ---------- Rounds ----------
function startGame(room) {
  clearTimers(room);
  room.plan = makePlan(room.totalRounds);
  room.round = 0;
  for (const p of room.players.values()) {
    p.score = 0;
    p.best = null;
    p.roundsWon = 0;
  }
  room.state = 'playing';
  broadcastRoom(room);
  botSay(room, `Engines on! ${room.totalRounds} rounds. Brake for moose only. Lowest score at the end loses${room.stake ? `: ${room.stake}` : ''}.`);
  schedule(room, ms(1500), () => startRound(room));
}

function startRound(room) {
  room.round += 1;
  const twist = room.plan[room.round - 1];
  const decoyCount = room.round === 1 ? 0 : randInt(0, twist === 'reverse' ? 1 : 2);
  const decoys = Array.from({ length: decoyCount }, () => pick(DECOYS));
  const types = twist === 'double'
    ? [...decoys, 'moose', ...(Math.random() < 0.5 ? [pick(DECOYS)] : []), 'moose']
    : [...decoys, 'moose'];

  const r = {
    number: room.round,
    twist,
    types,
    items: [],
    visibleIdx: -1,
    lastSpawned: false,
    maxBrakes: twist === 'double' ? 2 : 1,
    brakes: new Map(),
  };
  room.current = r;
  room.state = 'round';

  io.to(room.code).emit('round_start', {
    round: r.number,
    total: room.totalRounds,
    twist,
    maxBrakes: r.maxBrakes,
  });
  broadcastRoom(room);
  botSay(room, TWIST_LINES[twist](r.number));

  let t = ms(GET_READY + rand(800, 2600));
  types.forEach((type, idx) => {
    schedule(room, t, () => spawn(room, idx, type));
    if (type === 'moose') {
      const isFirstOfTwo = twist === 'double' && idx < types.length - 1;
      t += ms(isFirstOfTwo ? DOUBLE_GAP + rand(0, 700) : MOOSE_WINDOW);
    } else {
      t += ms(DECOY_SHOW + rand(500, 1500));
    }
  });
  schedule(room, t, () => endRound(room));
}

function spawn(room, idx, type) {
  const r = room.current;
  if (!r || room.state !== 'round') return;
  r.visibleIdx = idx;
  r.items[idx] = { type, at: Date.now() };
  if (idx === r.types.length - 1) r.lastSpawned = true;
  io.to(room.code).emit('spawn', { round: r.number, idx, type });
  if (type !== 'moose') {
    schedule(room, ms(DECOY_SHOW), () => {
      if (room.current === r && r.visibleIdx === idx) {
        r.visibleIdx = -1;
        io.to(room.code).emit('clear', { round: r.number, idx });
      }
    });
  }
}

function handleBrake(room, player, data) {
  const r = room.current;
  if (!r || room.state !== 'round' || data?.round !== r.number) return;
  const used = r.brakes.get(player.id) || [];
  if (used.length >= r.maxBrakes) return;

  const idx = Number.isInteger(data.idx) ? data.idx : -1;
  const item = idx >= 0 ? r.items[idx] : null;
  // The client may only brake on what the server has actually put on the road.
  if (idx >= 0 && (!item || used.some((u) => u.idx === idx))) return;

  let result;
  let reaction = null;
  if (!item) {
    result = 'early';
  } else if (item.type !== 'moose') {
    result = 'decoy';
  } else if (r.twist === 'reverse') {
    result = 'reverse';
  } else {
    // Fair timing: the reaction is measured on the player's own device, from the moment
    // the moose appeared on THEIR screen, so a slow connection doesn't decide the winner.
    // It can't be faster than a human or slower than what the server saw.
    const serverElapsed = Date.now() - item.at;
    let claimed = Number(data.reaction);
    if (!Number.isFinite(claimed)) claimed = serverElapsed;
    reaction = Math.round(Math.max(MIN_REACTION, Math.min(claimed, serverElapsed + 50)));
    result = 'moose';
  }

  used.push({ idx, result, reaction, type: item?.type ?? null });
  r.brakes.set(player.id, used);

  const sock = io.sockets.sockets.get(player.socketId);
  if (sock) sock.emit('brake_ack', { round: r.number, idx, result, reaction, type: item?.type ?? null, left: r.maxBrakes - used.length });
  io.to(room.code).emit('player_braked', { round: r.number, playerId: player.id, result });

  if (result === 'decoy') botSay(room, DECOY_LINES[item.type](player.name));
  if (result === 'early') botSay(room, `${player.name} slammed the brakes at nothing. Jumpy! Minus 25.`);
  if (result === 'reverse') botSay(room, `${player.name} braked in the REVERSE round. I said don't, eh! Minus 50.`);

  // Everyone has braked on the final moose? No need to wait — wrap the round up.
  const lastIsVisibleMoose = r.lastSpawned && r.visibleIdx === r.types.length - 1 && r.twist !== 'reverse';
  if (lastIsVisibleMoose) {
    const everyoneDone = connectedPlayers(room).every((p) => (r.brakes.get(p.id) || []).length >= r.maxBrakes);
    if (everyoneDone) {
      clearTimers(room);
      schedule(room, ms(700), () => endRound(room));
    }
  }
}

function endRound(room) {
  const r = room.current;
  if (!r || room.state !== 'round') return;
  room.state = 'results';
  const mult = r.twist === 'final' ? 2 : 1;
  const deltas = new Map();
  const notes = new Map();
  const bestThisRound = new Map();
  const add = (id, n) => deltas.set(id, (deltas.get(id) || 0) + n);
  const note = (id, s) => notes.set(id, [...(notes.get(id) || []), s]);

  // Place points for each moose, by reaction time.
  r.types.forEach((type, idx) => {
    if (type !== 'moose' || r.twist === 'reverse') return;
    const hits = [];
    for (const [pid, list] of r.brakes) {
      const b = list.find((x) => x.idx === idx && x.result === 'moose');
      if (b) hits.push({ pid, reaction: b.reaction });
    }
    hits.sort((a, b) => a.reaction - b.reaction);
    hits.forEach((h, place) => {
      add(h.pid, place < PLACE_POINTS.length ? PLACE_POINTS[place] : OTHER_POINTS);
      const prev = bestThisRound.get(h.pid);
      if (prev == null || h.reaction < prev) bestThisRound.set(h.pid, h.reaction);
    });
  });

  // Penalties.
  for (const [pid, list] of r.brakes) {
    for (const b of list) {
      if (b.result === 'decoy') { add(pid, -DECOY_PENALTY); note(pid, `Braked for a ${b.type === 'hockey' ? 'hockey player' : b.type}`); }
      if (b.result === 'early') { add(pid, -EARLY_PENALTY); note(pid, 'Braked too early'); }
      if (b.result === 'reverse') { add(pid, -REVERSE_PENALTY); note(pid, 'Braked in the reverse round'); }
    }
  }

  // Reverse round: everyone who kept their foot off the brake gets a bonus.
  let calmCount = 0;
  if (r.twist === 'reverse') {
    for (const p of room.players.values()) {
      if (!p.connected) continue;
      if ((r.brakes.get(p.id) || []).length === 0) {
        add(p.id, REVERSE_BONUS);
        note(p.id, 'Kept cool');
        calmCount++;
      }
    }
  }

  const summary = [];
  for (const p of room.players.values()) {
    const delta = (deltas.get(p.id) || 0) * mult;
    p.score += delta;
    const best = bestThisRound.get(p.id) ?? null;
    if (best != null && (p.best == null || best < p.best)) p.best = best;
    summary.push({ id: p.id, name: p.name, color: p.color, delta, reaction: best, notes: notes.get(p.id) || [] });
  }
  summary.sort((a, b) => b.delta - a.delta || (a.reaction ?? 1e9) - (b.reaction ?? 1e9));

  let headline;
  const winner = summary.find((s) => s.reaction != null);
  if (r.twist === 'reverse') {
    headline = calmCount > 0 ? `${calmCount} driver${calmCount === 1 ? '' : 's'} kept cool` : 'Everyone braked. Oops.';
    botSay(room, calmCount > 0 ? `Reverse round done. ${calmCount} cool head${calmCount === 1 ? '' : 's'} get +${REVERSE_BONUS * mult}.` : 'Every single one of you braked. Unbelievable, eh.');
  } else if (winner) {
    room.players.get(winner.id).roundsWon += 1;
    headline = `${winner.name} — ${winner.reaction} ms`;
    botSay(room, pick([`${winner.name} wins the round in ${winner.reaction} ms!`, `${winner.reaction} ms! ${winner.name} has the fastest foot on the highway.`]));
  } else {
    headline = 'Nobody caught the moose';
    botSay(room, "Nobody caught that moose. It's still out there somewhere.");
  }

  const hasNext = room.round < room.totalRounds;
  io.to(room.code).emit('round_end', {
    round: r.number,
    twist: r.twist,
    headline,
    summary,
    standings: standings(room),
    next: hasNext,
    pauseMs: ms(RESULTS_PAUSE),
  });
  broadcastRoom(room);
  schedule(room, ms(RESULTS_PAUSE), () => (hasNext ? startRound(room) : finishGame(room)));
}

function finishGame(room) {
  room.state = 'final';
  room.current = null;
  const st = standings(room);
  const winner = st[0];
  const w = room.players.get(winner.id);
  const forfeit = pick(FORFEITS);

  // THE LOSER RULE: the lowest total score after the final round loses.
  // The loser pays the stake (default: buys Timmies for everyone) and does the forfeit.
  // Players tied for lowest are all losers and split the stake.
  // If everyone finishes on the same score, it's a dead heat and nobody pays.
  const low = st[st.length - 1].score;
  const losers = st.length > 1 && st[0].score !== low ? st.filter((p) => p.score === low) : [];

  io.to(room.code).emit('game_over', {
    standings: st,
    winner: { ...winner, best: w.best, roundsWon: w.roundsWon },
    losers,
    loser: losers[0] || null,
    stake: room.stake,
    forfeit,
  });
  broadcastRoom(room);

  botSay(room, `${winner.name} is the Moose Master!`);
  if (losers.length === 0) {
    botSay(room, 'Dead heat at the bottom, eh. Nobody pays this time.');
  } else {
    const names = losers.map((p) => p.name).join(' and ');
    const pays = room.stake ? `"${room.stake}"` : 'the forfeit';
    botSay(room, losers.length === 1
      ? `${names} finished last with ${low} points. You lose, bud. Pay up: ${pays}.`
      : `${names} tied for last with ${low} points. You both lose. Split it: ${pays}.`);
  }
}

// ---------- Sockets ----------
function joinRoom(socket, room, playerId, name) {
  let player = room.players.get(playerId);
  const rejoin = !!player;
  if (!player) {
    if (room.players.size >= MAX_PLAYERS) return { error: 'This room is full (8 players max).' };
    const taken = new Set([...room.players.values()].map((p) => p.name.toLowerCase()));
    let finalName = name;
    for (let n = 2; taken.has(finalName.toLowerCase()); n++) finalName = `${name.slice(0, 13)} ${n}`;
    const usedColors = new Set([...room.players.values()].map((p) => p.color));
    player = {
      id: playerId,
      name: finalName,
      color: COLORS.find((c) => !usedColors.has(c)) || pick(COLORS),
      score: 0,
      best: null,
      roundsWon: 0,
      joinedAt: Date.now(),
    };
    room.players.set(playerId, player);
  }
  player.socketId = socket.id;
  player.connected = true;
  if (!room.hostId || !room.players.get(room.hostId)?.connected) room.hostId = player.id;
  clearTimeout(room.cleanup);

  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;

  broadcastRoom(room);
  socket.emit('chat_history', room.chat);
  if (rejoin) botSay(room, `${player.name} is back on the road. Welcome back, bud.`);
  else botSay(room, pick([`${player.name} just merged onto the highway. Welcome, eh!`, `${player.name} is here. Buckle up.`, `${player.name} joined. Watch out for moose.`]));

  // Catch a (re)joining player up with a round already in progress.
  if (room.state === 'round' && room.current) {
    const r = room.current;
    const used = (r.brakes.get(player.id) || []).length;
    socket.emit('round_start', { round: r.number, total: room.totalRounds, twist: r.twist, maxBrakes: r.maxBrakes, used });
    if (r.visibleIdx >= 0) socket.emit('spawn', { round: r.number, idx: r.visibleIdx, type: r.items[r.visibleIdx].type });
  }
  return { ok: true, code: room.code, playerId: player.id };
}

io.on('connection', (socket) => {
  const getCtx = () => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.data.playerId);
    return room && player ? { room, player } : null;
  };

  socket.on('create_room', (data, ack = () => {}) => {
    const name = cleanText(data?.name, 16);
    const playerId = cleanText(data?.playerId, 40);
    if (!name) return ack({ error: 'Type your name first.' });
    if (!playerId) return ack({ error: 'Something went wrong. Refresh and try again.' });
    const code = newCode();
    const room = {
      code,
      hostId: null,
      stake: 'Loser buys Timmies for everyone',
      totalRounds: 10,
      state: 'lobby',
      round: 0,
      plan: [],
      current: null,
      players: new Map(),
      chat: [],
      timers: [],
      cleanup: null,
    };
    rooms.set(code, room);
    ack(joinRoom(socket, room, playerId, name));
  });

  socket.on('join_room', (data, ack = () => {}) => {
    const code = cleanText(data?.code, 4).toUpperCase();
    const name = cleanText(data?.name, 16);
    const playerId = cleanText(data?.playerId, 40);
    const room = rooms.get(code);
    if (!room) return ack({ error: `No room called ${code || '____'}. Check the code.` });
    if (!name) return ack({ error: 'Type your name first.' });
    if (!playerId) return ack({ error: 'Something went wrong. Refresh and try again.' });
    ack(joinRoom(socket, room, playerId, name));
  });

  socket.on('settings', (data) => {
    const ctx = getCtx();
    if (!ctx || ctx.room.hostId !== ctx.player.id || ctx.room.state === 'round' || ctx.room.state === 'results') return;
    if (typeof data?.stake === 'string') ctx.room.stake = cleanText(data.stake, 60);
    if (ROUND_OPTIONS.includes(Number(data?.rounds))) ctx.room.totalRounds = Number(data.rounds);
    broadcastRoom(ctx.room);
  });

  socket.on('start_game', (_d, ack = () => {}) => {
    const ctx = getCtx();
    if (!ctx) return ack({ error: 'You are not in a room.' });
    const { room, player } = ctx;
    if (room.hostId !== player.id) return ack({ error: 'Only the host can start.' });
    if (room.state === 'playing' || room.state === 'round' || room.state === 'results') return ack({ error: 'Game already running.' });
    if (connectedPlayers(room).length < MIN_PLAYERS) return ack({ error: `Need at least ${MIN_PLAYERS} players to start.` });
    startGame(room);
    ack({ ok: true });
  });

  socket.on('brake', (data) => {
    const ctx = getCtx();
    if (ctx) handleBrake(ctx.room, ctx.player, data);
  });

  socket.on('chat', (data) => {
    const ctx = getCtx();
    if (!ctx) return;
    const text = cleanText(data?.text, 140);
    if (!text) return;
    const now = Date.now();
    if (ctx.player.lastChat && now - ctx.player.lastChat < 600) return;
    ctx.player.lastChat = now;
    pushChat(ctx.room, { bot: false, id: ctx.player.id, name: ctx.player.name, color: ctx.player.color, text, ts: now });
  });

  socket.on('back_to_lobby', () => {
    const ctx = getCtx();
    if (!ctx || ctx.room.hostId !== ctx.player.id || ctx.room.state !== 'final') return;
    ctx.room.state = 'lobby';
    ctx.room.round = 0;
    for (const p of ctx.room.players.values()) p.score = 0;
    broadcastRoom(ctx.room);
    botSay(ctx.room, 'Back in the lobby. Rematch time?');
  });

  socket.on('disconnect', () => {
    const ctx = getCtx();
    if (!ctx) return;
    const { room, player } = ctx;
    if (player.socketId !== socket.id) return; // already reconnected on a newer socket
    player.connected = false;
    if (room.hostId === player.id) {
      const next = connectedPlayers(room)[0];
      if (next) room.hostId = next.id;
    }
    broadcastRoom(room);
    botSay(room, `${player.name} lost signal in a snowbank. They can rejoin with code ${room.code}.`);
    if (connectedPlayers(room).length === 0) {
      room.cleanup = setTimeout(() => {
        clearTimers(room);
        rooms.delete(room.code);
      }, 10 * 60 * 1000);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Moose Crossing running on http://localhost:${PORT}`);
});
