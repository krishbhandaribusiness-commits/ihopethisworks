const socket = io({ autoConnect: false });
const chess = new Chess();

let myColor = null;
let currentRoom = null;

// Normal Move State
let selectedSquare = null;

// Premove State
let premoveSelectedSquare = null;
let premove = null;

// Move history (SAN strings)
let moveHistory = [];

let localStream = null;
let peerConnection = null;
let iceCandidateQueue = [];

// Track whether the local user has already requested a rematch this game-over,
// so we can show "Waiting…" on their button.
let rematchRequested = false;

const boardElement = document.getElementById('chess-board');
const statusBar = document.getElementById('status-bar');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');

// New element refs
const moveListBody = document.getElementById('move-list-body');
const gameControls = document.getElementById('game-controls');
const resignBtn = document.getElementById('resign-btn');
const drawBtn = document.getElementById('draw-btn');
const camBtn = document.getElementById('cam-btn');
const micBtn = document.getElementById('mic-btn');
const drawToast = document.getElementById('draw-toast');
const drawToastText = document.getElementById('draw-toast-text');
const drawToastActions = document.getElementById('draw-toast-actions');
const drawAcceptBtn = document.getElementById('draw-accept-btn');
const drawDeclineBtn = document.getElementById('draw-decline-btn');
const gameOverModal = document.getElementById('game-over-modal');
const gameOverTitle = document.getElementById('game-over-title');
const rematchBtn = document.getElementById('rematch-btn');
const analyzeBtn = document.getElementById('analyze-btn');
const newOppBtn = document.getElementById('new-opp-btn');

let drawToastHideTimer = null;

const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function getPieceImgUrl(color, type) {
    const pColor = color === 'w' ? 'w' : 'b';
    const pType = type.toUpperCase();
    return `https://lichess1.org/assets/piece/cburnett/${pColor}${pType}.svg`;
}

async function initCamera() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: { aspectRatio: 1.7777777778 },
            audio: true
        });
        localVideo.srcObject = localStream;

        // Media buttons become live once we have tracks.
        camBtn.disabled = false;
        micBtn.disabled = false;

        socket.connect();

    } catch (err) {
        console.error("Camera access blocked:", err);
        statusBar.innerHTML = `<span class="pulse pulse--red"></span> Camera/Mic access required.`;
    }
}

socket.on('waiting', (msg) => {
    statusBar.innerHTML = `<span class="pulse pulse--amber"></span> ${msg}`;
});

socket.on('match_found', async (data) => {
    myColor = data.color;
    currentRoom = data.roomId;
    statusBar.innerHTML = `<span class="pulse"></span> Matched! You are playing ${myColor.toUpperCase()}`;

    // Reset per-game state (covers the very first match too)
    moveHistory = [];
    selectedSquare = null;
    premove = null;
    premoveSelectedSquare = null;
    rematchRequested = false;

    renderBoard();
    renderMoveList();
    gameControls.hidden = false;

    initWebRTC(data.opponentId, myColor === 'white');
});

socket.on('move_received', (move) => {
    const applied = chess.move(move);
    if (applied) {
        moveHistory.push(applied.san);
        renderMoveList();
    }

    // PREMOVE EXECUTION LOGIC
    if (premove) {
        // Try applying the queued premove instantly
        const pMove = chess.move(premove);
        if (pMove) {
            moveHistory.push(pMove.san);
            renderMoveList();
            // It was valid! Send it to the server immediately.
            socket.emit('make_move', { roomId: currentRoom, move: pMove, nextTurn: chess.turn() === 'w' ? 'white' : 'black' });
            if (chess.game_over()) {
                socket.emit('game_over', { roomId: currentRoom, reason: describeEnd() });
            }
        }
        // Always wipe the premove state after attempting it
        premove = null;
    }

    renderBoard();
});

socket.on('clock_update', (clocks) => {
    document.getElementById('player-clock').innerText = formatTime(clocks[myColor]);
    const oppColor = myColor === 'white' ? 'black' : 'white';
    document.getElementById('opponent-clock').innerText = formatTime(clocks[oppColor]);
    updateActiveClock();
});

function updateActiveClock() {
    if (!myColor) return;
    const playerClock = document.getElementById('player-clock');
    const opponentClock = document.getElementById('opponent-clock');
    const turn = chess.turn() === 'w' ? 'white' : 'black';
    if (turn === myColor) {
        playerClock.classList.add('clock--active');
        opponentClock.classList.remove('clock--active');
    } else {
        opponentClock.classList.add('clock--active');
        playerClock.classList.remove('clock--active');
    }
}

