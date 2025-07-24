import { observer } from 'mobx-react-lite';
import './ConnectionStatus.scss';

const ConnectionStatus = observer(({ store }) => {
  return (
    <div 
      className={`connection-status ${store.isConnected ? 'connected' : 'disconnected'}`}
    >
      {store.isConnected ? ':connected' : ':disconnected'}
    </div>
  );
});

export default ConnectionStatus;