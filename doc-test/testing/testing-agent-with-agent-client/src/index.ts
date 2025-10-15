import { Agent, routeAgentRequest, Connection, WSMessage } from "agents";

// Worker
export default {
  async fetch(request, env, ctx) {
    return (
      await routeAgentRequest(request, env) ||
      new Response("Not Found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;

interface ChatState {
  messages: Array<{ sender: string; text: string; }>;
  participants: string[];
}

// Agent
export class MyAgent extends Agent<Env, ChatState>{
  initialState = {
    messages: [],
    participants: [],
  };

  lastMessage: Date | null = null;

  onMessage(connection: Connection, message: WSMessage) {
    const msg = JSON.parse(message as string);

    if (msg.type === 'join') {
      // Add participant to state
      this.setState({
        ...this.state,
        participants: [...this.state.participants, msg.username],
      });
    } else if (msg.type === 'chat') {
      // Add chat message to state
      this.setState({
        ...this.state,
        messages: [...this.state.messages, { 
          sender: msg.username, 
          text: msg.text,
        }],
      });
    }
  }
};