socket.on('game_over_announced', (reason) => {
    statusBar.innerText = reason;
    showGameOverModal(reason);
});

socket.on('opponent_disconnected', () => {
    alert("Opponent disconnected. Match closed.");
    window.location.reload();
});

// ---------- Rematch ----------
socket.on('rematch_requested_by_opponent', () => {
    // Opponent wants to rematch; give the local user a visual nudge.
    if (!gameOverModal.hidden) {
        rematchBtn.classList.add('btn--pulse');
        rematchBtn.innerText = 'Rematch (opponent ready)';
    }
});

socket.on('rematch_start', () => {
    // Full client-side reset.
    chess.reset();
    moveHistory = [];
    selectedSquare = null;
    premove = null;
    premoveSelectedSquare = null;
    rematchRequested = false;

    hideGameOverModal();
    renderBoard();
    renderMoveList();
    statusBar.innerHTML = `<span class="pulse"></span> Rematch! You are playing ${myColor.toUpperCase()}`;
});

// ---------- Draw signals ----------
socket.on('draw_offered', () => {
    showDrawOfferToast();
});

socket.on('draw_declined', () => {
    showTransientToast('Draw declined.');
});

function renderBoard() {
    boardElement.innerHTML = '';

    const ranks = myColor === 'black' ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
    const files = myColor === 'black' ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
    const fileLetters = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

    for (let r of ranks) {
        for (let f of files) {
            const squareName = `${fileLetters[f]}${r}`;
            const squareObj = chess.get(squareName);

            const squareDiv = document.createElement('div');
            squareDiv.classList.add('square');
            squareDiv.classList.add((r + f) % 2 === 0 ? 'white-square' : 'blue-square');
            squareDiv.dataset.square = squareName;

            if (squareObj) {
                const img = document.createElement('img');
                img.src = getPieceImgUrl(squareObj.color, squareObj.type);
                img.classList.add('chess-piece-img');
                squareDiv.appendChild(img);
            }

            // Normal move styling
            if (selectedSquare === squareName) {
                squareDiv.classList.add('selected');
            }

            // Premove styling
            if (premoveSelectedSquare === squareName) {
                squareDiv.classList.add('premove-selected');
            }
            if (premove && (premove.from === squareName || premove.to === squareName)) {
                squareDiv.classList.add('premove-active');
            }

            squareDiv.addEventListener('click', () => handleSquareClick(squareName));
            boardElement.appendChild(squareDiv);
        }
    }
    updateActiveClock();
}

function handleSquareClick(square) {
    const isMyTurn = chess.turn() === myColor[0];

    if (isMyTurn) {
        // --- NORMAL MOVE LOGIC ---
        // Ensure no leftover premove state exists
        premove = null;
        premoveSelectedSquare = null;

        if (selectedSquare === null) {
            if (chess.get(square) && chess.get(square).color === myColor[0]) {
                selectedSquare = square;
                renderBoard();
            }
        } else {
            const move = chess.move({ from: selectedSquare, to: square, promotion: 'q' });
            if (move) {
                moveHistory.push(move.san);
                renderMoveList();
                socket.emit('make_move', { roomId: currentRoom, move: move, nextTurn: chess.turn() === 'w' ? 'white' : 'black' });
                if (chess.game_over()) {
                    socket.emit('game_over', { roomId: currentRoom, reason: describeEnd() });
                }
            }
            selectedSquare = null;
            renderBoard();
        }
    } else {
        // --- PREMOVE LOGIC (Opponent's Turn) ---
        if (premoveSelectedSquare === null) {
            // Pick a piece to premove
            if (chess.get(square) && chess.get(square).color === myColor[0]) {
                premoveSelectedSquare = square;
                premove = null; // Reset any existing active premove
                renderBoard();
            } else {
                // Clicked an empty square or opponent's piece -> cancel premove entirely
                premove = null;
                renderBoard();
            }
        } else {
            // We already selected a piece to premove, now decide where it goes
            if (premoveSelectedSquare === square) {
                // Clicked the same square, cancel selection
                premoveSelectedSquare = null;
                renderBoard();
            } else if (chess.get(square) && chess.get(square).color === myColor[0]) {
                // Clicked another one of our pieces, change the selection
                premoveSelectedSquare = square;
                renderBoard();
            } else {
                // Confirm the premove!
                premove = { from: premoveSelectedSquare, to: square, promotion: 'q' };
                premoveSelectedSquare = null;
                renderBoard();
            }
        }
    }
}

