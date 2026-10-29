/* Moose Crossing — player client.
   The server decides everything; this file just draws what the server says
   and sends back the player's brakes, chat and lobby choices. */
(() => {
  'use strict';

  // ---------- Small helpers ----------
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const session = {
    get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch { /* storage blocked */ } },
  };
  const local = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  };
  const makeId = () => (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

  // One identity per browser tab, kept across reloads so a player can rejoin and keep their score.
  let myId = session.get('mc_pid');
  if (!myId) { myId = makeId(); session.set('mc_pid', myId); }
  let mySeat = session.get('mc_seat'); // { code, name }

  const BOT_AVATAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4v4h4M18 4v4h-4M9 10h6v6a3 3 0 0 1-6 0z"/></svg>';
  const TYPE_NAMES = { moose: 'A moose!', beaver: 'A beaver', goose: 'A goose', hockey: 'A hockey player' };
  const DECOY_MSG = { beaver: "THAT'S A BEAVER!", goose: "THAT'S A GOOSE!", hockey: 'HOCKEY PLAYER!' };
  const TWISTS = {
    normal: { badge: (n) => `ROUND ${n}`, hint: 'Watch the road… brake for the MOOSE only.' },
    fog: { badge: () => 'FOG', hint: 'Fog round. Look closely before you brake.' },
    double: { badge: () => 'DOUBLE MOOSE', hint: 'Two moose this round. You get two brakes.' },
    reverse: { badge: () => "REVERSE · DON'T BRAKE", hint: 'Do NOT brake this round. Not even for the moose.' },
    final: { badge: () => 'FINAL · 2× POINTS', hint: 'Final round. Everything counts double.' },
  };

  // ---------- State ----------
  const socket = io({ reconnectionDelayMax: 3000 });
  let room = null;
  let roundState = null;   // { number, twist, maxBrakes, used, visible }
  let brakeMarks = {};      // playerId -> result, for the current round
  let lastGameOver = null;
  let stakeTimer = null;

  // ---------- Sound + vibration ----------
  let audio = null;
  function unlockAudio() {
    if (audio) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) audio = new Ctx();
    } catch { audio = null; }
  }
  function tone(freq, dur, type = 'sine', vol = 0.15, delay = 0) {
    if (!audio) return;
    const t = audio.currentTime + delay;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  function screech() {
    if (!audio) return;
    const len = Math.floor(audio.sampleRate * 0.35);
    const buf = audio.createBuffer(1, len, audio.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = audio.createBufferSource();
    src.buffer = buf;
    const f = audio.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 2600;
    f.Q.value = 6;
    const g = audio.createGain();
    g.gain.value = 0.35;
    src.connect(f).connect(g).connect(audio.destination);
    src.start();
  }
  const sounds = {
    spawn: () => tone(420, 0.08, 'triangle', 0.08),
    good: () => { tone(880, 0.12, 'sine', 0.15); tone(1320, 0.18, 'sine', 0.15, 0.1); },
    bad: () => { tone(130, 0.35, 'square', 0.12); tone(110, 0.35, 'square', 0.1, 0.05); },
    fanfare: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.25, 'triangle', 0.14, i * 0.14)),
  };
  const buzz = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch { /* not supported */ } };

  // ---------- Toast ----------
  let toastTimer = null;
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ---------- Screens ----------
  function showScreen(name) {
    $('screen-join').classList.toggle('active', name === 'join');
    $('screen-room').classList.toggle('active', name === 'room');
  }
  function showView(name) {
    $('view-lobby').hidden = name !== 'lobby';
    $('view-game').hidden = name !== 'game';
    $('view-final').hidden = name !== 'final';
  }
  function avatar(p, extra = '') {
    const a = el('div', `avatar ${extra}`.trim(), (p.name || '?').charAt(0).toUpperCase());
    a.style.background = p.color;
    a.setAttribute('aria-hidden', 'true');
    return a;
  }
  const isHost = () => room && room.hostId === myId;
  const inviteLink = () => `${location.origin}${location.pathname}?room=${room ? room.code : ''}`;

  // ---------- Join screen ----------
  const params = new URLSearchParams(location.search);
  if (params.get('room')) $('code-input').value = params.get('room').toUpperCase().slice(0, 4);
  $('name-input').value = local.get('mc_name') || '';
  $('code-input').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  });

  function readName() {
    const name = $('name-input').value.trim();
    if (!name) {
      $('join-error').textContent = 'Type your name first.';
      $('name-input').focus();
      return null;
    }
    local.set('mc_name', name);
    return name;
  }
  function afterJoin(res, name) {
    if (!res || res.error) {
      $('join-error').textContent = res ? res.error : 'Could not reach the game. Try again.';
      return;
    }
    $('join-error').textContent = '';
    mySeat = { code: res.code, name };
    session.set('mc_seat', mySeat);
    history.replaceState(null, '', `?room=${res.code}`);
    showScreen('room');
  }
  $('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    unlockAudio();
    const name = readName();
    if (!name) return;
    const code = $('code-input').value.trim();
    if (code.length !== 4) {
      $('join-error').textContent = 'Room codes have 4 letters. Or create a new room.';
      $('code-input').focus();
      return;
    }
    socket.emit('join_room', { code, name, playerId: myId }, (res) => afterJoin(res, name));
  });
  $('create-btn').addEventListener('click', () => {
    unlockAudio();
    const name = readName();
    if (!name) return;
    socket.emit('create_room', { name, playerId: myId }, (res) => afterJoin(res, name));
  });

  // ---------- Connection ----------
  socket.on('connect', () => {
    $('conn').hidden = true;
    if (mySeat) {
      socket.emit('join_room', { code: mySeat.code, name: mySeat.name, playerId: myId }, (res) => {
        if (!res || res.error) {
          session.del('mc_seat');
          mySeat = null;
          showScreen('join');
          $('join-error').textContent = 'That room has closed. Start a new one!';
        } else {
          showScreen('room');
        }
      });
    }
  });
  socket.on('disconnect', () => { if (mySeat) $('conn').hidden = false; });

  // ---------- Room state ----------
  socket.on('room', (data) => {
    room = data;
    renderTopbar();
    renderStandings();
    if (room.state === 'lobby') {
      lastGameOver = null;
      roundState = null;
      showView('lobby');
      renderLobby();
    } else if (room.state === 'final') {
      showView('final');
      renderFinal();
    } else {
      showView('game');
      if (room.state === 'playing' && !roundState) prepGetReady();
    }
  });

  function renderTopbar() {
    $('code-chip-text').textContent = room.code;
    $('stake-chip').textContent = room.stake ? `Stake: ${room.stake}` : '';
    const playing = ['playing', 'round', 'results'].includes(room.state);
    $('round-chip').hidden = !playing || room.round < 1;
    $('round-chip').textContent = `ROUND ${room.round} / ${room.totalRounds}`;
  }

  function renderLobby() {
    $('lobby-code').textContent = room.code;
    const host = isHost();
    const stakeInput = $('stake-input');
    stakeInput.hidden = !host;
    $('stake-text').hidden = host;
    $('stake-text').textContent = room.stake || 'No stake set — just bragging rights.';
    if (host && document.activeElement !== stakeInput) stakeInput.value = room.stake || '';

    const grid = $('lobby-grid');
    grid.replaceChildren();
    room.players.forEach((p) => {
      const cell = el('div', 'lobby-player');
      cell.append(avatar(p, `${p.id === myId ? 'me' : ''} ${p.connected ? '' : 'off'}`));
      cell.append(el('span', 'name', p.name));
      const role = p.id === room.hostId ? 'host' : (p.connected ? 'ready' : 'away');
      cell.append(el('span', 'tag', p.id === myId ? `${role} · you` : role));
      grid.append(cell);
    });
    for (let i = room.players.length; i < Math.max(4, room.players.length); i++) {
      const cell = el('div', 'lobby-player');
      const a = el('div', 'avatar empty', '+');
      a.setAttribute('aria-hidden', 'true');
      cell.append(a, el('span', 'tag', 'open seat'));
      grid.append(cell);
    }
    const connected = room.players.filter((p) => p.connected).length;
    $('player-count').textContent = `${connected} / 8 joined`;

    $('host-controls').hidden = !host;
    $('wait-host').hidden = host;
    document.querySelectorAll('.seg button').forEach((b) => {
      b.setAttribute('aria-pressed', String(Number(b.dataset.rounds) === room.totalRounds));
    });
    $('start-btn').textContent = connected < 2 ? 'WAITING FOR DRIVERS' : 'START ENGINES';
    $('start-btn').disabled = connected < 2;
  }

  function renderStandings() {
    const list = $('standings');
    list.replaceChildren();
    const sorted = [...room.players].sort((a, b) => b.score - a.score);
    sorted.forEach((p, i) => {
      const li = el('li', p.id === myId ? 'me' : '');
      li.append(el('span', 'pos', String(i + 1)));
      li.append(avatar(p, p.connected ? '' : 'off'));
      const nm = el('span', 'nm', p.name);
      if (p.id === myId) nm.append(el('small', '', ' (you)'));
      if (!p.connected) nm.append(el('small', '', ' · away'));
      li.append(nm);
      const mark = brakeMarks[p.id];
      const dot = el('span', `brake-dot ${mark === 'moose' ? 'moose' : mark ? 'bad' : ''}`);
      if (mark) dot.setAttribute('title', mark === 'moose' ? 'Braked for the moose' : 'Bad brake');
      li.append(dot);
      li.append(el('span', `sc ${p.score < 0 ? 'neg' : ''}`, String(p.score)));
      list.append(li);
    });
  }

  // Lobby controls
  $('stake-input').addEventListener('input', (e) => {
    clearTimeout(stakeTimer);
    const stake = e.target.value;
    stakeTimer = setTimeout(() => socket.emit('settings', { stake }), 350);
  });
  document.querySelectorAll('.seg button').forEach((b) => {
    b.addEventListener('click', () => socket.emit('settings', { rounds: Number(b.dataset.rounds) }));
  });
  $('start-btn').addEventListener('click', () => {
    unlockAudio();
    socket.emit('start_game', {}, (res) => {
      $('start-error').textContent = res && res.error ? res.error : '';
    });
  });
  async function copyLink() {
    const link = inviteLink();
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied');
    } catch {
      const t = el('textarea');
      t.value = link;
      document.body.append(t);
      t.select();
      try { document.execCommand('copy'); toast('Invite link copied'); } catch { toast(link); }
      t.remove();
    }
  }
  $('copy-btn').addEventListener('click', copyLink);
  $('code-chip').addEventListener('click', copyLink);
  if (navigator.share) {
    $('share-btn').hidden = false;
    $('share-btn').addEventListener('click', () => {
      navigator.share({
        title: 'Moose Crossing',
        text: `Join my Moose Crossing game! Room code ${room ? room.code : ''}`,
        url: inviteLink(),
      }).catch(() => {});
    });
  }

  // ---------- Game ----------
  const road = $('road');
  const creature = $('creature');
  const brakeBtn = $('brake-btn');
  const roadMsgTimer = { t: null };

  function roadMsg(text, kind = '', hold = 900) {
    const m = $('road-msg');
    m.textContent = text;
    m.className = `road-msg ${kind}`;
    clearTimeout(roadMsgTimer.t);
    if (hold) roadMsgTimer.t = setTimeout(() => { m.textContent = ''; }, hold);
  }
  function clearCreature() {
    creature.replaceChildren();
    creature.className = 'creature';
    road.classList.remove('alert');
    brakeBtn.classList.remove('live');
    if (roundState) roundState.visible = null;
  }
  function setBrakeEnabled(on) {
    brakeBtn.disabled = !on;
    if (on) brakeBtn.textContent = 'BRAKE';
  }
  function showPlayArea(on) {
    brakeBtn.hidden = !on;
    $('hint').hidden = !on;
    document.querySelector('.kbd-hint').hidden = !on;
    $('round-results').hidden = on;
  }
  function prepGetReady() {
    clearCreature();
    showPlayArea(true);
    setBrakeEnabled(false);
    $('twist-badge').textContent = 'GET READY';
    $('twist-badge').className = 'twist-badge';
    $('readout').textContent = '';
    $('hint').textContent = 'Engines on. First round starts in a moment…';
    roadMsg('GET READY', '', 0);
  }

  socket.on('round_start', (d) => {
    roundState = { number: d.round, twist: d.twist, maxBrakes: d.maxBrakes, used: d.used || 0, visible: null };
    brakeMarks = {};
    if (room) renderStandings();
    // An empty, focused chat box would swallow the spacebar — hand focus back to the game.
    const ci = $('chat-input');
    if (document.activeElement === ci && !ci.value.trim()) ci.blur();
    showView('game');
    showPlayArea(true);
    clearCreature();
    road.classList.remove('hit', 'miss', 'stopped', 'shake');
    $('fog').classList.toggle('on', d.twist === 'fog');
    const tw = TWISTS[d.twist] || TWISTS.normal;
    $('twist-badge').textContent = tw.badge(d.round);
    $('twist-badge').className = `twist-badge ${d.twist}`;
    $('hint').textContent = tw.hint;
    $('readout').textContent = '';
    $('readout').className = 'readout';
    setBrakeEnabled(roundState.used < roundState.maxBrakes);
    roadMsg(d.twist === 'normal' ? `ROUND ${d.round}` : tw.badge(d.round), '', 1300);
  });

  socket.on('spawn', (d) => {
    if (!roundState || d.round !== roundState.number) return;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 200 160');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', TYPE_NAMES[d.type] || 'Something');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#${d.type}-full`);
    svg.append(use);
    creature.replaceChildren(svg);
    creature.className = 'creature walk';
    road.classList.add('alert');
    $('road-msg').textContent = '';
    if (roundState.used < roundState.maxBrakes) brakeBtn.classList.add('live');
    sounds.spawn();
    // Reaction time starts from when it is actually drawn on THIS screen.
    const visible = { idx: d.idx, type: d.type, t0: performance.now() };
    roundState.visible = visible;
    requestAnimationFrame(() => { visible.t0 = performance.now(); });
  });

  socket.on('clear', (d) => {
    if (!roundState || d.round !== roundState.number) return;
    if (roundState.visible && roundState.visible.idx === d.idx) clearCreature();
  });

  function brake() {
    if (!roundState || roundState.used >= roundState.maxBrakes || brakeBtn.hidden) return;
    const v = roundState.visible;
    const reaction = v ? Math.round(performance.now() - v.t0) : null;
    socket.emit('brake', { round: roundState.number, idx: v ? v.idx : -1, reaction });
    roundState.used += 1;
    screech();
    buzz(60);
    brakeBtn.classList.add('pressed');
    setTimeout(() => brakeBtn.classList.remove('pressed'), 140);
    road.classList.add('stopped');
    if (v) $('readout').textContent = `${reaction} ms`;
    if (roundState.used >= roundState.maxBrakes) {
      setBrakeEnabled(false);
      brakeBtn.textContent = 'BRAKED';
      brakeBtn.classList.remove('live');
    }
  }
  brakeBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); unlockAudio(); brake(); });
  brakeBtn.addEventListener('click', (e) => { if (e.detail === 0) brake(); }); // keyboard activation
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || $('view-game').hidden || !$('screen-room').classList.contains('active')) return;
    e.preventDefault();
    unlockAudio();
    brake();
  });

  socket.on('brake_ack', (d) => {
    if (!roundState || d.round !== roundState.number) return;
    const ro = $('readout');
    if (d.result === 'moose') {
      ro.textContent = `${d.reaction} ms`;
      ro.className = 'readout';
      road.classList.add('hit');
      roadMsg(d.reaction < 300 ? 'LIGHTNING!' : 'NICE BRAKE!', 'good');
      sounds.good();
    } else {
      ro.className = 'readout bad';
      road.classList.add('miss', 'shake');
      setTimeout(() => road.classList.remove('shake'), 400);
      buzz([90, 50, 90]);
      sounds.bad();
      if (d.result === 'decoy') {
        const type = d.type || 'beaver';
        ro.textContent = '−50';
        roadMsg(DECOY_MSG[type] || 'NOT A MOOSE!', 'bad', 1200);
      } else if (d.result === 'early') {
        ro.textContent = '−25';
        roadMsg('TOO EARLY!', 'bad', 1200);
      } else if (d.result === 'reverse') {
        ro.textContent = '−50';
        roadMsg("DON'T BRAKE!", 'bad', 1200);
      }
    }
    if (d.left > 0) {
      setTimeout(() => {
        road.classList.remove('hit', 'miss', 'stopped');
        if (roundState) setBrakeEnabled(true);
        if (roundState && roundState.visible) brakeBtn.classList.add('live');
      }, 250);
    }
  });

  socket.on('player_braked', (d) => {
    if (!roundState || d.round !== roundState.number) return;
    brakeMarks[d.playerId] = d.result;
    if (room) renderStandings();
  });

  let countdownTimer = null;
  socket.on('round_end', (d) => {
    if (roundState) roundState.visible = null;
    setBrakeEnabled(false);
    brakeBtn.classList.remove('live');
    road.classList.add('stopped');
    road.classList.remove('alert');
    setTimeout(() => { if (!roundState || roundState.number === d.round) clearCreature(); }, 600);

    showPlayArea(false);
    $('rr-title').textContent = `Round ${d.round} result`;
    $('rr-headline').textContent = d.headline;
    const list = $('rr-list');
    list.replaceChildren();
    d.summary.forEach((s) => {
      const li = el('li');
      li.append(avatar(s));
      const n = el('span', 'n');
      n.append(el('strong', '', s.id === myId ? `${s.name} (you)` : s.name));
      if (s.notes.length) n.append(el('small', '', s.notes.join(' · ')));
      li.append(n);
      li.append(el('span', 't', s.reaction != null ? `${s.reaction} ms` : '—'));
      const dcls = s.delta > 0 ? 'pos' : s.delta < 0 ? 'neg' : 'zero';
      li.append(el('span', `d ${dcls}`, s.delta > 0 ? `+${s.delta}` : s.delta < 0 ? `−${Math.abs(s.delta)}` : '0'));
      list.append(li);
    });
    clearInterval(countdownTimer);
    let left = Math.round(d.pauseMs / 1000);
    const nextText = () => (d.next ? `Next round in ${left}s` : `Winner in ${left}s`);
    $('rr-next').textContent = nextText();
    countdownTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) { clearInterval(countdownTimer); return; }
      $('rr-next').textContent = nextText();
    }, 1000);
  });

  // ---------- Final ----------
  socket.on('game_over', (d) => {
    lastGameOver = d;
    roundState = null;
    brakeMarks = {};
    if (room) renderStandings();
    clearInterval(countdownTimer);
    showView('final');
    renderFinal();
    sounds.fanfare();
    buzz([80, 60, 80, 60, 200]);
    confetti();
  });

  function renderFinal() {
    const host = isHost();
    $('rematch-btn').hidden = !host;
    $('final-wait').hidden = host;
    const st = lastGameOver ? lastGameOver.standings
      : [...(room ? room.players : [])].sort((a, b) => b.score - a.score);
    if (!st.length) return;
    const winner = lastGameOver ? lastGameOver.winner : st[0];
    let losers;
    if (lastGameOver && lastGameOver.losers) {
      losers = lastGameOver.losers;
    } else {
      const low = st[st.length - 1].score;
      losers = st.length > 1 && st[0].score !== low ? st.filter((p) => p.score === low) : [];
    }
    $('champ-room').textContent = `ROOM ${room ? room.code : ''} · CHAMPION`;
    $('champ-name').textContent = winner.name;
    $('champ-points').textContent = String(winner.score);
    $('champ-best').textContent = winner.best != null ? `${(winner.best / 1000).toFixed(2)}s` : '—';
    $('champ-wins').textContent = winner.roundsWon != null ? String(winner.roundsWon) : '—';

    const stake = lastGameOver ? lastGameOver.stake : (room && room.stake);
    const tied = losers.length > 1;
    const names = losers.map((p) => (p.id === myId ? `${p.name} (you)` : p.name)).join(' & ');
    const iLost = losers.some((p) => p.id === myId);
    $('final-stake').hidden = false;
    if (!losers.length) {
      $('final-loser-label').textContent = 'NO LOSER';
      $('final-loser').textContent = 'Dead heat. Everyone tied.';
      $('final-stake-text').textContent = 'Nobody pays this time.';
    } else {
      $('final-loser-label').textContent = tied ? 'THE LOSERS · tied for lowest score' : 'THE LOSER · lowest score';
      $('final-loser').textContent = `${names} · ${losers[0].score} pts`;
      let line;
      if (!stake) line = 'No stake was set, so the loser just does the forfeit.';
      else if (tied) line = `Tied for last, so you split the stake: ${stake}.`;
      else line = iLost ? `You lose, bud. You pay the stake: ${stake}.` : `They pay the stake: ${stake}.`;
      $('final-stake-text').textContent = line;
    }
    $('final-forfeit').hidden = !losers.length || !lastGameOver;
    if (losers.length && lastGameOver) {
      $('forfeit-label').textContent = tied
        ? `FORFEIT FOR ${losers.map((p) => p.name.toUpperCase()).join(' & ')}`
        : `${losers[0].name.toUpperCase()}'S FORFEIT`;
      $('forfeit-text').textContent = lastGameOver.forfeit;
    }
    const loserIds = new Set(losers.map((p) => p.id));
    const list = $('final-list');
    list.replaceChildren();
    st.forEach((p, i) => {
      const li = el('li');
      li.append(el('span', 'pos', String(i + 1)));
      li.append(avatar(p));
      li.append(el('span', 'nm', p.id === myId ? `${p.name} (you)` : p.name));
      if (i === 0) li.append(el('span', 'tag-win', 'WINNER'));
      if (loserIds.has(p.id)) li.append(el('span', 'tag-lose', 'PAYS'));
      li.append(el('span', 'sc', String(p.score)));
      list.append(li);
    });
  }

  $('rematch-btn').addEventListener('click', () => {
    socket.emit('back_to_lobby');
    socket.emit('start_game', {}, (res) => { if (res && res.error) toast(res.error); });
  });

  function confetti() {
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const colors = ['#FFC247', '#E8412C', '#7FD3FF', '#B9F18C', '#F7A8FF'];
    for (let i = 0; i < 70; i++) {
      const c = el('div', 'confetti');
      c.style.left = `${Math.random() * 100}vw`;
      c.style.background = colors[i % colors.length];
      c.style.animationDuration = `${2 + Math.random() * 2.5}s`;
      c.style.animationDelay = `${Math.random() * 0.8}s`;
      document.body.append(c);
      setTimeout(() => c.remove(), 5500);
    }
  }

  // Winner card: a shareable PNG made on the device.
  $('card-btn').addEventListener('click', async () => {
    const st = lastGameOver ? lastGameOver.standings : [];
    const w = lastGameOver ? lastGameOver.winner : st[0];
    if (!w) return;
    try { if (document.fonts) await document.fonts.load('80px Bungee'); } catch { /* fallback font */ }
    const cv = document.createElement('canvas');
    cv.width = 1080; cv.height = 1350;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#0B1626'; ctx.fillRect(0, 0, 1080, 1350);
    ctx.fillStyle = 'rgba(244,247,251,0.5)';
    for (let i = 0; i < 60; i++) { ctx.beginPath(); ctx.arc(Math.random() * 1080, Math.random() * 1350, 2 + Math.random() * 3, 0, 7); ctx.fill(); }
    ctx.fillStyle = '#15253B';
    ctx.beginPath(); ctx.moveTo(0, 1350); ctx.lineTo(0, 1150); ctx.lineTo(200, 1050); ctx.lineTo(380, 1130); ctx.lineTo(560, 1000); ctx.lineTo(760, 1110); ctx.lineTo(920, 1040); ctx.lineTo(1080, 1120); ctx.lineTo(1080, 1350); ctx.fill();
    // road sign
    ctx.save(); ctx.translate(540, 260); ctx.rotate(Math.PI / 4);
    ctx.fillStyle = '#FFC247'; ctx.strokeStyle = '#0B1626'; ctx.lineWidth = 10;
    ctx.fillRect(-120, -120, 240, 240); ctx.strokeRect(-110, -110, 220, 220);
    ctx.restore();
    ctx.fillStyle = '#0B1626'; ctx.font = '120px Bungee, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('1', 540, 268);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#9FB3C8'; ctx.font = '700 40px Rubik, sans-serif';
    ctx.fillText(`ROOM ${room ? room.code : ''} · MOOSE CROSSING`, 540, 520);
    ctx.fillStyle = '#FFC247';
    let size = 130;
    ctx.font = `${size}px Bungee, sans-serif`;
    while (ctx.measureText(w.name.toUpperCase()).width > 960 && size > 50) { size -= 6; ctx.font = `${size}px Bungee, sans-serif`; }
    ctx.fillText(w.name.toUpperCase(), 540, 680);
    ctx.fillStyle = '#F4F7FB'; ctx.font = '800 56px Rubik, sans-serif';
    ctx.fillText('Moose Master of the Highway', 540, 780);
    ctx.font = '64px Bungee, sans-serif';
    const stats = [[String(w.score), 'points'], [w.best != null ? `${(w.best / 1000).toFixed(2)}s` : '—', 'best brake'], [String(w.roundsWon ?? '—'), 'rounds won']];
    stats.forEach(([v, l], i) => {
      const x = 220 + i * 320;
      ctx.fillStyle = '#F4F7FB'; ctx.font = '64px Bungee, sans-serif'; ctx.fillText(v, x, 920);
      ctx.fillStyle = '#9FB3C8'; ctx.font = '500 34px Rubik, sans-serif'; ctx.fillText(l, x, 970);
    });
    ctx.fillStyle = '#FFC247'; ctx.font = '700 38px Rubik, sans-serif';
    ctx.fillText('Hit BRAKE when the moose crosses.', 540, 1270);
    cv.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `moose-master-${w.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`;
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      toast('Winner card saved');
    }, 'image/png');
  });

  // ---------- Chat ----------
  function addChat(m) {
    const log = $('chat-log');
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    const row = el('div', `msg ${m.bot ? 'bot' : ''}`);
    if (m.bot) {
      const a = el('div', 'avatar bot-ava');
      a.setAttribute('aria-hidden', 'true');
      a.innerHTML = BOT_AVATAR; // static, trusted markup
      row.append(a);
    } else {
      row.append(avatar(m));
    }
    const b = el('div', 'bubble');
    b.append(el('span', 'who', m.bot ? m.name : (m.id === myId ? `${m.name} (you)` : m.name)));
    b.append(document.createTextNode(m.text));
    row.append(b);
    log.append(row);
    while (log.children.length > 80) log.firstChild.remove();
    if (nearBottom || m.id === myId) log.scrollTop = log.scrollHeight;
  }
  socket.on('chat_history', (list) => {
    $('chat-log').replaceChildren();
    list.forEach(addChat);
    $('chat-log').scrollTop = $('chat-log').scrollHeight;
  });
  socket.on('chat', addChat);
  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chat', { text });
    input.value = '';
    if (roundState) input.blur(); // mid-round, give the spacebar back to the BRAKE
  });

  // If we arrived with a saved seat (page reload), go straight to the room screen.
  if (mySeat) showScreen('room');
})();
