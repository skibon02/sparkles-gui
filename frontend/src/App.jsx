import { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import WebSocketStore from './stores/WebSocketStore';
import {
  DiscoveredClients,
  ActiveConnections,
  ConnectionStatus
} from './components';
import './App.css';

const App = observer(() => {
  const [store] = useState(() => new WebSocketStore());

  useEffect(() => {
    // Cleanup on unmount
    return () => {
      store.disconnect();
    };
  }, [store]);

  return (
    <div className="app">
      <ConnectionStatus store={store} />

      <h1>SPARKLES</h1>

      <DiscoveredClients store={store} />
      <ActiveConnections store={store} />

    </div>
  );
});

export default App;
