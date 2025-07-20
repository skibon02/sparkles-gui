import { observer } from 'mobx-react-lite';
import {useEffect, useRef, useState} from 'react';
import './ActiveConnections.css';
import trace from "../trace.js";

const TimestampBadge = ({ label, value }) => {
  const formatTimestamp = (ts) => (ts / 1000000000).toFixed(3) + 's';
  
  return (
    <div className="badge badge-timestamp">
      {label}: {formatTimestamp(value)}
    </div>
  );
};

const ConnectionCanvas = observer(({ store, connectionId }) => {
  let s = trace.start();
  const canvasRef = useRef(null);

  useEffect(() => {
    if (canvasRef.current) {
      store.setCanvasRef(connectionId, canvasRef.current);
    }

    return () => {
      store.removeCanvasRef(connectionId);
    };
  }, [store, connectionId]);

  let res = (
    <canvas
      ref={canvasRef}
      width={800}
      height={200}
      className="connection-canvas"
    />
  );

  trace.end(s, "render ConnectionCanvas");
  return res;
});

const ActiveConnections = observer(({ store }) => {
  let s = trace.start();

  const [collapsedConnections, setCollapsedConnections] = useState(new Set());
  
  const toggleExpand = (connectionId) => {
    setCollapsedConnections(prev => {
      const newSet = new Set(prev);
      if (newSet.has(connectionId)) {
        newSet.delete(connectionId);
      } else {
        newSet.add(connectionId);
      }
      return newSet;
    });
  };

  const isExpanded = (connectionId) => !collapsedConnections.has(connectionId);
  let res = (
    <div>
      <div className="container active-clients">
        {store.activeConnections.map((connection) => (
          <div key={connection.id} className="connection-cont">
            <div className="connection-header">
              <span className="addr">ID: {connection.id} - {connection.addr}</span>
              <div>
                <button
                  className="btn reset-btn" 
                  onClick={() => store.resetConnectionView(connection.id)}
                >
                  Reset View
                </button>
              </div>
            </div>
            <div className="connection-body">
              <div
                className={"expand-btn" + (isExpanded(connection.id) ? " expanded" : "")}
                onClick={() => toggleExpand(connection.id)}
              >🞛</div>
              <div className={`expandable-content ${isExpanded(connection.id) ? 'expanded' : 'collapsed'}`}>
                {connection.stats && (
                  <div className="connection-stats">
                    <div className="badge badge-primary">Instant events: {connection.stats.instant_events}</div>
                    <div className="badge badge-primary">Range events: {connection.stats.range_events}</div>
                  </div>
                )}
                <div className={"threads-cont"}>
                  <div className={"threads-header"}>
                    <div className={"thread-joint"}>⚫︎</div>
                    <div className={"thread-name"}>
                      Thread name here
                    </div>
                  </div>
                  <div className={"threads-body"}>
                    <ConnectionCanvas
                      store={store}
                      connectionId={connection.id}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  trace.end(s, "render ActiveConnections");
  return res;
});

export default ActiveConnections;