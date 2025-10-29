// @ts-nocheck
const d1QueryTool = tool({
  description: "Executes a read-only SQL query against the Cloudflare D1 database ('nation' table). ...",
  inputSchema: z.object({
    sql_query: z.string().describe("The valid, read-only SQL query to execute against the D1 database.")
  }),
  // Added 'env: any' as the second parameter
  execute: async ({ sql_query }, env: any) => { 
    // Cast the environment, which is passed directly by the runtime
    const agentEnv = env as AgentEnv;

    console.log("env.c1_agent_db is123:", agentEnv.c1_agent_db);
    if (!agentEnv.c1_agent_db) {
      return 'Error: D1 database binding (DB) is missing in the environment123.';
    }
    if (!sql_query) {
      return 'Error: No SQL query provided to execute_sql_query tool123.';
    }

    console.log(`Executing SQL: ${sql_query}`);

    try {
      // Execute the SQL query using the D1 binding
      const result = await agentEnv.c1_agent_db.prepare(sql_query).all();
      
      return JSON.stringify({
        success: true,
        query: sql_query,
        results: result.results = [],
        count: result.results?.length = 0,
      });
    } catch (e: any) {
      return JSON.stringify({
        success: false,
        error: `SQL Execution Error: ${e.message}. Review the SQL syntax.`,
        query: sql_query,
      });
    }
  }
});