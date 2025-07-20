import { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import WebSocketStore from './stores/WebSocketStore';
import {
  DiscoveredClients,
  ActiveConnections,
  ConnectionStatus
} from './components';

const App = observer(() => {
  const [store] = useState(() => new WebSocketStore());

  useEffect(() => {
    // Cleanup on unmount
    return () => {
      store.disconnect();
    };
  }, [store]);

  return (
    <>
      <ConnectionStatus store={store} />

      <h1>SPARKLES</h1>

      <DiscoveredClients store={store} />
      <ActiveConnections store={store} />

    </>
  );
});

export default App;
