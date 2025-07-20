import { makeAutoObservable } from 'mobx';
import ActiveConnection from './ActiveConnection.js';

class WebSocketStore {
  socket = null;
  isConnected = false;
  reconnectInterval = 1000; // 1 second
  reconnectTimeout = null;
  
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
      const wsUrl = import.meta.env.DEV 
        ? `ws://localhost:3000/ws`
        : `ws://${window.location.host}/ws`;
      
      this.socket = new WebSocket(wsUrl);
      
      this.socket.onopen = () => {
        console.log('WebSocket connected');
        this.isConnected = true;
        if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
          this.reconnectTimeout = null;
        }
      };

      this.socket.onmessage = (event) => {
        this.handleMessage(event);
      };

      this.socket.onclose = () => {
        console.log('WebSocket disconnected, trying to reconnect...');
        this.isConnected = false;
        this.scheduleReconnect();
      };

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
          console.log('Backend is busy processing previous request, will retry when current request completes');
          // Reset throttling state for all connections since we don't know which one failed
          for (const connection of this.connections.values()) {
            connection.onEventRequestError();
          }
        } else {
          alert('Connection error: ' + msg.ConnectError);
        }
      } else if (msg.ActiveConnections !== undefined) {
        this.activeConnections = msg.ActiveConnections;
      } else if (msg.Addressed !== undefined) {
        const { id, message } = msg.Addressed;
        
        if (message.NewEvents !== undefined) {
          this.handleNewEvents(id, message.NewEvents);
        }
        else if (message.ConnectionTimestamps !== undefined) {
          this.getOrCreateConnection(id).setTimestamps(message.ConnectionTimestamps);
        }
        else {
            console.warn('Unknown message in Addressed:', message);
        }
      }
      else {
        console.warn('Unknown message type:', msg);
      }
      
    } catch (error) {
      console.error('Error parsing WebSocket message:', error);
    }
  };

  handleNewEvents = (connectionId, newEvents) => {
    const startTime = performance.now();
    
    const { data, thread_ord_id } = newEvents;
    const addr = `client-${connectionId}`;

    const uint8Array = new Uint8Array(data);
    const view = new DataView(uint8Array.buffer);
    let offset = 0;

    // Parse events for canvas rendering
    const instantEvents = [];
    const rangeEvents = [];

    const instantEventsLen = view.getUint32(offset, true);
    offset += 4;
    const instantEventsEnd = offset + instantEventsLen;

    while (offset < instantEventsEnd) {
      const tm = Number(view.getBigUint64(offset, true));
      offset += 8;
      const eventId = view.getUint8(offset);
      offset += 1;

      instantEvents.push({
        timestamp: tm,
        event_id: eventId,
        color_seed: `instant-${thread_ord_id}-${eventId}`
      });
    }

    // Parse Range Events
    while (offset < data.length) {
      const start = Number(view.getBigUint64(offset, true));
      offset += 8;
      const end = Number(view.getBigUint64(offset, true));
      offset += 8;
      const start_id = view.getUint8(offset);
      offset += 1;
      const end_id = view.getUint8(offset);
      offset += 1;

      rangeEvents.push({
        start_timestamp: start,
        end_timestamp: end,
        start_event_id: start_id,
        end_event_id: end_id,
        color_seed: `range-${thread_ord_id}-${start_id}`
      });
    }

    // Update OpenGL buffers directly
    const connection = this.getOrCreateConnection(connectionId);
    connection.updateCanvasData(thread_ord_id, instantEvents, rangeEvents);
    
    const endTime = performance.now();
    console.log(`Message processing time for connection ${connectionId}, thread ${thread_ord_id}: ${(endTime - startTime).toFixed(2)}ms (${instantEvents.length} instant, ${rangeEvents.length} range events)`);
    
    // Notify connection that request is complete (for throttling)
    connection.onEventRequestComplete();
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

  // Canvas ref methods - direct delegation to connection
  setCanvasRef = (connectionId, canvas) => {
    this.getOrCreateConnection(connectionId).setCanvasRef(canvas);
  };

  removeCanvasRef = (connectionId) => {
    this.getConnection(connectionId)?.removeCanvasRef();
  };

  resetConnectionView = (connectionId) => {
    this.getConnection(connectionId)?.resetViewToData();
  };

  autoRequestEvents = (connectionId, start, end) => {
    // Convert to integers for backend
    const startInt = Math.floor(start);
    const endInt = Math.floor(end);
    
    console.log(`Auto-requesting events for connection ${connectionId}: ${startInt} - ${endInt}`);
    
    this.sendMessage(JSON.stringify({ 
      "RequestNewRange": {
        "conn_id": connectionId,
        "start": startInt,
        "end": endInt
      }
    }));
  };

  // Cleanup
  disconnect = () => {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.isConnected = false;
  };
}

export default WebSocketStore;