const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

// ========== RAQAMLARNI TOP ==========
const numRooms = {};
// ========== TOLMANAK ==========
const fruRooms = {};

const playerRoom = new Map(); // ws -> { game, roomId }

function sendTo(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function randomId() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// ===== RAQAMLARNI TOP logika =====
function broadcastNumRooms() {
  const list = Object.entries(numRooms)
    .filter(([, r]) => r.players.length === 1)
    .map(([id, r]) => ({ id, name: r.name, host: r.usernames[0] }));
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN)
      c.send(JSON.stringify({ type: 'num_room_list', rooms: list }));
  });
}

function checkGuess(secret, guess) {
  const result = ['_','_','_','_'];
  for (let i = 0; i < 4; i++)
    if (guess[i] === secret[i]) result[i] = guess[i];
  return result;
}

// ===== TOLMANAK logika =====
function broadcastFruRooms() {
  const list = Object.entries(fruRooms)
    .filter(([, r]) => r.players.length === 1)
    .map(([id, r]) => ({ id, name: r.name, host: r.usernames[0] }));
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN)
      c.send(JSON.stringify({ type: 'fru_room_list', rooms: list }));
  });
}

wss.on('connection', (ws) => {
  // Yangi ulanuvchiga ikki o'yin xonalarini yuborish
  const numList = Object.entries(numRooms)
    .filter(([, r]) => r.players.length === 1)
    .map(([id, r]) => ({ id, name: r.name, host: r.usernames[0] }));
  sendTo(ws, { type: 'num_room_list', rooms: numList });

  const fruList = Object.entries(fruRooms)
    .filter(([, r]) => r.players.length === 1)
    .map(([id, r]) => ({ id, name: r.name, host: r.usernames[0] }));
  sendTo(ws, { type: 'fru_room_list', rooms: fruList });

  ws.on('message', (message) => {
    let data;
    try { data = JSON.parse(message); } catch { return; }

    // ===== RAQAMLARNI TOP =====
    if (data.type === 'num_create_room') {
      const roomId = randomId();
      numRooms[roomId] = {
        name: data.name || data.username,
        players: [ws], usernames: [data.username],
        numbers: [null, null], guesses: [], currentTurn: 0
      };
      playerRoom.set(ws, { game: 'num', roomId });
      sendTo(ws, { type: 'num_room_created', roomId, playerIndex: 0 });
      broadcastNumRooms();
    }

    else if (data.type === 'num_join_room') {
      const room = numRooms[data.roomId];
      if (!room) return sendTo(ws, { type: 'error', msg: 'Xona topilmadi' });
      if (room.players.length >= 2) return sendTo(ws, { type: 'error', msg: 'Xona to\'liq' });
      room.players.push(ws);
      room.usernames.push(data.username);
      playerRoom.set(ws, { game: 'num', roomId: data.roomId });
      sendTo(ws, { type: 'num_room_joined', roomId: data.roomId, playerIndex: 1 });
      sendTo(room.players[0], { type: 'num_opponent_joined', opponentName: data.username });
      sendTo(ws, { type: 'num_opponent_joined', opponentName: room.usernames[0] });
      broadcastNumRooms();
    }

    else if (data.type === 'num_set_number') {
      const pr = playerRoom.get(ws);
      const room = pr && numRooms[pr.roomId];
      if (!room) return;
      const idx = room.players.indexOf(ws);
      room.numbers[idx] = data.number;
      sendTo(ws, { type: 'num_number_set' });
      if (room.numbers[0] && room.numbers[1]) {
        sendTo(room.players[0], { type: 'num_game_start', yourTurn: true });
        sendTo(room.players[1], { type: 'num_game_start', yourTurn: false });
      }
    }

    else if (data.type === 'num_guess') {
      const pr = playerRoom.get(ws);
      const room = pr && numRooms[pr.roomId];
      if (!room) return;
      const attackerIdx = room.players.indexOf(ws);
      const defenderIdx = 1 - attackerIdx;
      const secret = room.numbers[defenderIdx];
      const result = checkGuess(secret.split(''), data.number.split(''));
      const won = result.join('') === secret;
      room.guesses.push({ player: attackerIdx, guess: data.number, result });
      room.players.forEach((p, i) => {
        sendTo(p, {
          type: 'num_guess_result',
          guesserIdx: attackerIdx,
          guess: data.number, result, won,
          yourTurn: won ? false : i === defenderIdx
        });
      });
      if (won) {
        delete numRooms[pr.roomId];
        room.players.forEach(p => playerRoom.delete(p));
        broadcastNumRooms();
      } else {
        room.currentTurn = defenderIdx;
      }
    }

    // ===== TOLMANAK =====
    else if (data.type === 'fru_create_room') {
      const roomId = randomId();
      fruRooms[roomId] = {
        name: data.name || data.username,
        players: [ws], usernames: [data.username],
        hidden: [null, null], // har o'yinchining yashirin katakchalari
        board: [null, null],  // har o'yinchining taxtasi [ochilgan katakchalar]
        currentTurn: 0
      };
      playerRoom.set(ws, { game: 'fru', roomId });
      sendTo(ws, { type: 'fru_room_created', roomId, playerIndex: 0 });
      broadcastFruRooms();
    }

    else if (data.type === 'fru_join_room') {
      const room = fruRooms[data.roomId];
      if (!room) return sendTo(ws, { type: 'error', msg: 'Xona topilmadi' });
      if (room.players.length >= 2) return sendTo(ws, { type: 'error', msg: 'Xona to\'liq' });
      room.players.push(ws);
      room.usernames.push(data.username);
      playerRoom.set(ws, { game: 'fru', roomId: data.roomId });
      sendTo(ws, { type: 'fru_room_joined', roomId: data.roomId, playerIndex: 1 });
      sendTo(room.players[0], { type: 'fru_opponent_joined', opponentName: data.username });
      sendTo(ws, { type: 'fru_opponent_joined', opponentName: room.usernames[0] });
      broadcastFruRooms();
    }

    else if (data.type === 'fru_set_hidden') {
      // O'yinchi o'z yashirin katakchalarini yuboradi [0-8 indekslar, 3 ta]
      const pr = playerRoom.get(ws);
      const room = pr && fruRooms[pr.roomId];
      if (!room) return;
      const idx = room.players.indexOf(ws);
      room.hidden[idx] = data.cells; // [2, 5, 7] kabi
      room.board[idx] = []; // ochilgan katakchalar
      sendTo(ws, { type: 'fru_hidden_set' });
      if (room.hidden[0] && room.hidden[1]) {
        sendTo(room.players[0], { type: 'fru_game_start', yourTurn: true });
        sendTo(room.players[1], { type: 'fru_game_start', yourTurn: false });
      }
    }

    else if (data.type === 'fru_open_cell') {
      const pr = playerRoom.get(ws);
      const room = pr && fruRooms[pr.roomId];
      if (!room) return;
      const attackerIdx = room.players.indexOf(ws);
      const defenderIdx = 1 - attackerIdx;
      const cell = data.cell; // 0-8
      const hit = room.hidden[defenderIdx].includes(cell);

      if (!room.board[defenderIdx].includes(cell)) {
        room.board[defenderIdx].push(cell);
      }

      const won = room.hidden[defenderIdx].every(c => room.board[defenderIdx].includes(c));

      room.players.forEach((p, i) => {
        sendTo(p, {
          type: 'fru_cell_result',
          attackerIdx,
          cell, hit, won,
          yourTurn: won ? false : (!hit ? i === defenderIdx : i === attackerIdx)
        });
      });

      if (won) {
        delete fruRooms[pr.roomId];
        room.players.forEach(p => playerRoom.delete(p));
        broadcastFruRooms();
      } else {
        room.currentTurn = hit ? attackerIdx : defenderIdx;
      }
    }
  });

  ws.on('close', () => {
    const pr = playerRoom.get(ws);
    if (pr) {
      const rooms = pr.game === 'num' ? numRooms : fruRooms;
      const broadcast = pr.game === 'num' ? broadcastNumRooms : broadcastFruRooms;
      const room = rooms[pr.roomId];
      if (room) {
        room.players.forEach(p => {
          if (p !== ws) sendTo(p, { type: 'opponent_left' });
          playerRoom.delete(p);
        });
        delete rooms[pr.roomId];
        broadcast();
      }
    }
    playerRoom.delete(ws);
  });
});

server.listen(PORT, () => console.log(`Server started on port ${PORT}`));
