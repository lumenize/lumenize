import { describe, it, expect } from 'vitest';
import { 
  checkServerAvailability, 
  createMaybeIt, 
  MessageBuilders, 
  ExpectedResponses,
  createMockConnection 
} from '@lumenize/testing';

describe('@lumenize/testing package', () => {
  it('should export checkServerAvailability function', () => {
    expect(typeof checkServerAvailability).toBe('function');
  });

  it('should export createMaybeIt function', () => {
    expect(typeof createMaybeIt).toBe('function');
  });

  it('should export MessageBuilders object', () => {
    expect(MessageBuilders).toBeDefined();
    expect(typeof MessageBuilders.initialize).toBe('function');
    expect(typeof MessageBuilders.toolsList).toBe('function');
    expect(typeof MessageBuilders.toolCall).toBe('function');
  });

  it('should export ExpectedResponses object', () => {
    expect(ExpectedResponses).toBeDefined();
    expect(typeof ExpectedResponses.initialize).toBe('function');
    expect(typeof ExpectedResponses.toolsList).toBe('function');
    expect(typeof ExpectedResponses.toolCall).toBe('function');
  });

  it('should export createMockConnection function', () => {
    expect(typeof createMockConnection).toBe('function');
  });

  it('should create functional message builders', () => {
    const initMessage = MessageBuilders.initialize();
    expect(initMessage).toContain('"method":"initialize"');
    expect(initMessage).toContain('"jsonrpc":"2.0"');
    
    const toolsListMessage = MessageBuilders.toolsList();
    expect(toolsListMessage).toContain('"method":"tools/list"');
  });

  it('should create a functional mock connection', () => {
    const mock = createMockConnection();
    
    expect(mock.connection).toBeDefined();
    expect(mock.getSentMessages).toBeDefined();
    expect(mock.getLastMessage).toBeDefined();
    expect(mock.clearMessages).toBeDefined();
    
    // Test that it tracks messages
    mock.connection.send('test message');
    expect(mock.getSentMessages()).toHaveLength(1);
    expect(mock.getLastMessage()).toBe('test message');
    
    mock.clearMessages();
    expect(mock.getSentMessages()).toHaveLength(0);
  });
});
