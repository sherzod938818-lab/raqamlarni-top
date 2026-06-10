process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const WebSocket = require('ws');
const https = require('https');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;

const wss = new WebSocket.Server({ port: PORT });

// Xonalar: { roomId: { players: [ws1, ws2], numbers: [null, null], guesses: [], currentTurn: 0 } }
const rooms = {};
const playerRoom = new Map(); // ws -> roomId

function sendTo(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function generateRoomId() {
  return Math.random().toString(36).substr(2, 8).toUpperCase();
}

function checkGuess(secret, guess) {
  const result = ['_', '_', '_', '_'];
  for (let i = 0; i < 4; i++) {
    if (guess[i] === secret[i]) {
      result[i] = guess[i];
    }
  }
  return result;
}

wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    let data;
    try { data = JSON.parse(message); } catch { return; }

    if (data.type === 'create_room') {
      const roomId = generateRoomId();
      rooms[roomId] = {
        players: [ws],
        usernames: [data.username],
        numbers: [null, null],
        guesses: [],
        currentTurn: 0
      };
      playerRoom.set(ws, roomId);
      sendTo(ws, { type: 'room_created', roomId, playerIndex: 0 });
    }

    else if (data.type === 'join_room') {
      const room = rooms[data.roomId];
      if (!room) return sendTo(ws, { type: 'error', msg: 'Xona topilmadi' });
      if (room.players.length >= 2) return sendTo(ws, { type: 'error', msg: 'Xona to\'liq' });

      room.players.push(ws);
      room.usernames.push(data.username);
      playerRoom.set(ws, data.roomId);

      sendTo(ws, { type: 'room_joined', roomId: data.roomId, playerIndex: 1 });
      sendTo(room.players[0], { type: 'opponent_joined', opponentName: data.username });
      sendTo(ws, { type: 'opponent_joined', opponentName: room.usernames[0] });
    }

    else if (data.type === 'set_number') {
      const roomId = playerRoom.get(ws);
      const room = rooms[roomId];
      if (!room) return;
      const idx = room.players.indexOf(ws);
      room.numbers[idx] = data.number;

      sendTo(ws, { type: 'number_set' });

      if (room.numbers[0] && room.numbers[1]) {
        sendTo(room.players[0], { type: 'game_start', yourTurn: true });
        sendTo(room.players[1], { type: 'game_start', yourTurn: false });
      }
    }

    else if (data.type === 'guess') {
      const roomId = playerRoom.get(ws);
      const room = rooms[roomId];
      if (!room) return;

      const attackerIdx = room.players.indexOf(ws);
      const defenderIdx = 1 - attackerIdx;
      const secret = room.numbers[defenderIdx];
      const result = checkGuess(secret.split(''), data.number.split(''));

      const guessEntry = {
        player: attackerIdx,
        guess: data.number,
        result
      };
      room.guesses.push(guessEntry);

      const won = result.join('') === secret;

      room.players.forEach((p, i) => {
        sendTo(p, {
          type: 'guess_result',
          guesserIdx: attackerIdx,
          guess: data.number,
          result,
          won,
          yourTurn: won ? false : i === defenderIdx
        });
      });

      if (won) {
        delete rooms[roomId];
        room.players.forEach(p => playerRoom.delete(p));
      } else {
        room.currentTurn = defenderIdx;
      }
    }
  });

  ws.on('close', () => {
    const roomId = playerRoom.get(ws);
    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];
      room.players.forEach(p => {
        if (p !== ws) sendTo(p, { type: 'opponent_left' });
        playerRoom.delete(p);
      });
      delete rooms[roomId];
    }
    playerRoom.delete(ws);
  });
});

console.log(`Server started on port ${PORT}`);
