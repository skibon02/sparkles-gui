import { observer } from 'mobx-react-lite';

const ConnectionStatus = observer(({ store }) => {
  return (
    <div 
      style={{
        position: 'fixed',
        top: '10px',
        right: '10px',
        padding: '8px 12px',
        borderRadius: '20px',
        fontSize: '0.85em',
        fontWeight: '500',
        backgroundColor: store.isConnected ? '#28a745' : '#dc3545',
        color: 'white',
        boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
        zIndex: 1000
      }}
    >
      {store.isConnected ? ':connected' : ':disconnected'}
    </div>
  );
});

export default ConnectionStatus;