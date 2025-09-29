import { observer } from 'mobx-react-lite';

const DiscoveredClients = observer(({ store }) => {
  return (
    <div>
      <div className="discovered-clients">
        {store.discoveredClients.map((client, index) => (
          <div key={`udp-${index}`} className="discovered-client">
            <div className={`client-group ${client.connected ? 'connected' : ''}`}>
              <div className="client-status" style={{ display: 'block', width: '100%', marginBottom: '8px' }}>
                {client.connected ? ':connected' : ''}
              </div>
              {client.addresses.map((addr, addrIndex) => (
                <div key={addrIndex} className="address-item" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
                  <div className="addr">{addr}</div>
                  {!client.connected && (
                    <button
                      className="connect-btn"
                      onClick={() => store.connectToClient(addr)}
                    >
                      Connect
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}

        {store.discoveredFiles && store.discoveredFiles.map((file, index) => (
          <div key={`file-${index}`} className="discovered-client">
            <div className={`client-group ${file.connected ? 'connected' : ''}`}>
              <div className="client-status" style={{ display: 'block', width: '100%', marginBottom: '8px' }}>
                {file.connected ? ':connected' : ''}
              </div>
              <div className="address-item" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
                <div className="addr">{file.path}</div>
                {!file.connected && (
                  <button
                    className="connect-btn"
                    onClick={() => store.openFile(file.path)}
                  >
                    Open File
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});

export default DiscoveredClients;