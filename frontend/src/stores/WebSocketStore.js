import { makeAutoObservable, action } from 'mobx';
import ActiveConnection from './ActiveConnection.js';
import trace from "../trace.js";

class WebSocketStore {
  socket = null;
  isConnected = false;
  reconnectInterval = 1000; // 1 second
  reconnectTimeout = null;

  newEventsHeader = null;
  
  // Data state
  discoveredClients = [];
  activeConnections = [];
  
  // Connection instances
  connections = new Map(); // connectionId -> ActiveConnection instance

  constructor() {
    makeAutoObservable(this);
    this.connect();
  }

  connect = () => {
    try {
      const wsUrl = `ws://${window.location.host}/ws`;
      
      this.socket = new WebSocket(wsUrl);
      
      this.socket.onopen = action(() => {
        console.log('WebSocket connected');
        this.isConnected = true;
        if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
          this.reconnectTimeout = null;
        }
      });

      this.socket.onmessage = (event) => {
        this.handleMessage(event);
      };

      this.socket.onclose = action(() => {
        console.log('WebSocket disconnected, trying to reconnect...');
        this.isConnected = false;
        this.scheduleReconnect();
      });

      this.socket.onerror = (error) => {
        console.error('WebSocket error:', error);
        this.socket.close();
      };
    } catch (error) {
      console.error('Failed to create WebSocket:', error);
      this.scheduleReconnect();
    }
  };

  scheduleReconnect = () => {
    if (this.reconnectTimeout) return;
    
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, this.reconnectInterval);
  };

  handleMessage = (event) => {
    try {
      if (typeof event.data === 'string') {
        const msg = JSON.parse(event.data);

        if (msg.DiscoveredClients !== undefined) {
          this.discoveredClients = msg.DiscoveredClients.clients;
        }
        else if (msg.Connected !== undefined) {
          const { id, addr } = msg.Connected;
          console.log('Connected to client:', id, addr);
        }
        else if (msg.ConnectError !== undefined) {
          console.error('Connection error:', msg.ConnectError);

          // Handle "Already waiting for a range" error gracefully
          if (msg.ConnectError.includes('Already waiting for a range')) {
            // Reset throttling state for all connections since we don't know which one failed
            for (const connection of this.connections.values()) {
              connection.onEventRequestError();
            }
          } else {
            alert('Connection error: ' + msg.ConnectError);
          }
        } else if (msg.ActiveConnections !== undefined) {
          this.activeConnections = msg.ActiveConnections;
          
          // Update connection status and thread names from server data
          for (const connectionInfo of msg.ActiveConnections) {
            const connection = this.getOrCreateConnection(connectionInfo.id);
            if (connection) {
              const wasOnline = connection.isOnline;
              
              // Update online status
              connection.isOnline = connectionInfo.online;
              
              // Handle offline connections - disable scrolling completely
              if (!connection.isOnline) {
                // Always disable scrolling for offline connections
                connection.isScrollingEnabled = false;
                connection.isLocked = true; // Reset to default locked state
              } else if (!wasOnline) {
                // Connection just came online - set initial scrolling state
                // Enable scrolling only if no other online connection has it enabled
                const otherOnlineConnections = msg.ActiveConnections.filter(c => c.online && c.id !== connectionInfo.id);
                const hasOtherScrollingConnection = otherOnlineConnections.some(c => {
                  const otherConn = this.getConnection(c.id);
                  return otherConn && otherConn.isScrollingEnabled;
                });
                
                if (!hasOtherScrollingConnection) {
                  connection.isScrollingEnabled = true;
                  connection.isLocked = true; // Default to locked
                }
              }
              // If connection was already online, preserve user's scrolling choice
              
              // Apply thread names from server
              if (connectionInfo.thread_names) {
                for (const [threadId, threadName] of Object.entries(connectionInfo.thread_names)) {
                  connection.setThreadName(parseInt(threadId), threadName);
                }
              }
            }
          }
        } else if (msg.Addressed !== undefined) {
          const { id, message } = msg.Addressed;

          if (message.NewEventsHeader !== undefined) {
            this.newEventsHeader = message.NewEventsHeader;
            this.newEventsHeader.id = id;
          }
          else if (message.ConnectionTimestamps !== undefined) {
            this.getOrCreateConnection(id).setTimestamps(message.ConnectionTimestamps);
          }
          else if (message === "EventsFinished") {
            // nothing
          }
          else {
            console.warn('Unknown message in Addressed:', message);
          }
        }
        else {
          console.warn('Unknown message type:', msg);
        }
      }
      else {
        let eventsHeader = this.newEventsHeader;
        if (eventsHeader) {
          event.data.arrayBuffer().then(buffer => {
            let thread_ord_id = eventsHeader.thread_ord_id;
            let id = eventsHeader.id;
            const view = new DataView(buffer);
            let msg_id = view.getUint32(view.byteLength - 4, true);
            if (msg_id !== eventsHeader.msg_id) {
              console.error(`Invalid message id! Expected ${eventsHeader.msg_id}, got ${msg_id}`);
            }
            else {
              let conn = this.getOrCreateConnection(id)
              conn.handleNewEvents(thread_ord_id, view, eventsHeader.stats)
            }
          })
          this.newEventsHeader = null;
        }
      }
    } catch (error) {
      console.error('Error parsing WebSocket message:', error);
    }
  };

  // Handy wrapper for accessing connections with automatic creation
  getOrCreateConnection = (connectionId) => {
    if (!this.connections.has(connectionId)) {
      const connection = new ActiveConnection(connectionId);
      
      // Set up auto-request callback
      connection.onRequestEvents = (id, start, end) => {
        this.autoRequestEvents(id, start, end);
      };
      this.connections.set(connectionId, connection);
    }
    return this.connections.get(connectionId);
  };

  // Handy wrapper for accessing existing connections
  getConnection = (connectionId) => {
    return this.connections.get(connectionId);
  };

  // Actions
  sendMessage = (message) => {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(message);
    } else {
      console.error('WebSocket is not open. Cannot send message:', message);
    }
  };

  connectToClient = (addr) => {
    this.sendMessage(JSON.stringify({ "Connect": { "addr": addr } }));
  };

  // Canvas ref methods - direct delegation to connection (now per-thread)
  setCanvasRef = (connectionId, thread_ord_id, canvas) => {
    this.getOrCreateConnection(connectionId).setCanvasRef(thread_ord_id, canvas);
  };

  removeCanvasRef = (connectionId, thread_ord_id) => {
    this.getConnection(connectionId)?.removeCanvasRef(thread_ord_id);
  };

  resetConnectionView = (connectionId) => {
    this.getConnection(connectionId)?.resetViewToData();
  };

  setThreadName = (connectionId, threadId, name) => {
    console.log(`Setting thread name for connection ${connectionId}, thread ${threadId}: ${name}`);
    this.sendMessage(JSON.stringify({
      "SetThreadName": {
        "conn_id": connectionId,
        "thread_id": threadId,
        "name": name
      }
    }));
  };

  autoRequestEvents = (connectionId, start, end) => {
    // Convert to integers for backend
    const startInt = Math.floor(start);
    const endInt = Math.floor(end);
    

    this.sendMessage(JSON.stringify({
      "RequestNewRange": {
        "conn_id": connectionId,
        "start": startInt,
        "end": endInt
      }
    }));
  };

  // Cleanup
  disconnect = action(() => {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.isConnected = false;
  });
}

export default WebSocketStore;