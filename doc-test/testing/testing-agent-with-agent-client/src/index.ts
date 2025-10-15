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
  messages: Array<{ sender: string; text: string; timestamp: number }>;
  participants: string[];
  settings: {
    allowAnonymous: boolean;
    maxHistoryLength: number;
  };
}

// Agent
export class MyAgent extends Agent<Env, ChatState>{
  initialState = {
    messages: [],
    participants: [],
    settings: {
      allowAnonymous: true,
      maxHistoryLength: 100,
    },
  };

  echo(value: any): any { return value; }

  onMessage(connection: Connection, message: WSMessage) {
    console.log('got here');
    connection.send("Received your message");
  }
  

};
