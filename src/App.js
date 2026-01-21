
import './App.css';
import RoomControls from './RoomControls';
import { useState } from 'react';


function App() {
  const [currentRoom, setCurrentRoom] = useState(null);

  return (
    <div className="App">
      <header className="App-header">
        <h1>Güvenli Sesli Sohbet (React)</h1>
      </header>
      <main>
        <RoomControls
          currentRoom={currentRoom}
          onJoin={setCurrentRoom}
          onCreate={setCurrentRoom}
        />
        {/* Other components (user list, chat, audio) will go here */}
      </main>
    </div>
  );
}

export default App;
