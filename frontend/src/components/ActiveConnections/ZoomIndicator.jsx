import { observer } from 'mobx-react-lite';

const ZoomIndicator = observer(({ store, connectionId, containerWidth }) => {
  const connection = store.getConnection(connectionId);
  if (!connection || !containerWidth) return null;
  
  const unitInfo = connection.getOptimalTimeUnit(containerWidth);
  
  if (!unitInfo) return null;
  
  return (
    <div className="zoom-indicator">
      <div 
        className="zoom-scale-bar" 
        style={{ width: `${Math.round(unitInfo.pixelWidth)}px` }}
      />
      <div className="zoom-scale-label">{unitInfo.label}</div>
    </div>
  );
});

export default ZoomIndicator;