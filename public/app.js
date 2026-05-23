const socket = io({ autoConnect: false }); 
const chess = new Chess();

let myColor = null;
let currentRoom = null;

// Normal Move State
let selectedSquare = null;

// Premove State
let premoveSelectedSquare = null;
let premove = null;

let localStream = null;
let peerConnection = null;
let iceCandidateQueue = []; 

const boardElement = document.getElementById('chess-board');
const statusBar = document.getElementById('status-bar');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');

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
        
        socket.connect(); 
        
    } catch (err) {
        console.error("Camera access blocked:", err);
        statusBar.innerHTML = `<span class="pulse" style="background:#ef4444"></span> Camera/Mic access required.`;
    }
}

socket.on('waiting', (msg) => {
    statusBar.innerHTML = `<span class="pulse" style="background:#f59e0b"></span> ${msg}`;
});

socket.on('match_found', async (data) => {
    myColor = data.color;
    currentRoom = data.roomId;
    statusBar.innerHTML = `<span class="pulse"></span> Matched! You are playing ${myColor.toUpperCase()}`;
    
    renderBoard();
    initWebRTC(data.opponentId, myColor === 'white');
});

socket.on('move_received', (move) => {
    chess.move(move);
    
    // PREMOVE EXECUTION LOGIC
    if (premove) {
        // Try applying the queued premove instantly
        const pMove = chess.move(premove);
        if (pMove) {
            // It was valid! Send it to the server immediately.
            socket.emit('make_move', { roomId: currentRoom, move: pMove, nextTurn: chess.turn() === 'w' ? 'white' : 'black' });
            if (chess.game_over()) {
                socket.emit('game_over', { roomId: currentRoom, reason: "Game Over" });
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
    alert(`Game Over: ${reason}`);
    statusBar.innerText = reason;
});

socket.on('opponent_disconnected', () => {
    alert("Opponent disconnected. Match closed.");
    window.location.reload();
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
                socket.emit('make_move', { roomId: currentRoom, move: move, nextTurn: chess.turn() === 'w' ? 'white' : 'black' });
                if (chess.game_over()) {
                    socket.emit('game_over', { roomId: currentRoom, reason: "Game Over" });
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