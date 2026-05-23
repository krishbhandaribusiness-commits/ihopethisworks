const socket = io({ autoConnect: false }); // FIX 1: Don't auto-connect to matchmaking
const chess = new Chess();

let myColor = null;
let currentRoom = null;
let selectedSquare = null;
let localStream = null;
let peerConnection = null;
let iceCandidateQueue = []; // FIX 2: Queue for ICE candidates

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
        
        // FIX 1: Only connect to the server AFTER the camera is active
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
    renderBoard();
});

socket.on('clock_update', (clocks) => {
    document.getElementById('player-clock').innerText = formatTime(clocks[myColor]);
    const oppColor = myColor === 'white' ? 'black' : 'white';
    document.getElementById('opponent-clock').innerText = formatTime(clocks[oppColor]);
});

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
            squareDiv.classList.add((r + f) % 2 === 0 ? 'blue-square' : 'white-square');
            squareDiv.dataset.square = squareName;

            if (squareObj) {
                const img = document.createElement('img');
                img.src = getPieceImgUrl(squareObj.color, squareObj.type);
                img.classList.add('chess-piece-img');
                squareDiv.appendChild(img);
            }

            if (selectedSquare === squareName) {
                squareDiv.classList.add('selected');
            }

            squareDiv.addEventListener('click', () => handleSquareClick(squareName));
            boardElement.appendChild(squareDiv);
        }
    }
}

function handleSquareClick(square) {
    if (chess.turn() !== myColor[0]) return;

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
                socket.emit('game_over', { roomId: currentRoom, reason: "Checkmate or Draw evaluation triggered structural closure." });
            }
        }
        selectedSquare = null;
        renderBoard();
    }
}

function initWebRTC(opponentId, isOfferer) {
    peerConnection = new RTCPeerConnection(rtcConfig);
    iceCandidateQueue = []; // Reset queue for new connection

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
                
                // FIX 2: Process queued ICE candidates after Remote Description is securely set
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
            // FIX 2: Check if it's safe to add candidate, otherwise queue it
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