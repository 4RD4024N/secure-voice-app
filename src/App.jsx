import { useState, useRef, useEffect } from 'react';
import { io } from 'socket.io-client';
import SimplePeer from 'simple-peer';

const SOCKET_URL = window.location.origin;

export default function App() {
  // Check localStorage for saved username
  const savedUsername = localStorage.getItem('voiceapp_username');
  const [view, setView] = useState(savedUsername ? 'lobby' : 'username');
  const [username, setUsername] = useState(savedUsername || '');
  const [currentRoom, setCurrentRoom] = useState(null);
  const [rooms, setRooms] = useState([]);
  const [users, setUsers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [message, setMessage] = useState('');
  const [isMuted, setIsMuted] = useState(false);
  const [connected, setConnected] = useState(false);
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [newRoomName, setNewRoomName] = useState('');
  const [micLevel, setMicLevel] = useState(0);
  
  const socketRef = useRef();
  const streamRef = useRef();
  const audioContextRef = useRef();
  const analyserRef = useRef();
  const animationFrameRef = useRef();
  const peersRef = useRef({});
  const audioElementsRef = useRef({});

  // Connect to socket on mount
  useEffect(() => {
    const socket = io(SOCKET_URL);
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('Connected to server');
      setConnected(true);
      if (view === 'lobby') {
        socket.emit('get-rooms');
      }
    });

    socket.on('rooms-list', (roomList) => {
      setRooms(roomList);
    });

    socket.on('room-created', () => {
      socketRef.current.emit('get-rooms');
    });

    socket.on('room-created-success', ({ roomName }) => {
      setNewRoomName('');
      setShowCreateRoom(false);
      joinRoom(roomName);
    });

    socket.on('room-removed', () => {
      if (socketRef.current) {
        socketRef.current.emit('get-rooms');
      }
    });

    socket.on('room-updated', () => {
      if (socketRef.current) {
        socketRef.current.emit('get-rooms');
      }
    });

    socket.on('room-deleted', () => {
      alert('This room has been deleted by the creator');
      leaveRoom();
    });

    socket.on('users', (userList) => {
      console.log('Users updated:', userList);
      setUsers((prevUsers) => {
        const oldUserIds = prevUsers.map(u => u.id);
        const newUserIds = userList.map(u => u.id);
        
        // Create peer connections for new users (only if we have a stream)
        if (streamRef.current && socketRef.current) {
          newUserIds.forEach(userId => {
            if (!oldUserIds.includes(userId) && userId !== socketRef.current.id && !peersRef.current[userId]) {
              console.log('Creating peer for new user:', userId);
              createPeer(userId, true);
            }
          });
          
          // Remove peers for users who left
          oldUserIds.forEach(userId => {
            if (!newUserIds.includes(userId) && peersRef.current[userId]) {
              console.log('Destroying peer for user who left:', userId);
              peersRef.current[userId].destroy();
              delete peersRef.current[userId];
              if (audioElementsRef.current[userId]) {
                delete audioElementsRef.current[userId];
              }
            }
          });
        }
        
        return userList;
      });
    });

    socket.on('message', (msg) => {
      console.log('Message received:', msg);
      setMessages((msgs) => [...msgs, msg]);
    });

    // WebRTC signaling
    socket.on('offer', ({ from, offer, username: peerUsername }) => {
      console.log('Received offer from:', from);
      if (streamRef.current && !peersRef.current[from]) {
        createPeer(from, false, offer);
      }
    });

    socket.on('answer', ({ from, answer }) => {
      console.log('Received answer from:', from);
      if (peersRef.current[from]) {
        peersRef.current[from].signal(answer);
      }
    });

    socket.on('ice-candidate', ({ from, candidate }) => {
      console.log('Received ICE candidate from:', from);
      if (peersRef.current[from]) {
        peersRef.current[from].signal(candidate);
      }
    });

    socket.on('error', ({ message }) => {
      alert(message);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  // Handle muting
  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.getAudioTracks().forEach(track => {
        track.enabled = !isMuted;
      });
    }
  }, [isMuted]);

  function createPeer(userId, initiator, incomingOffer = null) {
    console.log(`Creating peer connection with ${userId}, initiator: ${initiator}`);
    
    if (!streamRef.current) {
      console.error('No stream available for peer connection');
      return;
    }
    
    // Check if peer already exists to prevent duplicates
    if (peersRef.current[userId]) {
      console.log('Peer already exists for:', userId);
      return;
    }
    
    const peer = new SimplePeer({
      initiator,
      stream: streamRef.current,
      trickle: true,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ]
      }
    });

    peer.on('signal', (signal) => {
      console.log(`Sending ${initiator ? 'offer' : 'answer'} to:`, userId);
      if (initiator) {
        socketRef.current.emit('offer', { to: userId, offer: signal });
      } else {
        socketRef.current.emit('answer', { to: userId, answer: signal });
      }
    });

    peer.on('stream', (remoteStream) => {
      console.log('Received remote stream from:', userId, remoteStream);
      
      // Create or update audio element for this peer
      if (!audioElementsRef.current[userId]) {
        const audio = new Audio();
        audio.srcObject = remoteStream;
        audio.volume = 1.0;
        audio.autoplay = true;
        audioElementsRef.current[userId] = audio;
        
        // Play the audio
        const playPromise = audio.play();
        if (playPromise !== undefined) {
          playPromise
            .then(() => {
              console.log('Audio playing for user:', userId);
            })
            .catch(err => {
              console.error('Error playing audio for user:', userId, err);
              // Try again after a short delay
              setTimeout(() => {
                audio.play().catch(e => console.error('Retry failed:', e));
              }, 100);
            });
        }
      }
    });

    peer.on('connect', () => {
      console.log('Peer connected:', userId);
    });

    peer.on('error', (err) => {
      console.error('Peer error with', userId, ':', err);
    });

    peer.on('close', () => {
      console.log('Peer connection closed:', userId);
      delete peersRef.current[userId];
      if (audioElementsRef.current[userId]) {
        audioElementsRef.current[userId].pause();
        audioElementsRef.current[userId].srcObject = null;
        delete audioElementsRef.current[userId];
      }
    });

    peersRef.current[userId] = peer;

    // If receiving an offer, signal it to the peer
    if (incomingOffer) {
      console.log('Signaling incoming offer to peer:', userId);
      peer.signal(incomingOffer);
    }
  }

  function playAudio(userId, audioData) {
    // No longer needed - audio comes through WebRTC streams
  }

  const handleSetUsername = (e) => {
    e.preventDefault();
    if (username.trim()) {
      localStorage.setItem('voiceapp_username', username.trim());
      setView('lobby');
      socketRef.current.emit('get-rooms');
    }
  };

  const createRoom = () => {
    if (newRoomName.trim()) {
      socketRef.current.emit('create-room', { roomName: newRoomName.trim(), user: username });
    }
  };

  const deleteRoom = (roomName) => {
    if (confirm(`Are you sure you want to delete room "${roomName}"?`)) {
      socketRef.current.emit('delete-room', { roomName, user: username });
    }
  };

  const joinRoom = (roomName) => {
    setCurrentRoom(roomName);
    setMessages([]);
    setUsers([]);
    
    console.log('Joining room:', roomName, 'as user:', username);
    
    navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      .then(stream => {
        console.log('Got user media');
        streamRef.current = stream;
        
        // Setup audio analysis for volume meter
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = audioContext.createAnalyser();
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);
        analyser.fftSize = 256;
        
        audioContextRef.current = audioContext;
        analyserRef.current = analyser;
        
        // Start monitoring microphone level
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const updateLevel = () => {
          analyser.getByteFrequencyData(dataArray);
          const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
          const normalizedLevel = Math.min(100, (average / 128) * 100);
          setMicLevel(normalizedLevel);
          animationFrameRef.current = requestAnimationFrame(updateLevel);
        };
        updateLevel();

        // Join the room via socket
        socketRef.current.emit('join', { room: roomName, user: username });
        setView('room');
      })
      .catch(err => {
        console.error('Error accessing microphone:', err);
        alert('Could not access microphone. Please allow microphone access.');
      });
  };

  const leaveRoom = () => {
    // Close all peer connections
    Object.values(peersRef.current).forEach(peer => {
      peer.destroy();
    });
    peersRef.current = {};
    audioElementsRef.current = {};
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    
    // Cleanup audio analysis
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
    }
    
    setMicLevel(0);
    setView('lobby');
    setCurrentRoom(null);
    setUsers([]);
    setMessages([]);
    socketRef.current.emit('get-rooms');
  };

  const handleSend = (e) => {
    e.preventDefault();
    console.log('Sending message:', message, 'username:', username, 'currentRoom:', currentRoom);
    if (message && socketRef.current) {
      socketRef.current.emit('message', message);
      setMessage('');
    }
  };

  const handleLogout = () => {
    if (currentRoom) {
      leaveRoom();
    }
    localStorage.removeItem('voiceapp_username');
    setUsername('');
    setView('username');
  };

  // Username entry view
  if (view === 'username') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-indigo-950 text-white flex flex-col items-center justify-center p-4 relative overflow-hidden">
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-20 left-10 w-72 h-72 bg-blue-500/10 rounded-full blur-3xl animate-pulse"></div>
          <div className="absolute bottom-20 right-10 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse delay-700"></div>
          <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-cyan-500/5 rounded-full blur-3xl"></div>
        </div>

        <div className="text-center mb-12 relative z-10 animate-fade-in">
          <div className="mb-6 inline-block">
            <div className="text-8xl mb-4 animate-bounce-slow">🎙️</div>
          </div>
          <h1 className="text-6xl font-black mb-4 bg-gradient-to-r from-blue-400 via-cyan-400 to-purple-400 bg-clip-text text-transparent">
            VoiceHub
          </h1>
          <p className="text-xl text-gray-300 font-light">Connect with friends instantly</p>
          <div className="flex gap-3 justify-center mt-6 text-sm text-gray-400">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></span>
              Private
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 bg-blue-400 rounded-full animate-pulse"></span>
              Instant
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 bg-purple-400 rounded-full animate-pulse"></span>
              HD Voice
            </span>
          </div>
        </div>

        <form onSubmit={handleSetUsername} className="relative z-10 w-full max-w-md">
          <div className="bg-gradient-to-br from-slate-800/90 to-slate-900/90 backdrop-blur-xl p-10 rounded-2xl shadow-2xl border border-slate-700/50 relative overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-br from-blue-500/5 to-purple-500/5"></div>
            <div className="relative z-10">
              <label className="block text-sm font-semibold text-gray-300 mb-3">What should we call you?</label>
              <input
                className="w-full p-4 rounded-xl bg-slate-900/50 border-2 border-slate-700 focus:outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/20 transition-all duration-300 text-white placeholder-gray-500"
                placeholder="Enter your name"
                value={username}
                onChange={e => setUsername(e.target.value)}
                required
                autoFocus
              />
              <button 
                className="w-full mt-6 bg-gradient-to-r from-blue-600 via-blue-500 to-cyan-500 hover:from-blue-700 hover:via-blue-600 hover:to-cyan-600 rounded-xl p-4 font-bold text-lg transition-all duration-300 shadow-lg hover:shadow-blue-500/50 hover:scale-105 transform" 
                type="submit"
              >
                Enter VoiceHub →
              </button>
            </div>
          </div>
        </form>

        <div className="mt-8 text-center text-sm text-gray-500 relative z-10">
          <p>Create rooms, chat with friends, no sign up needed</p>
        </div>
      </div>
    );
  }

  // Lobby view - same as before...
  if (view === 'lobby') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-indigo-950 text-white p-6 relative overflow-hidden">
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-0 left-1/4 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl animate-pulse"></div>
          <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse delay-1000"></div>
        </div>

        <div className="max-w-7xl mx-auto relative z-10">
          <div className="mb-10">
            <div className="flex justify-between items-start mb-6">
              <div className="flex-1">
                <div className="flex items-center gap-4 mb-3">
                  <div className="text-5xl">🎙️</div>
                  <h1 className="text-5xl font-black bg-gradient-to-r from-blue-400 via-cyan-400 to-purple-400 bg-clip-text text-transparent">
                    VoiceHub
                  </h1>
                </div>
                <div className="flex items-center gap-3 ml-1">
                  <div className="px-4 py-2 rounded-full bg-gradient-to-r from-blue-600/20 to-purple-600/20 border border-blue-500/30">
                    <span className="text-sm">👋 Welcome, </span>
                    <span className="text-sm font-bold text-blue-400">{username}</span>
                  </div>
                  <div className={`px-4 py-2 rounded-full ${connected ? 'bg-green-500/20 border-green-500/30' : 'bg-red-500/20 border-red-500/30'} border`}>
                    <span className="text-sm flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400'} animate-pulse`}></span>
                      {connected ? 'Connected' : 'Disconnected'}
                    </span>
                  </div>
                </div>
              </div>
              <button
                onClick={() => setShowCreateRoom(true)}
                className="group bg-gradient-to-r from-green-600 via-emerald-600 to-teal-600 hover:from-green-700 hover:via-emerald-700 hover:to-teal-700 rounded-xl px-8 py-4 font-bold transition-all duration-300 shadow-xl hover:shadow-green-500/50 hover:scale-105 transform flex items-center gap-2"
              >
                <span className="text-2xl group-hover:rotate-90 transition-transform duration-300">+</span>
                <span>Create Room</span>
              </button>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="bg-gradient-to-br from-slate-800/60 to-slate-900/60 backdrop-blur-xl rounded-xl p-4 border border-slate-700/50">
                <div className="text-3xl font-bold text-blue-400">{rooms.length}</div>
                <div className="text-sm text-gray-400">Rooms Available</div>
              </div>
              <div className="bg-gradient-to-br from-slate-800/60 to-slate-900/60 backdrop-blur-xl rounded-xl p-4 border border-slate-700/50">
                <div className="text-3xl font-bold text-green-400">{rooms.reduce((acc, r) => acc + r.userCount, 0)}</div>
                <div className="text-sm text-gray-400">People Chatting</div>
              </div>
              <div className="bg-gradient-to-br from-slate-800/60 to-slate-900/60 backdrop-blur-xl rounded-xl p-4 border border-slate-700/50">
                <div className="text-3xl font-bold text-purple-400">Server</div>
                <div className="text-sm text-gray-400">Voice Mode</div>
              </div>
            </div>
          </div>

          {showCreateRoom && (
            <div className="fixed inset-0 bg-black/70 backdrop-blur-md flex items-center justify-center z-50 animate-fade-in" onClick={() => setShowCreateRoom(false)}>
              <div className="bg-gradient-to-br from-slate-800 to-slate-900 p-8 rounded-2xl shadow-2xl w-full max-w-md border-2 border-slate-700 transform animate-scale-in" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center gap-3 mb-6">
                  <div className="text-4xl">✨</div>
                  <h2 className="text-3xl font-bold bg-gradient-to-r from-green-400 to-cyan-400 bg-clip-text text-transparent">Create a Room</h2>
                </div>
                <div className="mb-6">
                  <label className="block text-sm font-semibold text-gray-300 mb-2">Name your room</label>
                  <input
                    className="w-full p-4 rounded-xl bg-slate-900/80 border-2 border-slate-700 focus:outline-none focus:border-green-500 focus:ring-4 focus:ring-green-500/20 transition-all text-white placeholder-gray-500"
                    placeholder="Friends Hangout"
                    value={newRoomName}
                    onChange={e => setNewRoomName(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowCreateRoom(false)}
                    className="flex-1 bg-slate-700 hover:bg-slate-600 rounded-xl p-4 font-semibold transition-all duration-300"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={createRoom}
                    className="flex-1 bg-gradient-to-r from-green-600 to-teal-600 hover:from-green-700 hover:to-teal-700 rounded-xl p-4 font-bold transition-all duration-300 shadow-lg hover:shadow-green-500/50"
                  >
                    Create Room
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {rooms.length === 0 ? (
              <div className="col-span-full">
                <div className="bg-gradient-to-br from-slate-800/40 to-slate-900/40 backdrop-blur-xl rounded-2xl p-16 text-center border border-slate-700/50">
                  <div className="text-7xl mb-6 opacity-50">🎭</div>
                  <p className="text-2xl font-bold text-gray-300 mb-2">No rooms yet</p>
                  <p className="text-gray-400 mb-8">Create one and invite your friends to join!</p>
                  <button
                    onClick={() => setShowCreateRoom(true)}
                    className="bg-gradient-to-r from-green-600 to-teal-600 hover:from-green-700 hover:to-teal-700 rounded-xl px-8 py-3 font-bold transition-all duration-300 shadow-lg hover:shadow-green-500/50 inline-flex items-center gap-2"
                  >
                    <span className="text-xl">+</span>
                    <span>Create Your First Room</span>
                  </button>
                </div>
              </div>
            ) : (
              rooms.map((room, idx) => (
                <div 
                  key={room.name} 
                  className="group bg-gradient-to-br from-slate-800/80 to-slate-900/80 backdrop-blur-xl rounded-2xl p-6 border-2 border-slate-700/50 hover:border-blue-500/50 transition-all duration-300 shadow-xl hover:shadow-blue-500/30 hover:scale-105 transform cursor-pointer"
                  style={{ animationDelay: `${idx * 50}ms` }}
                >
                  <div className="flex justify-between items-start mb-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-3 h-3 bg-green-400 rounded-full animate-pulse"></div>
                        <h3 className="text-2xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-cyan-400 group-hover:from-cyan-400 group-hover:to-purple-400 transition-all">
                          {room.name}
                        </h3>
                      </div>
                      <div className="flex items-center gap-2 text-sm text-gray-400">
                        <span>👤</span>
                        <span>{room.creator}</span>
                      </div>
                    </div>
                    {room.creator === username && (
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteRoom(room.name); }}
                        className="text-2xl hover:scale-125 transition-transform duration-300 opacity-60 hover:opacity-100"
                        title="Delete room"
                      >
                        🗑️
                      </button>
                    )}
                  </div>
                  
                  <div className="flex items-center justify-between pt-4 border-t border-slate-700/50">
                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-900/50">
                      <span className="text-xl">👥</span>
                      <span className="font-bold text-green-400">{room.userCount}</span>
                      <span className="text-sm text-gray-400">online</span>
                    </div>
                    <button
                      onClick={() => joinRoom(room.name)}
                      className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 rounded-xl px-6 py-2 font-bold transition-all duration-300 shadow-lg group-hover:shadow-blue-500/50 flex items-center gap-2"
                    >
                      <span>Join</span>
                      <span className="group-hover:translate-x-1 transition-transform">→</span>
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    );
  }

  // Room view - same UI, no P2P code
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-indigo-950 text-white p-6 relative overflow-hidden">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-20 right-20 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl animate-pulse"></div>
        <div className="absolute bottom-20 left-20 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse delay-1000"></div>
      </div>

      <div className="max-w-7xl mx-auto relative z-10">
        <div className="bg-gradient-to-br from-slate-800/80 to-slate-900/80 backdrop-blur-xl rounded-2xl p-6 mb-6 border-2 border-slate-700/50 shadow-2xl">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="text-4xl">🎙️</div>
              <div>
                <div className="text-sm text-gray-400 mb-1">You're in</div>
                <h2 className="text-3xl font-black bg-gradient-to-r from-blue-400 via-cyan-400 to-purple-400 bg-clip-text text-transparent">
                  {currentRoom}
                </h2>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className={`px-4 py-2 rounded-full ${connected ? 'bg-green-500/20 border-green-500/30' : 'bg-red-500/20 border-red-500/30'} border flex items-center gap-2`}>
                <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400'} animate-pulse`}></span>
                <span className="text-sm font-semibold">{connected ? 'Connected' : 'Disconnected'}</span>
              </div>
              <button 
                className="bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-700 hover:to-rose-700 rounded-xl px-6 py-3 font-bold transition-all duration-300 shadow-lg hover:shadow-red-500/50 flex items-center gap-2 group" 
                onClick={leaveRoom}
              >
                <span className="group-hover:-translate-x-1 transition-transform">←</span>
                <span>Leave Room</span>
              </button>
            </div>
          </div>
        </div>
        
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 mb-6">
          <div className="lg:col-span-1 bg-gradient-to-br from-slate-800/80 to-slate-900/80 backdrop-blur-xl rounded-2xl p-6 border-2 border-slate-700/50 shadow-xl">
            <div className="flex items-center gap-3 mb-6">
              <div className="text-3xl">👥</div>
              <div className="flex-1">
                <h2 className="font-bold text-xl text-white">In this room</h2>
                <p className="text-sm text-blue-400">{users.length} {users.length === 1 ? 'person' : 'people'}</p>
              </div>
            </div>
            <div className="space-y-3 max-h-[500px] overflow-y-auto custom-scrollbar">
              {users.map((u, idx) => (
                <div 
                  key={u.id} 
                  className="group flex items-center gap-3 bg-gradient-to-r from-slate-700/30 to-slate-800/30 hover:from-slate-700/60 hover:to-slate-800/60 p-4 rounded-xl transition-all duration-300 border border-slate-700/30 hover:border-blue-500/50"
                  style={{ animationDelay: `${idx * 50}ms` }}
                >
                  <div className="relative">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center font-bold text-white">
                      {u.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-green-400 rounded-full border-2 border-slate-900 animate-pulse"></div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-white truncate">{u.name}</div>
                    {u.id === socketRef.current?.id && (
                      <div className="text-xs bg-blue-600 px-2 py-0.5 rounded inline-block mt-1">You</div>
                    )}
                  </div>
                  <div className="text-xl group-hover:scale-125 transition-transform">🎤</div>
                </div>
              ))}
            </div>
          </div>
          
          <div className="lg:col-span-3 bg-gradient-to-br from-slate-800/80 to-slate-900/80 backdrop-blur-xl rounded-2xl p-6 border-2 border-slate-700/50 shadow-xl flex flex-col">
            <div className="flex items-center gap-3 mb-6">
              <div className="text-3xl">💬</div>
              <div className="flex-1">
                <h2 className="font-bold text-xl text-white">Chat</h2>
                <p className="text-sm text-gray-400">Send a message to everyone</p>
              </div>
            </div>
            
            <div className="flex-1 overflow-y-auto mb-4 space-y-3 min-h-[400px] max-h-[400px] custom-scrollbar pr-2">
              {messages.map((m, i) => (
                <div 
                  key={i} 
                  className={`animate-slide-in ${m.user === 'system' ? 'text-center' : ''}`}
                  style={{ animationDelay: `${i * 20}ms` }}
                >
                  {m.user === 'system' ? (
                    <div className="inline-block px-4 py-2 rounded-full bg-slate-700/30 text-gray-400 text-sm italic">
                      {m.text}
                    </div>
                  ) : (
                    <div className="flex items-start gap-3 group">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-cyan-500 to-blue-500 flex items-center justify-center font-bold text-white text-sm flex-shrink-0">
                        {m.user.charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 bg-gradient-to-br from-slate-700/50 to-slate-800/50 rounded-2xl rounded-tl-none p-4 border border-slate-700/30 group-hover:border-blue-500/30 transition-all">
                        <div className="font-bold text-blue-400 mb-1 text-sm">{m.user}</div>
                        <div className="text-white break-words">{m.text}</div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <form onSubmit={handleSend} className="flex gap-3">
              <input
                className="flex-1 p-4 rounded-xl bg-slate-900/80 border-2 border-slate-700 focus:outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/20 transition-all text-white placeholder-gray-500"
                placeholder="Say something..."
                value={message}
                onChange={e => setMessage(e.target.value)}
              />
              <button 
                className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 rounded-xl px-8 py-4 font-bold transition-all duration-300 shadow-lg hover:shadow-blue-500/50 flex items-center gap-2 group" 
                type="submit"
              >
                <span>Send</span>
                <span className="group-hover:translate-x-1 transition-transform">→</span>
              </button>
            </form>
          </div>
        </div>
        
        <div className="bg-gradient-to-br from-slate-800/80 to-slate-900/80 backdrop-blur-xl rounded-2xl p-8 border-2 border-slate-700/50 shadow-xl">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-6">
              <div className="text-5xl">{isMuted ? '🔇' : '🎤'}</div>
              <div>
                <h3 className="text-2xl font-bold text-white mb-1">Your Microphone</h3>
                <p className="text-gray-400">
                  {isMuted ? 'Currently muted' : 'Broadcasting to server'}
                </p>
              </div>
            </div>
            <button
              className={`rounded-xl px-10 py-5 font-bold text-lg transition-all duration-300 shadow-xl flex items-center gap-3 ${
                isMuted 
                  ? 'bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-700 hover:to-rose-700 hover:shadow-red-500/50' 
                  : 'bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 hover:shadow-green-500/50'
              } hover:scale-105 transform`}
              onClick={() => setIsMuted(m => !m)}
            >
              <span className="text-2xl">{isMuted ? '🔇' : '🎤'}</span>
              <span>{isMuted ? 'Turn On' : 'Turn Off'}</span>
            </button>
          </div>
          
          <div className="mt-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-gray-400">Volume Level</span>
              <span className="text-sm font-mono text-blue-400">{Math.round(micLevel)}%</span>
            </div>
            <div className="h-4 bg-slate-900/80 rounded-full overflow-hidden border-2 border-slate-700/50">
              <div 
                className={`h-full transition-all duration-75 rounded-full ${
                  isMuted 
                    ? 'bg-gradient-to-r from-gray-600 to-gray-700'
                    : micLevel > 70 
                      ? 'bg-gradient-to-r from-green-500 via-yellow-500 to-red-500'
                      : micLevel > 30
                        ? 'bg-gradient-to-r from-green-500 to-yellow-500'
                        : 'bg-gradient-to-r from-green-600 to-green-500'
                } shadow-lg`}
                style={{ 
                  width: `${isMuted ? 0 : micLevel}%`,
                  boxShadow: isMuted ? 'none' : '0 0 20px rgba(34, 197, 94, 0.5)'
                }}
              />
            </div>
            <div className="flex justify-between mt-1 text-xs text-gray-500">
              <span>Quiet</span>
              <span>Loud</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