// ---------- Move list ----------
function renderMoveList() {
    moveListBody.innerHTML = '';

    if (moveHistory.length === 0) {
        const placeholder = document.createElement('div');
        placeholder.className = 'move-list__placeholder';
        placeholder.innerText = 'Waiting for first move…';
        moveListBody.appendChild(placeholder);
        return;
    }

    const totalPairs = Math.ceil(moveHistory.length / 2);
    const latestIndex = moveHistory.length - 1; // index of the most recent half-move

    for (let i = 0; i < totalPairs; i++) {
        const whiteIdx = i * 2;
        const blackIdx = whiteIdx + 1;

        const row = document.createElement('div');
        row.className = 'move-list__row';

        const numCell = document.createElement('span');
        numCell.className = 'move-list__num';
        numCell.innerText = `${i + 1}.`;
        row.appendChild(numCell);

        const whiteCell = document.createElement('span');
        whiteCell.className = 'move-list__half';
        whiteCell.innerText = moveHistory[whiteIdx] || '';
        if (whiteIdx === latestIndex) whiteCell.classList.add('move-list__half--latest');
        row.appendChild(whiteCell);

        const blackCell = document.createElement('span');
        blackCell.className = 'move-list__half';
        blackCell.innerText = moveHistory[blackIdx] || '';
        if (blackIdx === latestIndex) blackCell.classList.add('move-list__half--latest');
        row.appendChild(blackCell);

        moveListBody.appendChild(row);
    }

    // Auto-scroll to bottom
    moveListBody.scrollTop = moveListBody.scrollHeight;
}

// ---------- Game-end helpers ----------
function describeEnd() {
    if (chess.in_checkmate()) {
        const loser = chess.turn() === 'w' ? 'White' : 'Black';
        const winner = loser === 'White' ? 'Black' : 'White';
        return `Checkmate! ${winner} wins.`;
    }
    if (chess.in_stalemate()) return 'Draw by stalemate.';
    if (chess.in_threefold_repetition()) return 'Draw by repetition.';
    if (chess.insufficient_material()) return 'Draw by insufficient material.';
    if (chess.in_draw()) return 'Draw.';
    return 'Game Over';
}

// ---------- Game-over modal ----------
function showGameOverModal(reason) {
    gameOverTitle.innerText = reason;
    rematchBtn.innerText = 'Rematch';
    rematchBtn.disabled = false;
    rematchBtn.classList.remove('btn--pulse');
    rematchRequested = false;
    gameOverModal.hidden = false;
    // Trigger CSS transition
    requestAnimationFrame(() => gameOverModal.classList.add('modal--shown'));
}

function hideGameOverModal() {
    gameOverModal.classList.remove('modal--shown');
    gameOverModal.hidden = true;
}

rematchBtn.addEventListener('click', () => {
    if (rematchRequested) return;
    rematchRequested = true;
    rematchBtn.innerText = 'Waiting for opponent…';
    rematchBtn.disabled = true;
    socket.emit('rematch_request', { roomId: currentRoom });
});

analyzeBtn.addEventListener('click', () => {
    const pgn = buildPGN();
    if (!pgn) return;
    const url = `https://lichess.org/analysis/pgn/${encodeURIComponent(pgn)}`;
    window.open(url, '_blank', 'noopener');
});

newOppBtn.addEventListener('click', () => {
    window.location.reload();
});

function buildPGN() {
    let pgn = '';
    for (let i = 0; i < moveHistory.length; i += 2) {
        const moveNum = (i / 2) + 1;
        pgn += `${moveNum}. ${moveHistory[i]}`;
        if (moveHistory[i + 1]) pgn += ` ${moveHistory[i + 1]}`;
        pgn += ' ';
    }
    return pgn.trim();
}

// ---------- Media toggles ----------
camBtn.addEventListener('click', () => {
    if (!localStream) return;
    const track = localStream.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    camBtn.classList.toggle('muted', !track.enabled);
});

micBtn.addEventListener('click', () => {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    micBtn.classList.toggle('muted', !track.enabled);
});

// ---------- Resign / Draw controls ----------
let resignConfirming = false;
let resignTimeout = null;

