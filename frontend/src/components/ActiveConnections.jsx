import { observer } from 'mobx-react-lite';
import { useEffect, useRef } from 'react';
import './ActiveConnections.css';

const TimestampBadge = ({ label, value }) => {
  const formatTimestamp = (ts) => (ts / 1000000000).toFixed(3) + 's';
  
  return (
    <div className="badge badge-timestamp">
      {label}: {formatTimestamp(value)}
    </div>
  );
};

const ConnectionCanvas = observer(({ store, connectionId }) => {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (canvasRef.current) {
      store.setCanvasRef(connectionId, canvasRef.current);
    }

    return () => {
      store.removeCanvasRef(connectionId);
    };
  }, [store, connectionId]);

  return (
    <canvas 
      ref={canvasRef}
      width={800}
      height={200}
      className="connection-canvas"
    />
  );
});

const ActiveConnections = observer(({ store }) => {
  return (
    <div>
      <div className="container active-clients">
        {store.activeConnections.map((connection) => (
          <div key={connection.id} className="client-cont">
            <div className="client-header">
              <span className="addr">ID: {connection.id} - {connection.addr}</span>
              <div>
                <button 
                  className="btn request-btn" 
                  onClick={() => store.requestEvents(connection.id)}
                >
                  Request Events
                </button>
                <button 
                  className="btn reset-btn" 
                  onClick={() => store.resetConnectionView(connection.id)}
                >
                  Reset View
                </button>
              </div>
            </div>
            
            {connection.stats && (
              <div className="client-stats">
                <div className="badge badge-primary">Instant events: {connection.stats.instant_events}</div>
                <div className="badge badge-primary">Range events: {connection.stats.range_events}</div>
                
                {/*{store.getConnection(connection.id)?.timestamps && (*/}
                {/*  <div className="timestamp-row">*/}
                {/*    <TimestampBadge */}
                {/*      label="Start" */}
                {/*      value={store.getConnection(connection.id).timestamps.min} */}
                {/*    />*/}
                {/*    <TimestampBadge */}
                {/*      label="End" */}
                {/*      value={store.getConnection(connection.id).timestamps.max} */}
                {/*    />*/}
                {/*    <TimestampBadge */}
                {/*      label="Current" */}
                {/*      value={store.getConnection(connection.id).timestamps.current} */}
                {/*    />*/}
                {/*  </div>*/}
                {/*)}*/}
              </div>
            )}
            
            <ConnectionCanvas 
              store={store}
              connectionId={connection.id}
            />
          </div>
        ))}
      </div>
    </div>
  );
});

export default ActiveConnections;