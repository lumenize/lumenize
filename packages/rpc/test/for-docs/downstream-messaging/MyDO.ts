import { sendDownstream } from '../../../src';

export class MyDO {
  constructor(public ctx: DurableObjectState, public env: any) {}

  // Basic method for testing
  ping(): string {
    return 'pong';
  }

  // Send a downstream message to all clients
  async sendUpdate(message: string): Promise<void> {
    // Get all connected client IDs from WebSockets
    const connections = this.ctx.getWebSockets();
    const clientIds = [...new Set(connections.flatMap(ws => this.ctx.getTags(ws)))];
    if (clientIds.length > 0) {
      await sendDownstream(clientIds, this, { message });
    }
  }

  // Send to specific client
  async sendToClient(clientId: string, message: string): Promise<void> {
    await sendDownstream(clientId, this, { message });
  }
}

