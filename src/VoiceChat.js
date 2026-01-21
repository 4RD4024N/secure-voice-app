import React, { useEffect, useRef, useState } from 'react';
import { useSocket } from './SocketContext';
import Peer from 'simple-peer';

export default function VoiceChat({ currentRoom }) {
  const socket = useSocket();
  const [peers, setPeers] = useState({});
  const [stream, setStream] = useState(null);
  const localAudioRef = useRef();

  useEffect(() => {
    if (!currentRoom) return;
    let cleanup = () => {};
    navigator.mediaDevices.getUserMedia({ audio: true }).then(localStream => {
      setStream(localStream);
      if (localAudioRef.current) {
        localAudioRef.current.srcObject = localStream;
      }
      const peersObj = {};
      socket.on('user-joined', ({ id }) => {
        if (id === socket.id) return;
        const peer = new Peer({ initiator: true, trickle: false, stream: localStream });
        peer.on('signal', data => socket.emit('signal', { to: id, data }));
        peer.on('stream', remoteStream => {
          addRemoteAudio(id, remoteStream);
        });
        socket.on('signal', ({ from, data }) => {
          if (from === id) peer.signal(data);
        });
        peersObj[id] = peer;
        setPeers({ ...peersObj });
      });
      socket.on('user-left', id => {
        if (peersObj[id]) {
          peersObj[id].destroy();
          delete peersObj[id];
          setPeers({ ...peersObj });
          removeRemoteAudio(id);
        }
      });
      // Handle existing users
      socket.once('joinedRoom', (roomId, others) => {
        (others || []).forEach(id => {
          if (id === socket.id) return;
          const peer = new Peer({ initiator: false, trickle: false, stream: localStream });
          peer.on('signal', data => socket.emit('signal', { to: id, data }));
          peer.on('stream', remoteStream => {
            addRemoteAudio(id, remoteStream);
          });
          socket.on('signal', ({ from, data }) => {
            if (from === id) peer.signal(data);
          });
          peersObj[id] = peer;
          setPeers({ ...peersObj });
        });
      });
      cleanup = () => {
        Object.values(peersObj).forEach(peer => peer.destroy());
        setPeers({});
        if (localStream) localStream.getTracks().forEach(t => t.stop());
      };
    });
    return cleanup;
    // eslint-disable-next-line
  }, [currentRoom]);

  function addRemoteAudio(id, remoteStream) {
    let el = document.getElementById('audio-' + id);
    if (!el) {
      el = document.createElement('audio');
      el.id = 'audio-' + id;
      el.autoplay = true;
      el.controls = true;
      document.body.appendChild(el);
    }
    el.srcObject = remoteStream;
  }
  function removeRemoteAudio(id) {
    const el = document.getElementById('audio-' + id);
    if (el) el.remove();
  }

  return (
    <div className="voice-chat">
      <h3>Sesli Sohbet</h3>
      <audio ref={localAudioRef} autoPlay controls muted />
      <div>Diğer kullanıcıların sesi otomatik olarak eklenecek.</div>
    </div>
  );
}
