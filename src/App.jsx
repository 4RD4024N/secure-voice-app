import { useState, useRef, useEffect } from 'react';
import { io } from 'socket.io-client';
import { DeepFilterNet3Core } from 'deepfilternet3-noise-filter';

const SOCKET_URL = window.location.origin;

// DeepFilterNet3 model + WASM are self-hosted under public/deepfilternet3/v3/.
// The core is created once and reused across room joins so the ~24 MB of
// assets are only fetched and compiled once per page load.
let dfCorePromise = null;
const getDeepFilterCore = () => {
  if (!dfCorePromise) {
    const core = new DeepFilterNet3Core({
      sampleRate: 48000,
      noiseReductionLevel: 80,
      assetConfig: { cdnUrl: '/deepfilternet3' },
    });
    dfCorePromise = core.initialize().then(() => core).catch(err => {
      dfCorePromise = null;
      throw err;
    });
  }
  return dfCorePromise;
};

// Slider value (0.1–1) → DeepFilterNet attenuation limit in dB (10–100)
const toAttenDb = (level) => Math.round(level * 100);

const micConstraints = (deviceId) => ({
  audio: {
    ...(deviceId && { deviceId: { exact: deviceId } }),
    echoCancellation: true,
    // Browser NS is turned off: stacking it in front of DeepFilterNet
    // produces warbly artifacts. It is re-enabled if DFN fails.
    noiseSuppression: false,
    autoGainControl: true,
    channelCount: 1,
    sampleRate: 48000,
    sampleSize: 16,
  },
  video: false,
});

// Falls back to the system default if the saved device was unplugged
const getMicStream = (deviceId) =>
  navigator.mediaDevices.getUserMedia(micConstraints(deviceId)).catch(err => {
    if (!deviceId) throw err;
    return navigator.mediaDevices.getUserMedia(micConstraints(null));
  });

// Device ids are empty until mic permission is granted, so those are skipped
const listAudioDevices = async () => {
  const list = await navigator.mediaDevices.enumerateDevices();
  return {
    inputs:  list.filter(d => d.kind === 'audioinput'  && d.deviceId),
    outputs: list.filter(d => d.kind === 'audiooutput' && d.deviceId),
  };
};

const canPickSpeaker = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

// Reads RTT / packet loss / jitter for one peer. `prev` holds the previous
// cumulative packet counters so loss is measured over the last interval only.
const readPeerStats = async (pc, prev) => {
  const report = await pc.getStats();
  let transport, pair;
  let lost = 0, received = 0, jitter = 0;
  report.forEach(s => {
    if (s.type === 'transport') transport = s;
    else if (s.type === 'candidate-pair' && (s.selected || (s.nominated && s.state === 'succeeded'))) pair = s;
    else if (s.type === 'inbound-rtp' && s.kind === 'audio') {
      lost     += s.packetsLost     || 0;
      received += s.packetsReceived || 0;
      jitter    = Math.max(jitter, s.jitter || 0);
    }
  });
  if (transport?.selectedCandidatePairId) pair = report.get(transport.selectedCandidatePairId) || pair;

  const dLost = lost - (prev?.lost ?? 0);
  const dRecv = received - (prev?.received ?? 0);
  return {
    state:  pc.iceConnectionState,
    rtt:    pair?.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
    loss:   dLost + dRecv > 0 ? Math.max(0, (dLost / (dLost + dRecv)) * 100) : 0,
    jitter: Math.round(jitter * 1000),
    counters: { lost, received },
  };
};

const rateConnection = (s) => {
  if (!s) return null;
  if (s.state === 'failed' || s.state === 'disconnected') return 'poor';
  if (s.rtt == null) return null;
  if (s.rtt < 150 && s.loss < 2 && s.jitter < 30) return 'good';
  if (s.rtt < 300 && s.loss < 5 && s.jitter < 60) return 'fair';
  return 'poor';
};

function SignalBars({ stats }) {
  const quality = rateConnection(stats);
  const level   = { good: 3, fair: 2, poor: 1 }[quality] ?? 0;
  const color   = { good: 'bg-emerald-400', fair: 'bg-amber-400', poor: 'bg-red-400' }[quality];
  const title   = !stats ? 'Connecting…'
    : stats.rtt == null ? `Connection: ${stats.state}`
    : `Ping ${stats.rtt} ms · Loss ${stats.loss.toFixed(1)}% · Jitter ${stats.jitter} ms`;

  return (
    <div className="ml-auto flex items-center gap-1.5" title={title}>
      {stats?.rtt != null && (
        <span className="text-[10px] text-white/25 tabular-nums">{stats.rtt} ms</span>
      )}
      <div className="flex items-end gap-[2px] h-3">
        {[4, 8, 12].map((h, i) => (
          <div key={h} className={`w-[3px] rounded-full ${i < level ? color : 'bg-white/10'}`} style={{ height: h }}/>
        ))}
      </div>
    </div>
  );
}

