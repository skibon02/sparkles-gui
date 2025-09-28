import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';

const EditableThreadName = observer(({ store, connectionId, thread }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef(null);
  
  const connection = store.getConnection(connectionId);
  const threadName = connection?.getThreadName(thread.thread_ord_id) || '';
  const displayName = threadName || `Thread ${thread.thread_ord_id}`;
  
  const startEditing = () => {
    setEditValue(threadName);
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
      connection.setChannelName(thread.thread_ord_id, editValue);
      store.setChannelName(connectionId, thread.thread_ord_id, editValue);
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
        placeholder={`Thread ${thread.thread_ord_id}`}
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