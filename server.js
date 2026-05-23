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
            clocks: { white: 180, black: 180 },
            turn: 'white',
            timerInterval: null,
            rematchRequests: { white: false, black: false }
        };

        opponent.emit('match_found', { roomId, color: 'white', opponentId: socket.id });
        socket.emit('match_found', { roomId, color: 'black', opponentId: opponent.id });

        // Clocks don't start ticking until White's first move is made.
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

        // 3+2: the player who just completed a move gets +2 seconds.
        // `data.nextTurn` is whose turn it is NOW, so the mover is the opposite color.
        const moverColor = game.turn; // still the mover's color before we flip it
        game.clocks[moverColor] += 2;

        game.turn = data.nextTurn;

        // Kick off the room clock on the very first move (White's opener).
        if (!game.timerInterval) {
            startRoomClock(roomId);
        }

        // Broadcast the updated clocks immediately so the increment shows up
        // without waiting for the next 1s tick.
        io.to(roomId).emit('clock_update', game.clocks);

        socket.to(roomId).emit('move_received', move);
    });

    socket.on('game_over', (data) => {
        const game = games[data.roomId];
        if (game && game.timerInterval) {
            clearInterval(game.timerInterval);
            game.timerInterval = null;
        }
        io.to(data.roomId).emit('game_over_announced', data.reason);
    });

    // ---------- Rematch ----------
    socket.on('rematch_request', (data) => {
        const game = games[data.roomId];
        if (!game) return;
        const color = game.white === socket.id ? 'white' :
                      game.black === socket.id ? 'black' : null;
        if (!color) return;

        game.rematchRequests[color] = true;

        if (game.rematchRequests.white && game.rematchRequests.black) {
            // Both players agreed — reset game state.
            if (game.timerInterval) {
                clearInterval(game.timerInterval);
                game.timerInterval = null;
            }
            game.clocks = { white: 180, black: 180 };
            game.turn = 'white';
            game.rematchRequests = { white: false, black: false };

            io.to(data.roomId).emit('rematch_start');
            io.to(data.roomId).emit('clock_update', game.clocks);
        } else {
            // Notify opponent that one side wants a rematch.
            socket.to(data.roomId).emit('rematch_requested_by_opponent');
        }
    });

    // ---------- Draw offers ----------
    socket.on('draw_offer', (data) => {
        socket.to(data.roomId).emit('draw_offered');
    });

    socket.on('draw_declined', (data) => {
        socket.to(data.roomId).emit('draw_declined');
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
            game.timerInterval = null;
            io.to(roomId).emit('game_over_announced', `${game.turn === 'white' ? 'Black' : 'White'} wins on time!`);
        }
    }, 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`ChessConnect running smoothly on port ${PORT}`);
});
