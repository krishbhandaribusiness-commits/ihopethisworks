const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

let waitingPlayer = null;
const games = {};

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    if (!waitingPlayer) {
        waitingPlayer = socket;
        socket.emit('waiting', 'Waiting for an opponent...');
    } else {
        const opponent = waitingPlayer;
        waitingPlayer = null;

        const roomId = `room_${opponent.id}_${socket.id}`;
        opponent.join(roomId);
        socket.join(roomId);

        games[roomId] = {
            white: opponent.id,
            black: socket.id,
            clocks: { white: 300, black: 300 },
            turn: 'white',
            timerInterval: null
        };

        opponent.emit('match_found', { roomId, color: 'white', opponentId: socket.id });
        socket.emit('match_found', { roomId, color: 'black', opponentId: opponent.id });

        startRoomClock(roomId);
    }

    socket.on('signal', (data) => {
        io.to(data.to).emit('signal', {
            from: socket.id,
            signal: data.signal
        });
    });

    socket.on('make_move', (data) => {
        const { roomId, move } = data;
        const game = games[roomId];
        if (!game || game[game.turn] !== socket.id) return;

        game.turn = data.nextTurn;
        
        socket.to(roomId).emit('move_received', move);
    });

    socket.on('game_over', (data) => {
        const game = games[data.roomId];
        if (game && game.timerInterval) {
            clearInterval(game.timerInterval);
        }
        io.to(data.roomId).emit('game_over_announced', data.reason);
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        if (waitingPlayer && waitingPlayer.id === socket.id) {
            waitingPlayer = null;
        }
        
        for (const roomId in games) {
            if (games[roomId].white === socket.id || games[roomId].black === socket.id) {
                socket.to(roomId).emit('opponent_disconnected');
                if (games[roomId].timerInterval) clearInterval(games[roomId].timerInterval);
                delete games[roomId];
                break;
            }
        }
    });
});

function startRoomClock(roomId) {
    const game = games[roomId];
    if (!game) return;

    game.timerInterval = setInterval(() => {
        if (game.clocks[game.turn] > 0) {
            game.clocks[game.turn]--;
            io.to(roomId).emit('clock_update', game.clocks);
        } else {
            clearInterval(game.timerInterval);
            io.to(roomId).emit('game_over_announced', `${game.turn === 'white' ? 'Black' : 'White'} wins on time!`);
        }
    }, 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`ChessConnect running smoothly on port ${PORT}`);
});