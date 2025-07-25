import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import './ActiveConnections.scss';
import trace from "../../trace.js";
import lockIcon from '../../assets/icons/lock.png';
import ThreadsContainer from './ThreadsContainer.jsx';

const ActiveConnections = observer(({ store }) => {
  let s = trace.start();

  const [collapsedConnections, setCollapsedConnections] = useState(new Set());
  const [hasInitialized, setHasInitialized] = useState(false);
  
  useEffect(() => {
    if (store.activeConnections.length > 0 && !hasInitialized) {
      const sortedConnections = store.activeConnections.slice().sort((a, b) => b.id - a.id);
      const lastConnectionId = sortedConnections[0].id;
      
      const allButLast = new Set(
        sortedConnections.slice(1).map(conn => conn.id)
      );
      
      setCollapsedConnections(allButLast);
      
      sortedConnections.forEach(connection => {
        const connectionObj = store.getConnection(connection.id);
        if (connectionObj) {
          connectionObj.setExpanded(connection.id === lastConnectionId);
        }
      });
      
      setHasInitialized(true);
    }
  }, [store.activeConnections.length, hasInitialized]);
  
  const toggleExpand = (connectionId) => {
    setCollapsedConnections(prev => {
      const newSet = new Set(prev);
      const willBeExpanded = newSet.has(connectionId);
      
      if (willBeExpanded) {
        newSet.delete(connectionId);
      } else {
        newSet.add(connectionId);
      }
      
      const connectionObj = store.getConnection(connectionId);
      if (connectionObj) {
        connectionObj.setExpanded(willBeExpanded);
      }
      
      return newSet;
    });
  };

  const isExpanded = (connectionId) => !collapsedConnections.has(connectionId);
  
  const groupedConnections = store.activeConnections.slice().reduce((groups, connection) => {
    const connectionObj = store.getConnection(connection.id);
    const isOnline = connectionObj?.isOnline ?? true;
    
    if (isOnline) {
      groups.online.push(connection);
    } else {
      groups.offline.push(connection);
    }
    
    return groups;
  }, { online: [], offline: [] });
  
  groupedConnections.online.sort((a, b) => b.id - a.id);
  groupedConnections.offline.sort((a, b) => b.id - a.id);
  
  const sortedConnections = [...groupedConnections.online, ...groupedConnections.offline];

  let res = (
    <div>
      <div className="active-clients">
        {sortedConnections.map((connection) => {
          const connectionObj = store.getConnection(connection.id);
          const isOnline = connectionObj?.isOnline ?? true;
          
          return (
          <div key={connection.id} className={`connection-cont ${!isOnline ? 'connection-offline' : ''}`}>
            <div className="connection-header">
              <span className="addr">ID: {connection.id} - {connection.addr}</span>
              <div>
                {(() => {
                  const connectionObj = store.getConnection(connection.id);
                  if (!connectionObj || !connectionObj.isOnline) return null;
                  
                  return (
                    <div className="scroll-btn-container">
                      <button
                        className={`scroll-btn ${connectionObj.isScrollingEnabled ? 'scroll-on' : 'scroll-off'}`}
                        onClick={() => connectionObj.toggleScrolling()}
                      >
                        Scrolling: {connectionObj.isScrollingEnabled ? 'ON' : 'OFF'}
                      </button>
                      {connectionObj.isScrollingEnabled && (
                        <button
                          className={`lock-btn ${connectionObj.isLocked ? 'lock-unlocked' : 'lock-locked'}`}
                          onClick={() => connectionObj.toggleLock()}
                        >
                          <img src={lockIcon} alt="lock" className="lock-icon" />
                        </button>
                      )}
                    </div>
                  );
                })()}
                <button
                  className="reset-btn"
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
              <div 
                className={`expandable-content ${isExpanded(connection.id) ? 'expanded' : 'collapsed'}`}
                style={{
                  maxHeight: isExpanded(connection.id) ? 'none' : '0'
                }}
              >
                {connection.stats && (
                  <div className="connection-stats">
                    {(() => {
                      const connectionObj = store.getConnection(connection.id);
                      if (!connectionObj) return null;
                      
                      const allStats = connectionObj.getAllThreadSkipStats();
                      let instant_displayed = 0;
                      let instant_total = 0;
                      let range_displayed = 0;
                      let range_total = 0;

                      for (const stats of allStats.values()) {
                        instant_displayed += (stats.total_instant - stats.skipped_instant);
                        instant_total += stats.total_instant;
                        range_displayed += (stats.total_range - stats.skipped_range);
                        range_total += stats.total_range
                      }
                      
                      return <>
                          <div className="badge badge-primary">
                            {instant_displayed}/{instant_total}/{connection.stats.instant_events} instant
                          </div>
                          <div className="badge badge-primary">
                            {range_displayed}/{range_total}/{connection.stats.range_events} range
                          </div>
                        </>;

                    })()}
                  </div>
                )}
                {(() => {
                  const connectionObj = store.getConnection(connection.id);
                  if (!connectionObj) return null;
                  
                  const expanded = isExpanded(connection.id);
                  connectionObj.setExpanded(expanded);
                  
                  const threads = connectionObj.getAllThreads().sort((a, b) => a.thread_ord_id - b.thread_ord_id);
                  
                  if (threads.length === 0) {
                    return (
                      <div className={"threads-cont"}>
                        <div className={"threads-header"}>
                          <div className={"thread-joint"}>⚫︎</div>
                          <div className={"thread-name"}>
                            No threads available
                          </div>
                        </div>
                      </div>
                    );
                  }
                  
                  return (
                    <ThreadsContainer 
                      store={store}
                      connectionId={connection.id}
                      threads={threads}
                    />
                  );
                })()}
              </div>
            </div>
          </div>
          );
        })}
      </div>
    </div>
  );

  trace.end(s, "render ActiveConnections");
  return res;
});

export default ActiveConnections;