import { observer } from 'mobx-react-lite';

const DiscoveredClients = observer(({ store }) => {
  return (
    <div>
      <p>Discovered clients:</p>
      <div className="container discovered-clients">
        {store.discoveredClients.map((addrs, index) => (
          <div key={index} className="client-cont">
            {addrs.map((addr, addrIndex) => (
              <div key={addrIndex}>
                <span className="addr">{addr}</span>
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