resignBtn.addEventListener('click', () => {
    if (!currentRoom) return;
    if (!resignConfirming) {
        // Enter confirmation state
        resignConfirming = true;
        resignBtn.classList.add('game-ctrl--confirming');
        resignBtn.innerHTML = `
            <span class="game-ctrl__confirm-text">Confirm resign?</span>
            <span class="game-ctrl__confirm-actions">
                <span class="game-ctrl__confirm-yes">Yes</span>
                <span class="game-ctrl__confirm-no">Cancel</span>
            </span>
        `;

        // Auto-revert after 4s
        clearTimeout(resignTimeout);
        resignTimeout = setTimeout(restoreResignBtn, 4000);

        // Listen for inner clicks
        resignBtn.querySelector('.game-ctrl__confirm-yes').addEventListener('click', (e) => {
            e.stopPropagation();
            const myName = myColor === 'white' ? 'White' : 'Black';
            const oppName = myColor === 'white' ? 'Black' : 'White';
            socket.emit('game_over', {
                roomId: currentRoom,
                reason: `${myName} resigned. ${oppName} wins!`
            });
            restoreResignBtn();
        });
        resignBtn.querySelector('.game-ctrl__confirm-no').addEventListener('click', (e) => {
            e.stopPropagation();
            restoreResignBtn();
        });
    }
});

function restoreResignBtn() {
    resignConfirming = false;
    clearTimeout(resignTimeout);
    resignBtn.classList.remove('game-ctrl--confirming');
    resignBtn.innerHTML = `
        <svg class="game-ctrl__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>
            <line x1="4" y1="22" x2="4" y2="15"/>
        </svg>
        <span class="game-ctrl__label">Resign</span>
    `;
}

drawBtn.addEventListener('click', () => {
    if (!currentRoom) return;
    socket.emit('draw_offer', { roomId: currentRoom });
    showTransientToast('Draw offer sent.');
});

// Draw toast UI
function showDrawOfferToast() {
    clearTimeout(drawToastHideTimer);
    drawToastText.innerText = 'Opponent offers a draw';
    drawToastActions.style.display = '';
    drawToast.hidden = false;
    requestAnimationFrame(() => drawToast.classList.add('draw-toast--shown'));
}

function hideDrawToast() {
    drawToast.classList.remove('draw-toast--shown');
    setTimeout(() => { drawToast.hidden = true; }, 200);
}

function showTransientToast(message) {
    clearTimeout(drawToastHideTimer);
    drawToastText.innerText = message;
    drawToastActions.style.display = 'none';
    drawToast.hidden = false;
    requestAnimationFrame(() => drawToast.classList.add('draw-toast--shown'));
    drawToastHideTimer = setTimeout(hideDrawToast, 2500);
}

drawAcceptBtn.addEventListener('click', () => {
    socket.emit('game_over', { roomId: currentRoom, reason: 'Draw by agreement.' });
    hideDrawToast();
});

drawDeclineBtn.addEventListener('click', () => {
    socket.emit('draw_declined', { roomId: currentRoom });
    hideDrawToast();
});

// ---------- WebRTC (untouched) ----------
function initWebRTC(opponentId, isOfferer) {
    peerConnection = new RTCPeerConnection(rtcConfig);
    iceCandidateQueue = [];

    if (localStream) {
        localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
    }

    peerConnection.ontrack = (event) => {
        if (remoteVideo.srcObject !== event.streams[0]) {
            remoteVideo.srcObject = event.streams[0];
        }
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('signal', { to: opponentId, signal: { candidate: event.candidate } });
        }
    };

    if (isOfferer) {
        peerConnection.createOffer().then(offer => {
            return peerConnection.setLocalDescription(offer);
        }).then(() => {
            socket.emit('signal', { to: opponentId, signal: { sdp: peerConnection.localDescription } });
        });
    }

    socket.on('signal', (data) => {
        if (data.from !== opponentId) return;

        if (data.signal.sdp) {
            peerConnection.setRemoteDescription(new RTCSessionDescription(data.signal.sdp)).then(() => {

                while(iceCandidateQueue.length) {
                    const queuedCandidate = iceCandidateQueue.shift();
                    peerConnection.addIceCandidate(new RTCIceCandidate(queuedCandidate));
                }

                if (peerConnection.remoteDescription.type === 'offer') {
                    peerConnection.createAnswer().then(answer => {
                        return peerConnection.setLocalDescription(answer);
                    }).then(() => {
                        socket.emit('signal', { to: opponentId, signal: { sdp: peerConnection.localDescription } });
                    });
                }
            }).catch(e => console.error("WebRTC SDP Error:", e));

        } else if (data.signal.candidate) {
            if (peerConnection.remoteDescription) {
                peerConnection.addIceCandidate(new RTCIceCandidate(data.signal.candidate))
                    .catch(e => console.error("WebRTC ICE Error:", e));
            } else {
                iceCandidateQueue.push(data.signal.candidate);
            }
        }
    });
}

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

initCamera();