function DeviceSelect({ label, value, devices, onChange }) {
  return (
    <label className="block">
      <span className="block text-xs text-white/25 mb-1">{label}</span>
      <select
        value={devices.some(d => d.deviceId === value) ? value : ''}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-white/5 border border-white/8 rounded-lg px-2.5 py-1.5 text-xs text-white/70 focus:outline-none focus:border-white/20 transition-colors cursor-pointer"
      >
        <option value="" className="bg-[#1a1a1a]">System default</option>
        {devices.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId} className="bg-[#1a1a1a]">
            {d.label || `${label} ${i + 1}`}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function App() {
  const savedUsername = localStorage.getItem('voiceapp_username') || '';
  const [view, setView]           = useState(savedUsername ? 'lobby' : 'username');
  const [username, setUsername]   = useState(savedUsername);
  const [currentRoom, setCurrentRoom] = useState(null);
  const [rooms, setRooms]         = useState([]);
  const [users, setUsers]         = useState([]);
  const [messages, setMessages]   = useState([]);
  const [message, setMessage]     = useState('');
  const [isMuted, setIsMuted]     = useState(false);
  const [connected, setConnected] = useState(false);
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [newRoomName, setNewRoomName] = useState('');
  const [micLevel, setMicLevel]   = useState(0);
  const [isScreenSharing, setIsScreenSharing]     = useState(false);
  const [screenSharer, setScreenSharer]           = useState(null);
  const [isNoiseCancellationEnabled, setIsNoiseCancellationEnabled] = useState(true);
  const [noiseReductionLevel, setNoiseReductionLevel] = useState(0.8);
  const [socketId, setSocketId]   = useState(null);
  const [audioInputs, setAudioInputs]   = useState([]);
  const [audioOutputs, setAudioOutputs] = useState([]);
  const [selectedMic, setSelectedMic]         = useState(localStorage.getItem('voiceapp_mic') || '');
  const [selectedSpeaker, setSelectedSpeaker] = useState(localStorage.getItem('voiceapp_speaker') || '');
  const [peerStats, setPeerStats] = useState({}); // userId -> { rtt, loss, jitter, state }

  const socketRef           = useRef();
  const streamRef           = useRef();
  const processedStreamRef  = useRef();
  const screenStreamRef     = useRef();
  const audioContextRef     = useRef();
  const analyserRef         = useRef();
  const animationFrameRef   = useRef();
  const peersRef            = useRef({});
  const remoteStreamsRef    = useRef({});
  const remoteAudioRef      = useRef({});
  const screenSendersRef    = useRef({}); // userId -> RTCRtpSender[] for screen tracks
  const remoteVideoRef      = useRef();
  const gainNodeRef         = useRef();
  const processorRef        = useRef();
  const dfCoreRef           = useRef(null); // set while the DeepFilterNet node is active
  const sourceRef           = useRef(null); // mic source node; swapped on device change
  const speakerRef          = useRef(selectedSpeaker);
  const statsCountersRef    = useRef({});   // userId -> cumulative packet counters
  const viewRef            = useRef(view);
  const joinRoomRef         = useRef(null);
  const leaveRoomRef        = useRef(null);
  useEffect(() => { viewRef.current = view; }, [view]);

  // ── Socket + WebRTC setup ──────────────────────────────────────────────────
  useEffect(() => {
    const socket = io(SOCKET_URL);
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      setSocketId(socket.id);
      if (viewRef.current === 'lobby') socket.emit('get-rooms');
    });

    socket.on('rooms-list',    (list) => setRooms(list));
    socket.on('room-created',  ()     => socketRef.current.emit('get-rooms'));
    socket.on('room-removed',  ()     => socketRef.current?.emit('get-rooms'));
    socket.on('room-updated',  ()     => socketRef.current?.emit('get-rooms'));

    socket.on('room-created-success', ({ roomName }) => {
      setNewRoomName('');
      setShowCreateRoom(false);
      joinRoomRef.current(roomName);
    });

    socket.on('room-deleted', () => {
      alert('This room has been deleted by the creator.');
      leaveRoomRef.current();
    });

    socket.on('users',   (list) => setUsers(list));
    socket.on('message', (msg)  => setMessages(prev => [...prev, msg]));

    function createPeerConnection(userId, isInitiator) {
      if (peersRef.current[userId]) return peersRef.current[userId];

      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      });

      peersRef.current[userId] = pc;

      const streamToUse = processedStreamRef.current || streamRef.current;
      if (streamToUse) streamToUse.getTracks().forEach(t => pc.addTrack(t, streamToUse));

      // If we're mid-screen-share, the newcomer needs those tracks too
      if (screenStreamRef.current) {
        screenSendersRef.current[userId] =
          screenStreamRef.current.getTracks().map(t => pc.addTrack(t, screenStreamRef.current));
      }

      pc.ontrack = (event) => {
        const track = event.track;

        if (track.kind === 'audio') {
          // One Audio element per track (not per peer): mic and screen audio
          // arrive as separate tracks and must play simultaneously.
          const key = `${userId}:${track.id}`;
          let audio = remoteAudioRef.current[key];
          if (!audio) {
            audio = new Audio();
            audio.autoplay = true;
            remoteAudioRef.current[key] = audio;
            if (canPickSpeaker && speakerRef.current)
              audio.setSinkId(speakerRef.current).catch(() => {});
          }
          audio.srcObject = new MediaStream([track]);
          audio.play().catch(() => {});

          // When the sharer stops, the track ends — release its element
          track.onended = () => {
            const a = remoteAudioRef.current[key];
            if (a) { a.srcObject = null; delete remoteAudioRef.current[key]; }
          };

        } else if (track.kind === 'video') {
          if (remoteVideoRef.current) {
            const videoStream = new MediaStream([track]);
            remoteVideoRef.current.srcObject = videoStream;
            remoteVideoRef.current.play().catch(() => {});
          }
        }
      };

      pc.onicecandidate = (event) => {
        if (event.candidate)
          socketRef.current?.emit('ice-candidate', { to: userId, candidate: event.candidate });
      };

      pc.oniceconnectionstatechange = () =>
        console.log(`[${userId.slice(0,6)}] ICE:`, pc.iceConnectionState);

      if (isInitiator) {
        pc.createOffer().then(offer => {
          pc.setLocalDescription(offer);
          socketRef.current.emit('offer', { to: userId, offer });
        });
      }

      return pc;
    }

    socket.on('user-joined', ({ userId }) => createPeerConnection(userId, true));

    socket.on('user-left', ({ userId }) => {
      const pc = peersRef.current[userId];
      if (pc) { pc.close(); delete peersRef.current[userId]; }
      delete remoteStreamsRef.current[userId];
      Object.keys(remoteAudioRef.current)
        .filter(k => k.startsWith(`${userId}:`))
        .forEach(k => {
          remoteAudioRef.current[k].srcObject = null;
          delete remoteAudioRef.current[k];
        });
      delete screenSendersRef.current[userId];
    });

    socket.on('offer', async ({ from, offer }) => {
      const pc = createPeerConnection(from, false);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', { to: from, answer });
    });

    socket.on('answer', async ({ from, answer }) => {
      const pc = peersRef.current[from];
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
    });

    socket.on('ice-candidate', async ({ from, candidate }) => {
      const pc = peersRef.current[from];
      if (pc) {
        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
        catch (e) { console.error('addIceCandidate:', e); }
      }
    });

    socket.on('screen-share-started', ({ username: name }) => setScreenSharer(name));
    socket.on('screen-share-stopped', () => {
      setScreenSharer(null);
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    });

    socket.on('error', ({ message: msg }) => alert(msg));

    return () => socket.disconnect();
  }, []);

  useEffect(() => {
    if (streamRef.current)
      streamRef.current.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
  }, [isMuted]);

  // ── Audio devices ─────────────────────────────────────────────────────────
  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md?.enumerateDevices) return;
    const refresh = () => listAudioDevices().then(({ inputs, outputs }) => {
      setAudioInputs(inputs);
      setAudioOutputs(outputs);
    }).catch(() => {});
    refresh();
    md.addEventListener('devicechange', refresh);
    return () => md.removeEventListener('devicechange', refresh);
  }, [view]); // re-list after joining a room: labels appear once mic permission is granted

  const switchMic = async (deviceId) => {
    setSelectedMic(deviceId);
    localStorage.setItem('voiceapp_mic', deviceId);
    const ctx = audioContextRef.current;
    if (!ctx || ctx.state === 'closed' || !gainNodeRef.current) return;

    try {
      const stream = await getMicStream(deviceId);
      stream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
      if (!dfCoreRef.current)
        stream.getAudioTracks()[0]?.applyConstraints({ noiseSuppression: true }).catch(() => {});

      // Only the source node changes; the processed track sent to peers
      // stays the same, so no renegotiation is needed.
      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current?.disconnect();
      source.connect(gainNodeRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current = stream;
      sourceRef.current = source;
    } catch (err) {
      console.error('Mic switch failed:', err);
      alert('Could not switch microphone.');
    }
  };

  const switchSpeaker = (deviceId) => {
    setSelectedSpeaker(deviceId);
    speakerRef.current = deviceId;
    localStorage.setItem('voiceapp_speaker', deviceId);
    Object.values(remoteAudioRef.current).forEach(a => a.setSinkId(deviceId).catch(() => {}));
  };

  // ── Connection quality ────────────────────────────────────────────────────
  useEffect(() => {
    if (view !== 'room') return;
    const id = setInterval(async () => {
      const entries = await Promise.all(
        Object.entries(peersRef.current).map(async ([userId, pc]) => {
          try { return [userId, await readPeerStats(pc, statsCountersRef.current[userId])]; }
          catch { return null; }
        })
      );
      const next = {};
      const counters = {};
      entries.filter(Boolean).forEach(([userId, s]) => {
        counters[userId] = s.counters;
        next[userId] = { rtt: s.rtt, loss: s.loss, jitter: s.jitter, state: s.state };
      });
      statsCountersRef.current = counters;
      setPeerStats(next);
    }, 2000);
    return () => {
      clearInterval(id);
      statsCountersRef.current = {};
      setPeerStats({});
    };
  }, [view]);

  // ── Room actions ──────────────────────────────────────────────────────────
  const handleSetUsername = (e) => {
    e.preventDefault();
    if (!username.trim()) return;
    localStorage.setItem('voiceapp_username', username.trim());
    setView('lobby');
    socketRef.current.emit('get-rooms');
  };

  const createRoom = () => {
    if (newRoomName.trim())
      socketRef.current.emit('create-room', { roomName: newRoomName.trim(), user: username });
  };

  const deleteRoom = (roomName) => {
    if (confirm(`Delete room "${roomName}"?`))
      socketRef.current.emit('delete-room', { roomName, user: username });
  };

  const buildFallbackGate = (audioContext) => {
    const sp = audioContext.createScriptProcessor(2048, 1, 1);
    const sr = audioContext.sampleRate;
    let gateGain    = 0;
    let holdSamples = 0;
    let noisePower  = 1e-6;
    const HOLD      = 0.25 * sr;
    const ATK       = 1 - Math.exp(-1 / (sr * 0.020)); // Increased from 0.005 to 0.020 (slower attack)
    const REL       = 1 - Math.exp(-1 / (sr * 0.150)); // Increased from 0.08 to 0.150 (slower release)
    const N_ATK     = 1 - Math.exp(-1 / (sr * 3.0)); // Increased from 2.0 (slower noise estimation attack)
    const N_REL     = 1 - Math.exp(-1 / (sr * 1.0)); // Increased from 0.5 (slower noise estimation release)

    sp.onaudioprocess = (ev) => {
      const inp = ev.inputBuffer.getChannelData(0);
      const out = ev.outputBuffer.getChannelData(0);
      let sumSq = 0;

      for (let i = 0; i < inp.length; i++) sumSq += inp[i] * inp[i];
      const rms = Math.sqrt(sumSq / inp.length);

      // Smooth noise floor estimation
      if (gateGain < 0.1) noisePower += N_ATK * (rms * rms - noisePower);
      else noisePower += N_REL * (Math.min(rms * rms * 0.05, noisePower) - noisePower);

      const snr = 20 * Math.log10((rms + 1e-10) / (Math.sqrt(Math.max(noisePower, 1e-10)) + 1e-10));

      let target;
      if (snr > 8) { holdSamples = HOLD; target = 1; }
      else if (holdSamples > 0) { holdSamples -= inp.length; target = 1; }
      else target = snr < 4 ? 0 : gateGain;

      for (let i = 0; i < inp.length; i++) {
        gateGain += (target > gateGain ? ATK : REL) * (target - gateGain);
        out[i] = inp[i] * gateGain;
      }
    };
    return sp;
  };

  const joinRoom = (roomName) => {
    setCurrentRoom(roomName);
    setMessages([]);
    setUsers([]);

    getMicStream(selectedMic)
      .then(async stream => {
        streamRef.current = stream;

        const audioContext = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: 48000,
        });
        if (audioContext.state === 'suspended') await audioContext.resume();

        const analyser   = audioContext.createAnalyser();
        const source     = audioContext.createMediaStreamSource(stream);
        const gainNode   = audioContext.createGain();
        const dest       = audioContext.createMediaStreamDestination();

        analyser.fftSize = 256;
        audioContextRef.current    = audioContext;
        analyserRef.current        = analyser;
        gainNodeRef.current        = gainNode;
        sourceRef.current          = source;

        gainNode.gain.value = 0.95; // Prevent clipping

        const connectChain = (middleNode) => {
          source.connect(gainNode);
          gainNode.connect(middleNode);
          middleNode.connect(analyser);
          middleNode.connect(dest);
        };

        // DeepFilterNet3 is always inserted so the toggle can bypass it live
        try {
          const core   = await getDeepFilterCore();
          const dfNode = await core.createAudioWorkletNode(audioContext);
          core.setSuppressionLevel(toAttenDb(noiseReductionLevel));
          core.setNoiseSuppressionEnabled(isNoiseCancellationEnabled);
          dfCoreRef.current    = core;
          processorRef.current = dfNode;
          connectChain(dfNode);
        } catch (err) {
          console.warn('[DeepFilterNet] init failed, using browser NS + fallback gate:', err);
          stream.getAudioTracks()[0]?.applyConstraints({ noiseSuppression: true }).catch(() => {});
          if (isNoiseCancellationEnabled) {
            const sp = buildFallbackGate(audioContext);
            processorRef.current = sp;
            connectChain(sp);
          } else {
            source.connect(gainNode);
            gainNode.connect(analyser);
            gainNode.connect(dest);
          }
        }

        processedStreamRef.current = dest.stream;

        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteFrequencyData(data);
          setMicLevel(Math.min(100, (data.reduce((a,b)=>a+b)/data.length/128)*100));
          animationFrameRef.current = requestAnimationFrame(tick);
        };
        tick();

        socketRef.current.emit('join', { room: roomName, user: username });
        setView('room');
      })
      .catch(() => alert('Could not access microphone.'));
  };

  const stopScreenShare = () => {
    screenStreamRef.current?.getTracks().forEach(t => t.stop());
    screenStreamRef.current = null;
    setIsScreenSharing(false);
    socketRef.current.emit('screen-share-stopped');

    Object.entries(peersRef.current).forEach(async ([userId, pc]) => {
      const senders = screenSendersRef.current[userId] ||
        pc.getSenders().filter(s => s.track?.kind === 'video');
      if (senders.length === 0) return;
      try {
        senders.forEach(sender => { try { pc.removeTrack(sender); } catch { /* already removed */ } });
        delete screenSendersRef.current[userId];
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socketRef.current.emit('offer', { to: userId, offer });
      } catch (err) { console.error('Renegotiation error:', err); }
    });
  };

  const leaveRoom = () => {
    if (isScreenSharing) stopScreenShare();

    Object.values(peersRef.current).forEach(pc => pc.close());
    peersRef.current      = {};
    remoteStreamsRef.current = {};
    Object.values(remoteAudioRef.current).forEach(a => { a.srcObject = null; });
    remoteAudioRef.current = {};
    screenSendersRef.current = {};

    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;

    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    processorRef.current?.disconnect();
    processorRef.current = null;
    dfCoreRef.current = null;
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    gainNodeRef.current?.disconnect();
    gainNodeRef.current = null;
    processedStreamRef.current?.getTracks().forEach(t => t.stop());
    processedStreamRef.current = null;
    audioContextRef.current?.close();

    socketRef.current.emit('leave');
    setMicLevel(0);
    setScreenSharer(null);
    setView('lobby');
    setCurrentRoom(null);
    setUsers([]);
    setMessages([]);
    socketRef.current.emit('get-rooms');
  };

  // Push toggle/slider changes to the running DeepFilterNet node
  useEffect(() => {
    dfCoreRef.current?.setNoiseSuppressionEnabled(isNoiseCancellationEnabled);
  }, [isNoiseCancellationEnabled]);
  useEffect(() => {
    dfCoreRef.current?.setSuppressionLevel(toAttenDb(noiseReductionLevel));
  }, [noiseReductionLevel]);

  useEffect(() => { joinRoomRef.current  = joinRoom; });
  useEffect(() => { leaveRoomRef.current = leaveRoom; });

  const startScreenShare = async () => {
    try {
      // audio: true captures tab/system audio (user must tick "Share audio"
      // in the browser dialog; Chrome shows it for tab and screen shares)
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      screenStreamRef.current = screenStream;
      setIsScreenSharing(true);
      socketRef.current.emit('screen-share-started', { username });

      const videoTrack = screenStream.getVideoTracks()[0];
      const audioTrack = screenStream.getAudioTracks()[0]; // undefined if user didn't share audio

      for (const [userId, pc] of Object.entries(peersRef.current)) {
        const senders = [];
        const videoSender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (videoSender) {
          await videoSender.replaceTrack(videoTrack);
          senders.push(videoSender);
        } else {
          senders.push(pc.addTrack(videoTrack, screenStream));
        }
        // Screen audio goes out as a SECOND audio track alongside the mic
        if (audioTrack) senders.push(pc.addTrack(audioTrack, screenStream));
        screenSendersRef.current[userId] = senders;

        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socketRef.current.emit('offer', { to: userId, offer });
        } catch (err) { console.error('Renegotiation error:', err); }
      }

      videoTrack.onended = () => stopScreenShare();
    } catch (err) {
      if (err.name !== 'NotAllowedError') alert('Could not start screen sharing.');
    }
  };

  const handleSend = (e) => {
    e.preventDefault();
    if (message && socketRef.current) {
      socketRef.current.emit('message', message);
      setMessage('');
    }
  };

  const handleLogout = () => {
    if (currentRoom) leaveRoom();
    localStorage.removeItem('voiceapp_username');
    setUsername('');
    setView('username');
  };

  // ── Views ──────────────────────────────────────────────────────────────────

  if (view === 'username') {
    return (
      <div className="min-h-screen bg-[#0f0f0f] text-white flex items-center justify-center p-6">
        <div className="w-full max-w-xs anim-fade-up">
          <div className="mb-10">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                  <line x1="12" y1="19" x2="12" y2="23"/>
                  <line x1="8" y1="23" x2="16" y2="23"/>
                </svg>
              </div>
              <span className="text-lg font-semibold tracking-tight">VoiceHub</span>
            </div>
            <p className="text-sm text-white/40 ml-11">Voice rooms, no account needed.</p>
          </div>

          <form onSubmit={handleSetUsername} className="space-y-3">
            <div>
              <label className="block text-xs text-white/40 mb-1.5 uppercase tracking-wider">Your name</label>
              <input
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3.5 py-2.5 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/30 transition-colors"
                placeholder="e.g. Alex"
                value={username}
                onChange={e => setUsername(e.target.value)}
                required
                autoFocus
              />
            </div>
            <button
              type="submit"
              className="w-full bg-white text-black rounded-lg py-2.5 text-sm font-semibold hover:bg-white/90 active:scale-[0.98] transition-all"
            >
              Continue
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (view === 'lobby') {
    return (
      <div className="min-h-screen bg-[#0f0f0f] text-white">
        <div className="max-w-2xl mx-auto px-6 py-8">

          {/* Header */}
          <div className="flex items-center justify-between mb-8 anim-fade-in">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-md bg-white/10 flex items-center justify-center">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                  <line x1="12" y1="19" x2="12" y2="23"/>
                  <line x1="8" y1="23" x2="16" y2="23"/>
                </svg>
              </div>
              <span className="font-semibold tracking-tight">VoiceHub</span>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 text-xs text-white/40">
                <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-400'}`}/>
                <span className="font-medium text-white/60">{username}</span>
              </div>
              <button
                onClick={handleLogout}
                className="text-xs text-white/30 hover:text-white/60 transition-colors px-2 py-1 rounded hover:bg-white/5"
              >
                Log out
              </button>
            </div>
          </div>

          {/* Section title + new room */}
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs uppercase tracking-widest text-white/30 font-medium">Rooms</h2>
            <button
              onClick={() => setShowCreateRoom(true)}
              className="flex items-center gap-1.5 text-xs text-white/50 hover:text-white transition-colors px-2.5 py-1.5 rounded-md hover:bg-white/5 border border-transparent hover:border-white/10"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              New room
            </button>
          </div>

          {/* Room list */}
          {rooms.length === 0 ? (
            <div className="py-16 text-center anim-fade-in">
              <p className="text-white/25 text-sm">No rooms yet — create one.</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {rooms.map((room, i) => (
                <div
                  key={room.name}
                  className="group flex items-center justify-between px-4 py-3.5 rounded-xl bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.06] hover:border-white/[0.12] transition-all anim-fade-up"
                  style={{ animationDelay: `${i * 40}ms` }}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="relative flex-shrink-0">
                      <div className="w-8 h-8 rounded-full bg-white/8 flex items-center justify-center text-xs font-semibold text-white/70">
                        {room.name.charAt(0).toUpperCase()}
                      </div>
                      {room.userCount > 0 && (
                        <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 border-2 border-[#0f0f0f]"/>
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-white/90 truncate">{room.name}</p>
                      <p className="text-xs text-white/30 truncate">{room.userCount} {room.userCount === 1 ? 'person' : 'people'}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    {room.creator === username && (
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteRoom(room.name); }}
                        className="text-xs text-white/20 hover:text-red-400 transition-colors px-2 py-1 rounded opacity-0 group-hover:opacity-100"
                      >
                        Delete
                      </button>
                    )}
                    <button
                      onClick={() => joinRoom(room.name)}
                      className="text-xs font-medium bg-white/8 hover:bg-white/14 text-white/70 hover:text-white rounded-lg px-3 py-1.5 transition-all active:scale-95"
                    >
                      Join
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Create room modal */}
        {showCreateRoom && (
          <div
            className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 anim-fade-in"
            onClick={() => setShowCreateRoom(false)}
          >
            <div
              className="bg-[#1a1a1a] border border-white/10 rounded-2xl p-6 w-full max-w-sm mx-4 anim-scale-in"
              onClick={e => e.stopPropagation()}
            >
              <h3 className="text-sm font-semibold mb-4">Create a room</h3>
              <input
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3.5 py-2.5 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/30 transition-colors mb-3"
                placeholder="Room name"
                value={newRoomName}
                onChange={e => setNewRoomName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && createRoom()}
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  onClick={() => setShowCreateRoom(false)}
                  className="flex-1 py-2.5 rounded-lg text-sm text-white/40 hover:text-white/70 hover:bg-white/5 transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={createRoom}
                  className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-white text-black hover:bg-white/90 active:scale-[0.98] transition-all"
                >
                  Create
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (view === 'room') {
    return (
      <div className="min-h-screen bg-[#0f0f0f] text-white">
        <div className="max-w-5xl mx-auto px-6 py-8">

          {/* Room header */}
          <div className="flex items-center justify-between mb-6 anim-fade-in">
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#4ade80]"/>
              <h1 className="font-semibold text-white/90">{currentRoom}</h1>
              <span className="text-xs text-white/25">{users.length} {users.length === 1 ? 'person' : 'people'}</span>
            </div>
            <button
              onClick={leaveRoom}
              className="text-xs text-white/30 hover:text-red-400 transition-colors px-3 py-1.5 rounded-lg hover:bg-red-500/10 border border-transparent hover:border-red-500/20"
            >
              Leave
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

            {/* Left: users + mic controls */}
            <div className="space-y-4">
              {/* Participants */}
              <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4 anim-fade-up">
                <p className="text-xs uppercase tracking-widest text-white/25 font-medium mb-3">Participants</p>
                <div className="space-y-1 max-h-64 overflow-y-auto custom-scrollbar">
                  {users.map(u => (
                    <div key={u.id} className="flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-white/[0.04] transition-colors">
                      <div className="relative">
                        <div className="w-7 h-7 rounded-full bg-white/8 flex items-center justify-center text-xs font-semibold text-white/70">
                          {u.name.charAt(0).toUpperCase()}
                        </div>
                        {/* Live indicator bars */}
                        {u.id === socketId && !isMuted && (
                          <div className="absolute -right-1 -bottom-1 flex items-end gap-[2px]">
                            <div className="w-[2px] h-[6px] bg-emerald-400 rounded-full bar-1 origin-bottom"/>
                            <div className="w-[2px] h-[9px] bg-emerald-400 rounded-full bar-2 origin-bottom"/>
                            <div className="w-[2px] h-[6px] bg-emerald-400 rounded-full bar-3 origin-bottom"/>
                          </div>
                        )}
                      </div>
                      <span className="text-sm text-white/80">{u.name}</span>
                      {u.id === socketId
                        ? <span className="ml-auto text-[10px] text-white/25">you</span>
                        : <SignalBars stats={peerStats[u.id]}/>}
                    </div>
                  ))}
                </div>
              </div>

              {/* Mic controls */}
              <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4 anim-fade-up" style={{ animationDelay: '60ms' }}>
                <p className="text-xs uppercase tracking-widest text-white/25 font-medium mb-3">Microphone</p>

                {/* Volume bar */}
                <div className="mb-4">
                  <div className="h-1 bg-white/8 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-75 ${
                        isMuted ? 'bg-white/10' : micLevel > 70 ? 'bg-red-400' : micLevel > 30 ? 'bg-amber-400' : 'bg-emerald-400'
                      }`}
                      style={{ width: `${isMuted ? 0 : micLevel}%` }}
                    />
                  </div>
                </div>

                <div className="space-y-2.5 mb-4">
                  <DeviceSelect label="Microphone" value={selectedMic} devices={audioInputs} onChange={switchMic}/>
                  {canPickSpeaker && (
                    <DeviceSelect label="Speaker" value={selectedSpeaker} devices={audioOutputs} onChange={switchSpeaker}/>
                  )}
                </div>

                <div className="space-y-2">
                  <button
                    onClick={() => setIsMuted(m => !m)}
                    className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all active:scale-[0.98] ${
                      isMuted
                        ? 'bg-red-500/15 text-red-400 border border-red-500/25 hover:bg-red-500/20'
                        : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/15'
                    }`}
                  >
                    <span>{isMuted ? 'Unmute' : 'Mute'}</span>
                    <div className={`w-4 h-4 rounded-full border-2 ${isMuted ? 'border-red-400 bg-red-400/30' : 'border-emerald-400 bg-emerald-400/30'}`}/>
                  </button>

                  <button
                    onClick={() => setIsNoiseCancellationEnabled(p => !p)}
                    className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm transition-all active:scale-[0.98] ${
                      isNoiseCancellationEnabled
                        ? 'bg-white/6 text-white/70 border border-white/10 hover:bg-white/10'
                        : 'bg-transparent text-white/30 border border-white/6 hover:bg-white/4'
                    }`}
                  >
                    <span>Noise cancel</span>
                    <div className={`w-7 h-4 rounded-full transition-colors relative ${isNoiseCancellationEnabled ? 'bg-white/30' : 'bg-white/8'}`}>
                      <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full shadow transition-all ${isNoiseCancellationEnabled ? 'left-3.5' : 'left-0.5'}`}/>
                    </div>
                  </button>

                  {isNoiseCancellationEnabled && (
                    <div className="px-1 anim-fade-in">
                      <div className="flex justify-between text-xs text-white/25 mb-1.5">
                        <span>Noise reduction</span>
                        <span>{Math.round(noiseReductionLevel * 100)}%</span>
                      </div>
                      <input
                        type="range" min="0.1" max="1" step="0.1"
                        value={noiseReductionLevel}
                        onChange={e => setNoiseReductionLevel(parseFloat(e.target.value))}
                        className="w-full h-1 bg-white/8 rounded-lg appearance-none cursor-pointer slider"
                      />
                    </div>
                  )}

                  <button
                    onClick={isScreenSharing ? stopScreenShare : startScreenShare}
                    className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm transition-all active:scale-[0.98] ${
                      isScreenSharing
                        ? 'bg-amber-500/15 text-amber-400 border border-amber-500/25 hover:bg-amber-500/20'
                        : 'bg-white/4 text-white/40 border border-white/8 hover:bg-white/8 hover:text-white/60'
                    }`}
                  >
                    <span>{isScreenSharing ? 'Stop sharing' : 'Share screen'}</span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
                    </svg>
                  </button>
                </div>
              </div>
            </div>

            {/* Right: chat */}
            <div className="lg:col-span-2 bg-white/[0.03] border border-white/[0.06] rounded-2xl flex flex-col anim-fade-up" style={{ animationDelay: '30ms' }}>
              <div className="px-4 pt-4 pb-3 border-b border-white/[0.06]">
                <p className="text-xs uppercase tracking-widest text-white/25 font-medium">Chat</p>
              </div>

              <div className="flex-1 overflow-y-auto custom-scrollbar px-4 py-3 space-y-2 min-h-[360px] max-h-[420px]">
                {messages.map((m, i) => (
                  <div key={i}>
                    {m.user === 'system' ? (
                      <p className="text-center text-xs text-white/20 py-1">{m.text}</p>
                    ) : (
                      <div className="flex items-start gap-2.5">
                        <div className="w-6 h-6 flex-shrink-0 rounded-full bg-white/8 flex items-center justify-center text-[10px] font-semibold text-white/50 mt-0.5">
                          {m.user.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <span className="text-xs text-white/30 mr-1.5">{m.user}</span>
                          <span className="text-sm text-white/80 break-words">{m.text}</span>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <form onSubmit={handleSend} className="px-4 py-3 border-t border-white/[0.06] flex gap-2">
                <input
                  className="flex-1 bg-white/5 border border-white/8 rounded-xl px-3.5 py-2 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/20 transition-colors"
                  placeholder="Message…"
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                />
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-white/8 hover:bg-white/14 text-white/60 hover:text-white text-sm font-medium transition-all active:scale-95"
                >
                  Send
                </button>
              </form>
            </div>
          </div>

          {/* Screen share view */}
          {screenSharer && (
            <div className="mt-4 bg-white/[0.03] border border-white/[0.06] rounded-2xl overflow-hidden anim-scale-in">
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-amber-400 shadow-[0_0_6px_#fbbf24]"/>
                  <span className="text-sm text-white/60">
                    <span className="text-white/80 font-medium">{screenSharer}</span> is sharing
                  </span>
                </div>
                <button
                  onClick={() => {
                    const v = remoteVideoRef.current;
                    if (!v) return;
                    if (document.fullscreenElement === v) document.exitFullscreen();
                    else v.requestFullscreen().catch(() => {});
                  }}
                  className="text-xs text-white/30 hover:text-white/60 transition-colors px-2 py-1 rounded hover:bg-white/5"
                >
                  Fullscreen
                </button>
              </div>
              <div className="bg-black">
                <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-auto max-h-[560px] object-contain"/>
              </div>
            </div>
          )}

        </div>
      </div>
    );
  }

  return null;
}
