import { observer } from 'mobx-react-lite';

const DiscoveredClients = observer(({ store }) => {
  return (
    <div>
      <div className="container discovered-clients">
        {store.discoveredClients.map((addrs, index) => (
          <div key={index} className="discovered-client">
            {addrs.map((addr, addrIndex) => (
              <div key={addrIndex}>
                <div className="addr">{addr}</div>
                <button 
                  className="btn connect-btn" 
                  onClick={() => store.connectToClient(addr)}
                >
                  Connect
                </button>
                <br />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
});

export default DiscoveredClients;