import { Agent, Connection, ConnectionContext, WSMessage } from "agents";

interface State {
  counter: number;
  lastUpdated: Date | null;
}

export class MyAgent extends Agent<Env, State> {
  initialState: State = {
    counter: 0,
    lastUpdated: null
  };

  async onStart() {
    console.log('Agent started with state:', this.state);
  }

  async onRequest(request: Request): Promise<Response> {
    return new Response("Hello from Agent!");
  }

  async onConnect(connection: Connection, ctx: ConnectionContext) {

  }

  async onMessage(connection: Connection, message: WSMessage) {
    connection.send("Received your message");
  }

  onStateUpdate(state: State, source: "server" | Connection) {
    console.log("State updated:", state, "Source:", source);
  }

}

// export default {}

export default {

	async fetch(request, env, ctx): Promise<Response> {
    console.log('got here');

    return new Response('fetch response');


	},
} satisfies ExportedHandler<Env>;
