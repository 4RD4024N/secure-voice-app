import { useState, useRef, useEffect } from 'react';
import { io } from 'socket.io-client';

const SOCKET_URL = window.location.origin;

export default function App() {
  const savedUsername = localStorage.getItem('voiceapp_username') || '';
  const [view, setView] = useState('username');
  const [username, setUsername] = useState(savedUsername);
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
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [screenSharer, setScreenSharer] = useState(null);
  
  const socketRef = useRef();
  const streamRef = useRef();
  const screenStreamRef = useRef();
  const audioContextRef = useRef();
  const analyserRef = useRef();
  const animationFrameRef = useRef();
  const peersRef = useRef({});
  const remoteStreamsRef = useRef({});
  const remoteVideoRef = useRef();

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
      setUsers(userList);
    });

    socket.on('message', (msg) => {
      console.log('Message received:', msg);
      setMessages((msgs) => [...msgs, msg]);
    });

    socket.on('user-joined', ({ userId }) => {
      console.log('User joined, creating offer for:', userId);
      createPeerConnection(userId, true);
    });

    socket.on('offer', async ({ from, offer }) => {
      console.log('Received offer from:', from);
      const pc = createPeerConnection(from, false);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', { to: from, answer });
    });

    socket.on('answer', async ({ from, answer }) => {
      console.log('Received answer from:', from);
      const pc = peersRef.current[from];
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      }
    });

    socket.on('ice-candidate', async ({ from, candidate }) => {
      const pc = peersRef.current[from];
      if (pc) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    });

    socket.on('screen-share-started', ({ userId, username: sharerName }) => {
      console.log('Screen sharing started by:', sharerName);
      setScreenSharer(sharerName);
    });

    socket.on('screen-share-stopped', () => {
      console.log('Screen sharing stopped');
      setScreenSharer(null);
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = null;
      }
    });

    socket.on('error', ({ message }) => {
      alert(message);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.getAudioTracks().forEach(track => {
        track.enabled = !isMuted;
      });
    }
  }, [isMuted]);

  function createPeerConnection(userId, isInitiator) {
    if (peersRef.current[userId]) {
      return peersRef.current[userId];
    }

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });

    peersRef.current[userId] = pc;

    // Add local stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, streamRef.current);
      });
    }

    // Handle incoming audio/video
    pc.ontrack = (event) => {
      console.log('Received remote track from:', userId, 'kind:', event.track.kind);
      const [remoteStream] = event.streams;
      remoteStreamsRef.current[userId] = remoteStream;
      
      if (event.track.kind === 'audio') {
        // Create audio element to play remote stream
        const audio = new Audio();
        audio.srcObject = remoteStream;
        audio.autoplay = true;
        audio.play().catch(e => console.log('Audio play error:', e));
      } else if (event.track.kind === 'video') {
        // Display screen share
        console.log('Received video track (screen share)');
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = remoteStream;
          remoteVideoRef.current.play().catch(e => console.log('Video play error:', e));
        }
      }
    };

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current.emit('ice-candidate', { to: userId, candidate: event.candidate });
      }
    };

    // Create offer if initiator
    if (isInitiator) {
      pc.createOffer().then(offer => {
        pc.setLocalDescription(offer);
        socketRef.current.emit('offer', { to: userId, offer });
      });
    }

    return pc;
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
        
        // Resume AudioContext (required by browsers for user-initiated audio)
        if (audioContext.state === 'suspended') {
          audioContext.resume().then(() => {
            console.log('AudioContext resumed, state:', audioContext.state);
          });
        }
        
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

        // Join the room via socket - WebRTC connections will be created automatically
        socketRef.current.emit('join', { room: roomName, user: username });
        setView('room');
      })
      .catch(err => {
        console.error('Error accessing microphone:', err);
        alert('Could not access microphone. Please allow microphone access.');
      });
  };

  const leaveRoom = () => {
    // Stop screen sharing if active
    if (isScreenSharing) {
      stopScreenShare();
    }
    
    // Cleanup peer connections
    Object.values(peersRef.current).forEach(pc => {
      pc.close();
    });
    peersRef.current = {};
    remoteStreamsRef.current = {};
    
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
    setScreenSharer(null);
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

  const startScreenShare = async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ 
        video: { cursor: 'always' }, 
        audio: false 
      });
      
      screenStreamRef.current = screenStream;
      setIsScreenSharing(true);
      
      // Notify others that screen sharing started
      socketRef.current.emit('screen-share-started', { username });
      
      // Add screen track to all existing peer connections and renegotiate
      for (const [userId, pc] of Object.entries(peersRef.current)) {
        const videoTrack = screenStream.getVideoTracks()[0];
        const sender = pc.getSenders().find(s => s.track?.kind === 'video');
        
        if (sender) {
          await sender.replaceTrack(videoTrack);
        } else {
          pc.addTrack(videoTrack, screenStream);
        }
        
        // Renegotiate the connection to ensure video track is properly sent
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socketRef.current.emit('offer', { to: userId, offer });
        } catch (err) {
          console.error('Error renegotiating for user', userId, ':', err);
        }
      }
      
      // Handle when user stops sharing via browser UI
      screenStream.getVideoTracks()[0].onended = () => {
        stopScreenShare();
      };
      
    } catch (err) {
      console.error('Error starting screen share:', err);
      alert('Could not start screen sharing. Please allow screen access.');
    }
  };

  const stopScreenShare = () => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(track => track.stop());
      screenStreamRef.current = null;
    }
    
    setIsScreenSharing(false);
    socketRef.current.emit('screen-share-stopped');
    
    // Remove video tracks from all peer connections and renegotiate
    Object.entries(peersRef.current).forEach(async ([userId, pc]) => {
      const sender = pc.getSenders().find(s => s.track?.kind === 'video');
      if (sender) {
        try {
          pc.removeTrack(sender);
          // Renegotiate after removing track
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socketRef.current.emit('offer', { to: userId, offer });
        } catch (err) {
          console.error('Error renegotiating after removing video track for user', userId, ':', err);
        }
      }
    });
  };

  const handleLogout = () => {
    if (currentRoom) {
      leaveRoom();
    }
    localStorage.removeItem('voiceapp_username');
    setUsername('');
    setView('username');
  };

  if (view === 'username') {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-4">
        <div className="text-center mb-12">
          <div className="mb-6">
            <div className="text-6xl mb-4">🎙️</div>
          </div>
          <h1 className="text-4xl font-bold mb-4 text-white">
            VoiceHub
          </h1>
          <p className="text-lg text-gray-300">Connect with friends instantly</p>
        </div>

        <form onSubmit={handleSetUsername} className="w-full max-w-md">
          <div className="bg-gray-800 p-8 rounded-lg shadow-lg border border-gray-700">
            <label className="block text-sm font-medium text-gray-300 mb-3">What should we call you?</label>
            <input
              className="w-full p-3 rounded-lg bg-gray-700 border border-gray-600 focus:outline-none focus:border-blue-500 text-white placeholder-gray-400"
              placeholder="Enter your name"
              value={username}
              onChange={e => setUsername(e.target.value)}
              required
              autoFocus
            />
            <button 
              className="w-full mt-4 bg-blue-600 hover:bg-blue-700 rounded-lg p-3 font-medium transition-colors" 
              type="submit"
            >
              Enter VoiceHub
            </button>
          </div>
        </form>

        <div className="mt-6 text-center text-sm text-gray-500">
          <p>Create rooms, chat with friends, no sign up needed</p>
        </div>
      </div>
    );
  }

  if (view === 'lobby') {
    return (
      <div className="min-h-screen bg-gray-900 text-white p-6">
        <div className="max-w-6xl mx-auto">
          <div className="mb-8">
            <div className="flex justify-between items-start mb-6">
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-3">
                  <div className="text-3xl">🎙️</div>
                  <h1 className="text-3xl font-bold text-white">
                    VoiceHub
                  </h1>
                </div>
                <div className="flex items-center gap-3">
                  <div className="px-3 py-1 rounded-full bg-gray-700 border border-gray-600">
                    <span className="text-sm">Welcome, </span>
                    <span className="text-sm font-medium text-blue-400">{username}</span>
                  </div>
                  <div className={`px-3 py-1 rounded-full ${connected ? 'bg-green-900 border-green-700' : 'bg-red-900 border-red-700'} border`}>
                    <span className="text-sm flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400'}`}></span>
                      {connected ? 'Connected' : 'Disconnected'}
                    </span>
                  </div>
                  <button
                    onClick={handleLogout}
                    className="bg-red-600 hover:bg-red-700 rounded-lg px-3 py-1 text-sm font-medium transition-colors"
                  >
                    Logout
                  </button>
                </div>
              </div>
              <button
                onClick={() => setShowCreateRoom(true)}
                className="bg-blue-600 hover:bg-blue-700 rounded-lg px-4 py-2 font-medium transition-colors flex items-center gap-2"
              >
                <span>+</span>
                <span>Create Room</span>
              </button>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
                <div className="text-2xl font-bold text-blue-400">{rooms.length}</div>
                <div className="text-sm text-gray-400">Rooms Available</div>
              </div>
              <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
                <div className="text-2xl font-bold text-green-400">{rooms.reduce((acc, r) => acc + r.userCount, 0)}</div>
                <div className="text-sm text-gray-400">People Chatting</div>
              </div>
              <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
                <div className="text-2xl font-bold text-purple-400">Server</div>
                <div className="text-sm text-gray-400">Voice Mode</div>
              </div>
            </div>
          </div>

          {showCreateRoom && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowCreateRoom(false)}>
              <div className="bg-gray-800 p-6 rounded-lg shadow-lg w-full max-w-md border border-gray-700" onClick={(e) => e.stopPropagation()}>
                <h2 className="text-xl font-bold mb-4 text-white">Create a Room</h2>
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-300 mb-2">Room name</label>
                  <input
                    className="w-full p-3 rounded-lg bg-gray-700 border border-gray-600 focus:outline-none focus:border-blue-500 text-white placeholder-gray-400"
                    placeholder="Friends Hangout"
                    value={newRoomName}
                    onChange={e => setNewRoomName(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowCreateRoom(false)}
                    className="flex-1 bg-gray-600 hover:bg-gray-500 rounded-lg p-3 font-medium transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={createRoom}
                    className="flex-1 bg-blue-600 hover:bg-blue-700 rounded-lg p-3 font-medium transition-colors"
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
                <div className="bg-gray-800 rounded-lg p-12 text-center border border-gray-700">
                  <div className="text-4xl mb-4">🎭</div>
                  <p className="text-lg font-medium text-gray-300 mb-2">No rooms yet</p>
                  <p className="text-gray-400 mb-6">Create one and invite your friends to join!</p>
                  <button
                    onClick={() => setShowCreateRoom(true)}
                    className="bg-blue-600 hover:bg-blue-700 rounded-lg px-6 py-3 font-medium transition-colors inline-flex items-center gap-2"
                  >
                    <span>+</span>
                    <span>Create Your First Room</span>
                  </button>
                </div>
              </div>
            ) : (
              rooms.map((room, idx) => (
                <div 
                  key={room.name} 
                  className="bg-gray-800 rounded-lg p-4 border border-gray-700 hover:border-blue-500 transition-colors cursor-pointer"
                >
                  <div className="flex justify-between items-start mb-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-2 h-2 bg-green-400 rounded-full"></div>
                        <h3 className="text-lg font-bold text-white">
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
                        className="text-red-400 hover:text-red-300 transition-colors"
                        title="Delete room"
                      >
                        🗑️
                      </button>
                    )}
                  </div>
                  
                  <div className="flex items-center justify-between pt-3 border-t border-gray-700">
                    <div className="flex items-center gap-2 px-2 py-1 rounded bg-gray-700">
                      <span>👥</span>
                      <span className="font-medium text-green-400">{room.userCount}</span>
                      <span className="text-sm text-gray-400">online</span>
                    </div>
                    <button
                      onClick={() => joinRoom(room.name)}
                      className="bg-blue-600 hover:bg-blue-700 rounded-lg px-4 py-2 font-medium transition-colors"
                    >
                      Join
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

  if (view === 'room') {
    return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      <div className="max-w-6xl mx-auto">
        <div className="bg-gray-800 rounded-lg p-4 mb-6 border border-gray-700">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="text-3xl">🎙️</div>
              <div>
                <div className="text-sm text-gray-400 mb-1">You're in</div>
                <h2 className="text-xl font-bold text-white">
                  {currentRoom}
                </h2>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className={`px-3 py-1 rounded-full ${connected ? 'bg-green-900 border-green-700' : 'bg-red-900 border-red-700'} border flex items-center gap-2`}>
                <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400'}`}></span>
                <span className="text-sm">{connected ? 'Connected' : 'Disconnected'}</span>
              </div>
              <button 
                className="bg-red-600 hover:bg-red-700 rounded-lg px-4 py-2 font-medium transition-colors" 
                onClick={leaveRoom}
              >
                Leave Room
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
          
          <div className="lg:col-span-3 bg-gray-800 rounded-lg p-4 border border-gray-700 flex flex-col">
            <div className="flex items-center gap-3 mb-4">
              <div className="text-2xl">💬</div>
              <div className="flex-1">
                <h2 className="font-bold text-lg text-white">Chat</h2>
                <p className="text-sm text-gray-400">Send a message to everyone</p>
              </div>
            </div>
            
            <div className="flex-1 overflow-y-auto mb-4 space-y-2 min-h-[400px] max-h-[400px] pr-2">
              {messages.map((m, i) => (
                <div key={i} className={m.user === 'system' ? 'text-center' : ''}>
                  {m.user === 'system' ? (
                    <div className="inline-block px-3 py-1 rounded-full bg-gray-700 text-gray-400 text-sm">
                      {m.text}
                    </div>
                  ) : (
                    <div className="flex items-start gap-2">
                      <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center font-bold text-white text-xs flex-shrink-0">
                        {m.user.charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 bg-gray-700 rounded-lg p-3">
                        <div className="font-medium text-blue-400 mb-1 text-sm">{m.user}</div>
                        <div className="text-white break-words">{m.text}</div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <form onSubmit={handleSend} className="flex gap-2">
              <input
                className="flex-1 p-3 rounded-lg bg-gray-700 border border-gray-600 focus:outline-none focus:border-blue-500 text-white placeholder-gray-400"
                placeholder="Say something..."
                value={message}
                onChange={e => setMessage(e.target.value)}
              />
              <button 
                className="bg-blue-600 hover:bg-blue-700 rounded-lg px-4 py-3 font-medium transition-colors" 
                type="submit"
              >
                Send
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
                  {isMuted ? 'Currently muted' : 'Broadcasting live'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <button
                onClick={isScreenSharing ? stopScreenShare : startScreenShare}
                className={`rounded-xl px-8 py-5 font-bold text-lg transition-all duration-300 shadow-xl flex items-center gap-3 ${
                  isScreenSharing 
                    ? 'bg-gradient-to-r from-orange-600 to-red-600 hover:from-orange-700 hover:to-red-700 hover:shadow-orange-500/50' 
                    : 'bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-700 hover:to-blue-700 hover:shadow-indigo-500/50'
                } hover:scale-105 transform`}
              >
                <span className="text-3xl">{isScreenSharing ? '🛑' : '🖥️'}</span>
                <span>{isScreenSharing ? 'Stop Sharing' : 'Share Screen'}</span>
              </button>
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
          
          <div className="mt-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-gray-400">Volume Level</span>
              <span className="text-sm text-gray-300">{Math.round(micLevel)}%</span>
            </div>
            <div className="h-3 bg-gray-700 rounded-full overflow-hidden border border-gray-600">
              <div 
                className={`h-full transition-all duration-75 rounded-full ${
                  isMuted 
                    ? 'bg-gray-500'
                    : micLevel > 70 
                      ? 'bg-red-500'
                      : micLevel > 30
                        ? 'bg-yellow-500'
                        : 'bg-green-500'
                }`}
                style={{ width: `${isMuted ? 0 : micLevel}%` }}
              />
            </div>
            <div className="flex justify-between mt-1 text-xs text-gray-500">
              <span>Quiet</span>
              <span>Loud</span>
            </div>
          </div>
        </div>
        
      
        {screenSharer && (
          <div className="mt-6 bg-gray-800 rounded-lg p-4 border border-gray-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="text-2xl">🖥️</div>
              <div>
                <h3 className="text-lg font-bold text-white">Screen Share</h3>
                <p className="text-sm text-gray-400">{screenSharer} is sharing their screen</p>
              </div>
            </div>
            <div className="bg-black rounded-lg overflow-hidden border border-gray-600">
              <video 
                ref={remoteVideoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-auto max-h-[600px] object-contain"
              />
            </div>
          </div>
        )}
      </div>
    </div>
    </div>
    );
  }

  return null;
}