import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';

const EditableThreadName = observer(({ store, connectionId, channel }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef(null);

  const connection = store.getConnection(connectionId);
  const channelName = connection?.getThreadName(channel.channelId) || '';

  // Generate default display name based on channel type
  const getDefaultName = () => {
    if (channel.channelId.Thread !== undefined) {
      return `Thread ${channel.channelId.Thread}`;
    } else if (channel.channelId.External !== undefined) {
      return `External ${channel.channelId.External}`;
    }
    return 'Unknown Channel';
  };

  const displayName = channelName || getDefaultName();
  
  const startEditing = () => {
    setEditValue(channelName);
    setIsEditing(true);
  };
  
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);
  
  const handleSave = () => {
    if (connection) {
      connection.setChannelName(channel.channelId, editValue);
      store.setChannelName(connectionId, channel.channelId, editValue);
    }
    setIsEditing(false);
  };
  
  const handleCancel = () => {
    setIsEditing(false);
    setEditValue('');
  };
  
  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      handleSave();
    } else if (e.key === 'Escape') {
      handleCancel();
    }
  };
  
  if (isEditing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onKeyDown={handleKeyPress}
        onBlur={handleSave}
        className="thread-name-input"
        placeholder={getDefaultName()}
      />
    );
  }
  
  return (
    <span className="thread-name" onClick={startEditing} title="Click to edit">
      {displayName}
    </span>
  );
});

export default EditableThreadName;